const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cheerio = require("cheerio");
const { analyzeStore, UnsupportedStoreError } = require("./shopify-spy");
const { sign, verify, parseCookies, serializeCookie } = require("./auth");
const { createPinnedFetch } = require("./safe-fetch");
const { handleCaktoWebhook } = require("./cakto");
const caktoApi = require("./caktoApi");
const db = require("./db");
const { TIERS, tierForActiveMembers } = require("./communityTiers");

const APP_BASE_URL = requireEnv("APP_BASE_URL");
const SESSION_SECRET = requireEnv("SESSION_SECRET");
// Revisão de segurança: o FastAPI (mega-minerador) confia cegamente nos
// headers X-User-Id/X-User-Is-Admin pra saber quem tá pedindo (não tem
// conexão com este banco de app_users — ver backend/app/api/deps.py). Até
// agora a única proteção era o serviço não ter domínio público — o que se
// mostrou frágil (bastou 1 comando de diagnóstico pra criar um domínio sem
// querer). Esse segredo compartilhado é a segunda camada: mesmo que o
// FastAPI volte a ficar acessível de fora por engano, ninguém de fora
// consegue forjar identidade sem conhecer ele também.
const INTERNAL_API_SECRET = requireEnv("INTERNAL_API_SECRET");
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias — ferramenta interna de time

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável de ambiente obrigatória não configurada: ${name}`);
    process.exit(1);
  }
  return value;
}

// Rede de segurança do processo inteiro (adicionada em 2026-08-25, depois
// de uma queda em produção): uma promise rejeitada sem ninguém pra pegar
// (ex: um "await db.algumaCoisa()" dentro de uma rota async, sem try/catch,
// que falha por um soluço de conexão com o Postgres) faz o Node encerrar o
// processo sozinho por padrão — derruba o app INTEIRO pra todo mundo, não
// só a rota que causou o erro. Não existia handler nenhum pra isso antes.
// Só loga e segue rodando; se um dia isso disparar muito, é sinal de algum
// await desprotegido em algum lugar (ver o que ele aponta), não motivo pra
// tirar esse catch-all.
process.on("unhandledRejection", (err) => {
  console.error("Erro não tratado (unhandledRejection), processo continua rodando:", err);
});

function normalizeShopifyProductUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error("URL inválida");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("URL inválida");
  }
  if (!/\/products\//.test(url.pathname)) {
    throw new Error("A URL não parece ser de um produto (esperado .../products/...)");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.json$/, "") + ".json";
  return url.toString();
}

// Reaproveitado pelas duas rotas que servem HTML real de concorrente num
// iframe: o proxy /api/products/:id/preview (FastAPI, produto salvo) e
// /api/spy-preview (Node, scrape na hora de Espionar Loja). Libera estilo/
// fonte/imagem de qualquer https (é onde a página do concorrente hospeda os
// dela); script continua bloqueado (o back já remove <script> antes de
// servir, e o iframe usa sandbox="" — script-src 'none' aqui é só mais uma
// camada).
function applyPreviewCsp(res) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self' https:",
      "script-src 'none'",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: https:",
      "font-src 'self' data: https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join("; ")
  );
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function previewErrorPage(targetUrl) {
  // escapeHtml aqui é defesa em profundidade (achado em auditoria): URL.toString()
  // já garante que aspas virem %22 e nunca quebrem o atributo href sozinhas,
  // mas escapar mesmo assim custa nada e fecha a brecha por completo, sem
  // depender de uma garantia de spec de outro objeto.
  return `<!doctype html>
<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font-family:sans-serif;color:#64748b;text-align:center;padding:16px;">
<p>Não foi possível carregar a página agora.<br>
<a href="${escapeHtml(targetUrl)}" target="_blank" style="color:#2563eb;">Abrir direto na loja ↗</a></p>
</body></html>`;
}

// Mesma ideia do preview_product_page do FastAPI (backend/app/api/products.py):
// busca a página REAL do concorrente no servidor e reserve a partir do NOSSO
// domínio, pra poder entrar num iframe (o Shopify bloqueia ser embutido por
// padrão via CSP frame-ancestors — como quem carrega no iframe é a NOSSA
// resposta, esse header deles nunca chega no navegador). <script> é removido
// inteiro (defesa contra XSS de terceiro dentro do nosso domínio) e qualquer
// <meta http-equiv="Content-Security-Policy"> deles também, senão o CSP
// deles (embutido no HTML, não só no header) barraria o próprio CSS/imagem
// que a gente está tentando deixar passar.
function sanitizePreviewHtml(html, hostname) {
  const $ = cheerio.load(html);
  $("script").remove();
  $('meta[http-equiv]').each((_, el) => {
    const value = ($(el).attr("http-equiv") || "").toLowerCase();
    if (value === "content-security-policy") $(el).remove();
  });
  if ($("head").length === 0) {
    $("html").prepend("<head></head>");
  }
  $("head").prepend(`<base href="https://${hostname}/">`);
  return $.html();
}

// Revisão de segurança: o bloqueio por CONTA (db.js:recordFailedLogin)
// protege contra "tentar várias senhas na MESMA conta", mas não contra
// "tentar 1 senha em VÁRIAS contas" (password spraying) — cada conta só
// vê 1 tentativa isolada, nunca bate o limite. Esse aqui é por IP,
// independente de qual email foi tentado. Em memória (não sobrevive a
// restart, não sincroniza entre múltiplas instâncias) — suficiente pro
// tamanho desse app hoje; se um dia escalar pra várias instâncias, precisa
// virar Redis.
const IP_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const IP_ATTEMPT_LIMIT = 15;
const IP_BLOCK_MS = 15 * 60 * 1000;
const ipLoginFailures = new Map();

function checkIpLoginLimit(ip) {
  const entry = ipLoginFailures.get(ip);
  if (entry && entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return { blocked: true, retryAfterMinutes: Math.ceil((entry.blockedUntil - Date.now()) / 60000) };
  }
  return { blocked: false };
}

function recordIpLoginFailure(ip) {
  const now = Date.now();
  let entry = ipLoginFailures.get(ip);
  if (!entry || now - entry.windowStart > IP_ATTEMPT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, blockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= IP_ATTEMPT_LIMIT) {
    entry.blockedUntil = now + IP_BLOCK_MS;
  }
  ipLoginFailures.set(ip, entry);
}

// Rate limit próprio (separado do de login) pra POST /registrar — sem
// isso, alguém poderia tentar um monte de emails em sequência só pra
// descobrir (pelas mensagens de erro diferentes) quais são clientes de
// verdade da Cakto. Mais generoso que o de login (não é senha sendo
// testada, é só "esse email existe"), mas ainda limita o volume.
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_LIMIT = 20;
const registerAttempts = new Map();

function checkRegisterRateLimit(ip) {
  const now = Date.now();
  let entry = registerAttempts.get(ip);
  if (!entry || now - entry.windowStart > REGISTER_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  registerAttempts.set(ip, entry);
  return entry.count > REGISTER_LIMIT;
}

function resetIpLoginFailures(ip) {
  ipLoginFailures.delete(ip);
}

// Limpeza periódica — sem isso o Map só cresce (1 entrada por IP que já
// tentou logar errado alguma vez).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipLoginFailures) {
    const stillBlocked = entry.blockedUntil && entry.blockedUntil > now;
    const windowActive = now - entry.windowStart <= IP_ATTEMPT_WINDOW_MS;
    if (!stillBlocked && !windowActive) ipLoginFailures.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// Revisão de segurança (achado em auditoria): Buscar Fornecedor, Espionar
// Loja e a prévia de Espionar Loja fazem o SERVIDOR buscar uma URL externa
// arbitrária (com proteção de SSRF em safe-fetch.js, mas sem NENHUM limite
// de volume) — sem isso, uma conta autenticada (não precisa ser admin)
// conseguia martelar essas rotas em alta frequência, usando o ScoutX como
// "proxy" de requisição contra qualquer host público (não é bypass da
// proteção de rede interna, é abuso de volume: sobrecarregar o alvo de
// terceiros, gastar CPU/banda daqui, ou até fazer o IP do Railway ser
// bloqueado pelo alvo). Por USUÁRIO (não por IP) — mesma rede corporativa
// (vários colegas atrás do mesmo IP) não deve se atrapalhar.
const FETCH_ROUTE_WINDOW_MS = 60 * 1000;
const FETCH_ROUTE_LIMIT = 20;
const fetchRouteUsage = new Map();

function checkFetchRouteLimit(userId) {
  const now = Date.now();
  const entry = fetchRouteUsage.get(userId);
  if (!entry || now - entry.windowStart > FETCH_ROUTE_WINDOW_MS) {
    fetchRouteUsage.set(userId, { count: 1, windowStart: now });
    return { blocked: false };
  }
  entry.count += 1;
  if (entry.count > FETCH_ROUTE_LIMIT) {
    return { blocked: true, retryAfterSeconds: Math.ceil((entry.windowStart + FETCH_ROUTE_WINDOW_MS - now) / 1000) };
  }
  return { blocked: false };
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of fetchRouteUsage) {
    if (now - entry.windowStart > FETCH_ROUTE_WINDOW_MS) fetchRouteUsage.delete(userId);
  }
}, 30 * 60 * 1000).unref();

// Revisão de segurança: checa a senha nova contra o banco público de senhas
// já vazadas (Have I Been Pwned, modelo k-Anonymity) — protege contra
// "credencial reusada", uma das formas mais comuns de conta ser invadida
// sem precisar quebrar nada, só reaproveitando senha que já vazou em OUTRO
// site. Manda só os 5 primeiros caracteres do hash SHA-1 pra API — a senha
// em si, e até o hash completo, nunca saem daqui. Falha ABERTA (não
// bloqueia troca de senha) se a API estiver fora do ar ou lenta: é
// ferramenta interna de time, não vale travar o acesso de alguém por causa
// de uma dependência externa instável.
//
// AJUSTADO (2026-08-25): bloquear em QUALQUER ocorrência (mesmo 1x, em
// qualquer vazamento antigo de qualquer site) rejeitava quase toda senha
// plausível — a base do HIBP tem 900M+ entradas, e senha decente comum
// (ex: "Scoutx2026!") já teve alguma chance de aparecer uma vez em algum
// dump antigo sem isso significar que ela é fraca. Só bloqueia agora se a
// contagem de ocorrências for alta (era usada MUITAS vezes por gente
// diferente — sinal real de senha fraca tipo "123456"/"password1"), não
// qualquer aparição isolada.
const PWNED_COUNT_THRESHOLD = 20;

async function isPasswordPwned(password) {
  const hash = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "User-Agent": "ScoutX-PasswordCheck" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const text = await response.text();
    const line = text.split("\n").find((l) => l.split(":")[0].trim() === suffix);
    if (!line) return false;
    const count = Number(line.split(":")[1]) || 0;
    return count >= PWNED_COUNT_THRESHOLD;
  } catch {
    return false;
  }
}

function extractDomain(raw) {
  try {
    return new URL(String(raw).trim()).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function looksLikeId(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return false;
  if (/\s/.test(v)) return false;
  if (/^-?\d{1,2}$/.test(v)) return false;
  return true;
}

function extractBarcode(payload) {
  const product = payload && payload.product;
  const variants = product && product.variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const productTitle = typeof product.title === "string" ? product.title : undefined;
  for (const v of variants) {
    if (looksLikeId(v.barcode)) return { value: v.barcode.trim(), source: "barcode", productTitle };
  }
  for (const v of variants) {
    if (looksLikeId(v.sku)) return { value: v.sku.trim(), source: "sku", productTitle };
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const SCOUTX_LOGO_DATA_URI = "data:image/png;base64,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";

function authPage({ title, subtitle, action, error, showNameField, confirmPassword }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScoutX</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, sans-serif; background: #05070d; color: #f3f4f6;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;
    position: relative; overflow: hidden;
  }
  /* Grade tipo radar/HUD no fundo, bem sutil (não compete com o formulário)
     — reforça a ideia de "monitorar" sem virar ruído visual. Deriva devagar
     pra dar sensação de algo vivo/ativo, não uma imagem estática. */
  body::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(rgba(59,130,246,0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(59,130,246,0.08) 1px, transparent 1px);
    background-size: 46px 46px;
    -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 40%, transparent 100%);
    mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 40%, transparent 100%);
    animation: grid-drift 40s linear infinite;
  }
  @keyframes grid-drift { from { background-position: 0 0; } to { background-position: 46px 46px; } }
  /* Dois glows (azul + ciano) em cantos opostos — mais profundidade que um só. */
  body::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(circle at 12% 8%, rgba(59,130,246,0.35) 0%, transparent 42%),
      radial-gradient(circle at 88% 92%, rgba(34,211,238,0.22) 0%, transparent 40%);
  }
  .card {
    position: relative; z-index: 1;
    background: linear-gradient(180deg, rgba(18,20,30,0.88), rgba(10,12,20,0.92));
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(96,165,250,0.18);
    padding: 34px 32px; border-radius: 20px; width: 348px; max-width: calc(100vw - 32px);
    box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02) inset;
    overflow: hidden;
  }
  @media (max-width: 420px) {
    .card { padding: 26px 20px; }
  }
  /* Linha de "scan" cruzando o topo do card ao carregar — reforço temático
     leve (é uma ferramenta de vigilância de concorrentes), não decoração à
     toa. */
  .card::before {
    content: ""; position: absolute; top: 0; left: -30%; width: 30%; height: 2px;
    background: linear-gradient(90deg, transparent, #60a5fa, #22d3ee, transparent);
    animation: scan 2.8s ease-in-out infinite;
  }
  @keyframes scan { 0% { left: -30%; } 100% { left: 100%; } }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 26px; }
  .brand img {
    width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; object-fit: cover;
    box-shadow: 0 0 0 1px rgba(96,165,250,0.3), 0 6px 18px rgba(37,99,235,0.35);
  }
  .brand span { font-weight: 700; font-size: 17px; letter-spacing: 0.2px; }
  h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: -0.2px; }
  p.subtitle { color: #9ca3af; font-size: 13px; margin: 0 0 24px; }
  label {
    display: block; font-size: 11px; font-weight: 600; color: #93c5fd; margin: 0 0 6px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  input {
    width: 100%; padding: 11px 13px; margin-bottom: 16px; border-radius: 10px;
    border: 1px solid rgba(96,165,250,0.16); background: rgba(5,7,13,0.7); color: #f3f4f6; font-size: 14px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus {
    outline: none; border-color: #22d3ee; box-shadow: 0 0 0 3px rgba(34,211,238,0.18);
  }
  button {
    width: 100%; padding: 13px; border-radius: 9999px; border: none;
    background: linear-gradient(90deg, #1d4ed8 0%, #3b82f6 50%, #22d3ee 100%);
    background-size: 200% 100%;
    color: #fff; font-weight: 600; font-size: 14px;
    cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 8px 28px rgba(59,130,246,0.4);
    transition: filter 0.15s, box-shadow 0.15s, background-position 0.4s;
  }
  button:hover {
    filter: brightness(1.08); background-position: 100% 0;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 10px 34px rgba(34,211,238,0.5);
  }
  .error {
    background: rgba(127,29,29,0.25); color: #f87171; border: 1px solid #7f1d1d;
    padding: 9px 11px; border-radius: 8px; font-size: 13px; margin-bottom: 16px;
  }
  .field-error {
    color: #f87171; font-size: 12px; margin: -12px 0 12px; display: none;
  }
  /* Campo de senha com o botão de olho por dentro do input, à direita —
     padding-right no input abre espaço pro botão sem sobrepor o texto.
     PEGADINHA: <input> é inline-block, então a margin-bottom dele NÃO
     colapsa com o .pw-field (isso só vale pra elementos block) — ela conta
     pra altura do .pw-field igual o resto. Por isso "bottom: 0" no botão
     ficava 16px alto demais (cobrindo a margin junto), centralizando o
     ícone uns 8px abaixo do centro visual real do input. "bottom: 16px"
     (mesmo valor da margin-bottom do input) corta essa sobra fora e faz o
     botão bater exatamente na caixa visível do input, ponta a ponta. */
  .pw-field { position: relative; }
  .pw-field input { padding-right: 44px; }
  /* Edge (Windows) e alguns Chrome/Safari põem o PRÓPRIO ícone de "revelar
     senha" nativo dentro do input — some por cima do nosso, os dois juntos
     ficam tortos/sobrepostos. Escondendo o nativo, só o nosso aparece. */
  .pw-field input::-ms-reveal,
  .pw-field input::-ms-clear { display: none; }
  .pw-field input::-webkit-credentials-auto-fill-button,
  .pw-field input::-webkit-strong-password-auto-fill-button { display: none !important; visibility: hidden; }
  .pw-toggle {
    all: unset; position: absolute; top: 0; right: 3px; bottom: 16px; width: 36px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: #9ca3af; border-radius: 8px; line-height: 0;
  }
  .pw-toggle:hover { color: #e5e7eb; background: rgba(255,255,255,0.06); }
  .pw-toggle svg { display: block; width: 19px; height: 19px; }
  .pw-toggle .eye-off { display: none; }
  .pw-toggle.is-visible .eye { display: none; }
  .pw-toggle.is-visible .eye-off { display: block; }
</style></head>
<body>
<div class="card">
  <div class="brand"><img src="${SCOUTX_LOGO_DATA_URI}" alt="ScoutX"><span>ScoutX</span></div>
  <form method="POST" action="${action}" ${confirmPassword ? 'id="auth-form"' : ""}>
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    ${showNameField ? `<label for="name">Nome</label><input type="text" id="name" name="name" required autofocus maxlength="80">` : ""}
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required ${showNameField ? "" : "autofocus"} maxlength="200">
    <label for="password">Senha</label>
    <div class="pw-field">
      <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
      ${pwToggleButton("password")}
    </div>
    ${
      confirmPassword
        ? `<label for="confirmPassword">Confirmar senha</label>
    <div class="pw-field">
      <input type="password" id="confirmPassword" name="confirmPassword" required minlength="8" autocomplete="new-password">
      ${pwToggleButton("confirmPassword")}
    </div>
    <p class="field-error" id="confirmPassword-error">As senhas digitadas não são iguais.</p>`
        : ""
    }
    <button type="submit">${showNameField ? "Criar conta de administrador" : confirmPassword ? "Criar minha senha" : "Entrar"}</button>
  </form>
</div>
<script src="/auth.js"></script>
</body></html>`;
}

function pwToggleButton(targetId) {
  return `<button type="button" class="pw-toggle" data-target="${targetId}" aria-label="Mostrar senha" title="Mostrar senha">
  <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a20.5 20.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
</button>`;
}

const AUTH_PAGE_SCRIPT = `
document.querySelectorAll(".pw-toggle").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var input = document.getElementById(btn.dataset.target);
    if (!input) return;
    var showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.classList.toggle("is-visible", !showing);
    btn.title = showing ? "Mostrar senha" : "Ocultar senha";
    btn.setAttribute("aria-label", btn.title);
  });
});
var form = document.getElementById("auth-form");
if (form) {
  form.addEventListener("submit", function (e) {
    var pw = document.getElementById("password");
    var confirm = document.getElementById("confirmPassword");
    var err = document.getElementById("confirmPassword-error");
    if (pw && confirm && pw.value !== confirm.value) {
      e.preventDefault();
      err.style.display = "block";
      confirm.focus();
    } else if (err) {
      err.style.display = "none";
    }
  });
}
`;

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Script das telas de login/setup/registrar (mostrar/ocultar senha,
  // conferir "senha == confirmar senha" antes de enviar). Precisa ser um
  // arquivo à parte por causa do CSP (script-src 'self', sem 'unsafe-inline'
  // — um <script> inline no meio do HTML seria bloqueado pelo navegador).
  app.get("/auth.js", (req, res) => {
    res.type("application/javascript").send(AUTH_PAGE_SCRIPT);
  });

  // Revisão de segurança: nenhum header de proteção do navegador vinha
  // configurado antes (achado no teste de invasão) — sem eles o app fica
  // mais exposto a clickjacking (carregar o ScoutX escondido dentro de um
  // iframe de outro site) e a downgrade de HTTPS. CSP liberado o suficiente
  // pra não quebrar nada: imagem de produto/favicon vem de domínio de
  // concorrente (arbitrário) e do Google, por isso img-src aceita qualquer
  // https; o resto (script, estilo do bundle, conexão de API) é tudo
  // same-origin, só a tela de login/setup tem <style> inline mesmo.
  // SAMEORIGIN/'self' (não DENY/'none'): o próprio ScoutX se auto-embeda num
  // iframe (QuickPreview, "👁 Ver" em Produtos, carrega /api/minerador/api/
  // products/:id/preview) — DENY/'none' bloqueava ISSO também, quebrando a
  // prévia com "conexão recusada" (regressão achada pelo usuário). Continua
  // bloqueando qualquer OUTRO site de nos enquadrar, que era o objetivo real.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
    next();
  });

  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  });

  const isHttps = APP_BASE_URL.startsWith("https://");

  // tokenVersion vai dentro do cookie — requireAuth confere contra
  // app_users.token_version a cada requisição (ver migrate() em db.js).
  // Trocar a senha incrementa esse número no banco, invalidando na hora
  // qualquer cookie assinado com a versão antiga, mesmo com prazo válido.
  function setSessionCookie(res, appUserId, tokenVersion) {
    const session = sign(
      { appUserId, tokenVersion, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
      SESSION_SECRET
    );
    res.setHeader("Set-Cookie", serializeCookie("session", session, { maxAge: SESSION_TTL_SECONDS, secure: isHttps }));
  }

  // ---------- Setup inicial (cria o primeiro admin, só funciona se não houver ninguém ainda) ----------

  app.get("/setup", async (req, res) => {
    const n = await db.countUsers();
    if (n > 0) return res.redirect("/login");
    res.send(
      authPage({
        title: "Criar conta de administrador",
        subtitle: "Primeira vez usando essa ferramenta, crie a conta principal.",
        action: "/setup",
        showNameField: true,
      })
    );
  });

  app.post("/setup", async (req, res) => {
    const n = await db.countUsers();
    if (n > 0) return res.redirect("/login");

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 8) {
      return res.status(400).send(
        authPage({
          title: "Criar conta de administrador",
          subtitle: "Primeira vez usando essa ferramenta, crie a conta principal.",
          action: "/setup",
          showNameField: true,
          error: "Preencha nome, email e uma senha com pelo menos 8 caracteres.",
        })
      );
    }
    if (await isPasswordPwned(password)) {
      return res.status(400).send(
        authPage({
          title: "Criar conta de administrador",
          subtitle: "Primeira vez usando essa ferramenta, crie a conta principal.",
          action: "/setup",
          showNameField: true,
          error: "Essa senha já apareceu em vazamentos conhecidos, escolha outra.",
        })
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ name, email, passwordHash, role: "admin" });
    db.logLogin(user.id, req.ip).catch((e) => console.error("log login:", e));
    setSessionCookie(res, user.id, user.token_version);
    res.redirect("/");
  });

  // ---------- Login ----------

  app.get("/login", async (req, res) => {
    const n = await db.countUsers();
    if (n === 0) return res.redirect("/setup");
    res.send(authPage({ title: "ScoutX", subtitle: "Entre com seu email e senha.", action: "/login" }));
  });

  // ---------- Automação Cakto ----------
  // Webhook server-to-server: SEM requireAuth (a Cakto não tem sessão
  // nossa), autenticado só pelo "secret" dentro do corpo (ver cakto.js:
  // isValidSecret). Nunca retorna detalhe do motivo de falha pro chamador
  // além do status HTTP, pra não dar pista útil a alguém tentando forjar
  // uma compra.
  // Blindagem extra (defesa em profundidade): mesmo handleCaktoWebhook já
  // tratando seus próprios erros internamente, qualquer coisa inesperada
  // que escape ainda vira uma promise rejeitada sem dono nessa rota async
  // — e isso derruba o processo Node inteiro (não tem handler global de
  // unhandledRejection configurado), tirando o app inteiro do ar, não só a
  // automação Cakto (foi exatamente isso que aconteceu em produção em
  // 2026-08-25, ver cakto.js). Todo handler async novo que mexe com banco
  // deveria ter esse try/catch.
  app.post("/api/webhooks/cakto", async (req, res) => {
    try {
      const { status, body } = await handleCaktoWebhook(req.body);
      res.status(status).json(body);
    } catch (err) {
      console.error("Webhook Cakto: erro inesperado não tratado:", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  // Página pública (sem login) que a Cakto abre depois do pagamento
  // aprovado (URL fixa configurada no painel dela, SEM parâmetro nenhum —
  // diferente da tentativa anterior com ?ref=<refId>, que dependia de um
  // valor da Cakto bater exatamente com o que o webhook recebeu, e no teste
  // real não bateu, ver HANDOFF.md). Aqui a pessoa PROVA que é dona da
  // compra digitando o mesmo email usado na Cakto, e escolhe a própria
  // senha — sem depender de nenhuma correlação frágil entre redirect e
  // webhook.
  const REGISTER_SUBTITLE = "Já confirmamos seu pagamento. Digite o email que você usou na compra e escolha sua senha.";

  app.get("/registrar", (req, res) => {
    res.send(authPage({ title: "Criar sua senha", subtitle: REGISTER_SUBTITLE, action: "/registrar", confirmPassword: true }));
  });

  app.post("/registrar", async (req, res) => {
    const email = String(req.body.email || "").trim();
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    const rerender = (status, error) =>
      res
        .status(status)
        .send(authPage({ title: "Criar sua senha", subtitle: REGISTER_SUBTITLE, action: "/registrar", confirmPassword: true, error }));

    if (checkRegisterRateLimit(req.ip)) {
      return rerender(429, "Muitas tentativas vindas daqui, tenta de novo daqui a pouco.");
    }
    if (!email) return rerender(400, "Digite o email que você usou na compra.");
    if (password.length < 8) return rerender(400, "A senha precisa ter no mínimo 8 caracteres.");
    if (password !== confirmPassword) return rerender(400, "As senhas digitadas não são iguais.");

    try {
      const user = await db.findUserByEmail(email);
      if (!user) {
        return rerender(404, "Não encontramos uma compra pendente pra esse email. Confira se digitou certo, ou fale com o suporte.");
      }
      if (!user.needs_password_setup) {
        return rerender(400, "Essa conta já tem senha definida. Faça login normal, ou use \"Esqueci minha senha\" se precisar trocar.");
      }
      if (await isPasswordPwned(password)) {
        return rerender(400, "Essa senha já apareceu em vazamentos conhecidos, escolha outra.");
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const updated = await db.completePasswordSetup(user.id, passwordHash);
      db.logLogin(user.id, req.ip).catch((e) => console.error("log login:", e));
      setSessionCookie(res, user.id, updated.token_version);
      res.redirect("/");
    } catch (err) {
      console.error("Erro inesperado em POST /registrar:", err);
      rerender(500, "Erro inesperado, tenta de novo em instantes.");
    }
  });

  // Minutos arredondados pra cima — "bloqueado por 4 minutos" é melhor que
  // "3.2 minutos" (a pessoa não vai cronometrar o segundo exato mesmo).
  function minutesLeft(lockedUntil) {
    return Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
  }

  const PERMANENT_LOCK_MESSAGE = "Conta bloqueada por excesso de tentativas, peça pra um administrador redefinir sua senha (aba Usuários → 🔑 Senha).";

  app.post("/login", async (req, res) => {
    const email = String(req.body.email || "").trim();
    const password = String(req.body.password || "");

    const ipLimit = checkIpLoginLimit(req.ip);
    if (ipLimit.blocked) {
      return res.status(429).send(
        authPage({
          title: "ScoutX",
          subtitle: "Entre com seu email e senha.",
          action: "/login",
          error: `Muitas tentativas de login vindas daqui, tenta de novo em ${ipLimit.retryAfterMinutes} min.`,
        })
      );
    }

    const user = await db.findUserByEmail(email);

    // Bloqueio ativo: nem chega a checar a senha — não consome tentativa
    // nova (senão as "2 tentativas a mais"/"1 tentativa a mais" prometidas
    // pro usuário nunca sobrariam) e não dá pra "esperar" tentando de novo.
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      const permanent = new Date(user.locked_until).getUTCFullYear() >= 9000;
      const error = permanent
        ? PERMANENT_LOCK_MESSAGE
        : `Muitas tentativas erradas, tenta de novo em ${minutesLeft(user.locked_until)} min.`;
      return res.status(423).send(
        authPage({ title: "ScoutX", subtitle: "Entre com seu email e senha.", action: "/login", error })
      );
    }

    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !valid) {
      recordIpLoginFailure(req.ip);
      let error = "Email ou senha inválidos.";
      if (user) {
        const { lockedUntil, permanent } = await db.recordFailedLogin(user.id);
        if (permanent) error = PERMANENT_LOCK_MESSAGE;
        else if (lockedUntil) error = `Muitas tentativas erradas, conta bloqueada por ${minutesLeft(lockedUntil)} min.`;
      }
      return res.status(401).send(
        authPage({ title: "ScoutX", subtitle: "Entre com seu email e senha.", action: "/login", error })
      );
    }

    // Senha certa mas conta suspensa por um admin — checado DEPOIS da senha
    // (não antes) pra não vazar "essa conta existe e está suspensa" pra
    // quem só está tentando senhas ao acaso.
    if (user.suspended) {
      return res.status(403).send(
        authPage({
          title: "ScoutX",
          subtitle: "Entre com seu email e senha.",
          action: "/login",
          error: "Sua conta foi suspensa por um administrador.",
        })
      );
    }

    // Plano da organização vencido — bloqueia até renovar. Diferente da
    // suspensão (ação explícita, mata sessão na hora via token_version),
    // vencimento é por TEMPO — precisa ser checado aqui E em todo request
    // autenticado (requireAuth), não só no login.
    if (user.org_expires_at && new Date(user.org_expires_at) < new Date()) {
      return res.status(403).send(
        authPage({
          title: "ScoutX",
          subtitle: "Entre com seu email e senha.",
          action: "/login",
          error: "O plano da sua organização venceu, fale com um administrador pra renovar.",
        })
      );
    }

    resetIpLoginFailures(req.ip);
    await db.resetFailedLogins(user.id);
    db.logLogin(user.id, req.ip).catch((e) => console.error("log login:", e));
    setSessionCookie(res, user.id, user.token_version);
    res.redirect("/");
  });

  app.get("/logout", (req, res) => {
    res.setHeader("Set-Cookie", serializeCookie("session", "", { maxAge: 0, secure: isHttps }));
    res.redirect("/login");
  });

  async function requireAuth(req, res, next) {
    const n = await db.countUsers();
    if (n === 0 && req.path !== "/setup") return res.redirect("/setup");

    const session = verify(req.cookies.session, SESSION_SECRET);
    if (!session) {
      if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Sessão expirada, faça login de novo." });
      }
      return res.redirect("/login");
    }

    const appUser = await db.getAppUserById(session.appUserId);
    if (!appUser) {
      res.setHeader("Set-Cookie", serializeCookie("session", "", { maxAge: 0, secure: isHttps }));
      return res.redirect("/login");
    }

    // Sessão emitida ANTES da última troca de senha (versão presa no cookie
    // não bate mais com o banco) — trata igual sessão expirada, mesmo com
    // assinatura válida e prazo não vencido. Cookie antigo (sem
    // tokenVersion, de antes dessa revisão) sempre falha aqui de propósito
    // — força relogar 1 vez só, depois já sai sempre certo.
    if (session.tokenVersion !== appUser.token_version) {
      res.setHeader("Set-Cookie", serializeCookie("session", "", { maxAge: 0, secure: isHttps }));
      if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Sessão expirada, faça login de novo." });
      }
      return res.redirect("/login");
    }

    // Plano vencido depois do login já ter acontecido (a validade passou
    // enquanto a sessão de 30 dias ainda estava ativa) — sem isso a pessoa
    // continuaria usando o app normalmente até o cookie expirar sozinho.
    if (appUser.org_expires_at && new Date(appUser.org_expires_at) < new Date()) {
      res.setHeader("Set-Cookie", serializeCookie("session", "", { maxAge: 0, secure: isHttps }));
      if (req.path.startsWith("/api/")) {
        return res.status(403).json({ error: "O plano da sua organização venceu, fale com um administrador pra renovar." });
      }
      return res.redirect("/login");
    }

    req.appUser = appUser;

    // "Última vez visto" (pedido do admin, 2026-08-31) — só escreve se
    // fizer mais de 5 minutos desde o valor já carregado (sem isso seria 1
    // UPDATE por requisição, e uma página só já dispara dezenas). Fire-and-
    // forget: nunca atrasa nem derruba a requisição de verdade da pessoa.
    const lastSeen = appUser.last_seen_at ? new Date(appUser.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeen > 5 * 60 * 1000) {
      db.touchLastSeen(appUser.id).catch((err) => console.error("Falha ao atualizar last_seen_at:", err.message));
    }

    next();
  }

  app.use(requireAuth);

  // ---------- Identidade / permissões pro frontend ----------

  app.get("/api/me", (req, res) => {
    res.json({
      name: req.appUser.name,
      email: req.appUser.email,
      role: req.appUser.role,
      isAdmin: req.appUser.role === "admin",
      canAccessMinerador: req.appUser.role === "admin" || req.appUser.can_access_minerador,
      // Admin (dono da plataforma) não tem organização/plano — planLabel
      // fica null e o front mostra um selo diferente (ver Layout.jsx).
      planLabel: req.appUser.org_plan ? db.planLimitsFor(req.appUser.org_plan).label : null,
      // Chave interna (solo/pro/agencia), não só o nome de venda — o front
      // usa isso pra travar feature de plano (Discord, histórico de Alertas)
      // sem depender do texto do label, que pode mudar num rebrand.
      plan: req.appUser.org_plan || null,
      organizationName: req.appUser.org_name || null,
      planExpiresAt: req.appUser.org_expires_at || null,
      avatarUrl: req.appUser.avatar_url || null,
      // País que ESSA ORGANIZAÇÃO escolheu na primeira vez que alguém dela
      // abriu o app — null = ainda nunca escolheu (front mostra o seletor
      // inicial). Guardado no banco (não só no navegador) pra funcionar em
      // qualquer dispositivo, ver OperationContext.jsx e
      // PATCH /api/me/default-operation logo abaixo.
      defaultOperation: req.appUser.org_default_operation || null,
    });
  });

  // Grava o país da organização na PRIMEIRA vez (ver
  // db.setOrgDefaultOperationIfUnset — chamadas depois de já setado não
  // mudam nada, é assim de propósito: essa é a escolha "pra sempre" da
  // conta). Sem requireAdmin de propósito: é o próprio colaborador
  // escolhendo, na primeira vez que abre o app — mas continua exigindo
  // sessão válida (requireAuth já roda pra tudo que vem depois dele, ver
  // app.use(requireAuth) acima).
  //
  // force=true (achado ao vivo, 2026-08-26): exceção deliberada à regra
  // acima — só usada quando a pessoa EXCLUI (ver DELETE de país no
  // OperationContext.jsx) justo o país que era esse padrão. Sem essa
  // saída, o valor excluído "ressuscitava" sozinho no próximo refresh ou
  // dispositivo novo, porque esse endpoint recusava sobrescrever um valor
  // já setado. value pode vir null com force=true (limpa de vez, quando a
  // conta excluiu TODOS os países que tinha).
  app.patch("/api/me/default-operation", async (req, res) => {
    if (!req.appUser.organization_id) {
      return res.status(400).json({ error: "Essa conta não tem organização." });
    }
    const { value, force } = req.body || {};
    if (force === true) {
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({ error: "value precisa ser string ou null." });
      }
      const org = await db.setOrgDefaultOperation(req.appUser.organization_id, value);
      return res.json({ defaultOperation: org.default_operation });
    }
    if (!value || typeof value !== "string") {
      return res.status(400).json({ error: "value é obrigatório." });
    }
    const org = await db.setOrgDefaultOperationIfUnset(req.appUser.organization_id, value);
    res.json({ defaultOperation: org.default_operation });
  });

  // Teto generoso de propósito: a foto já chega redimensionada (~256px,
  // JPEG) pelo navegador antes de subir (ver Conta.jsx), então uma foto
  // normal fica bem abaixo disso — esse limite é só uma rede de segurança
  // contra alguém mandar um data URI gigante direto pra API sem passar pelo
  // redimensionamento do front.
  const MAX_AVATAR_LENGTH = 2_000_000;

  app.patch("/api/me/avatar", async (req, res) => {
    const { avatarDataUrl } = req.body || {};
    if (typeof avatarDataUrl !== "string" || !avatarDataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Envie uma imagem válida." });
    }
    if (avatarDataUrl.length > MAX_AVATAR_LENGTH) {
      return res.status(400).json({ error: "Essa imagem ficou grande demais, tenta uma foto menor." });
    }
    const avatarUrl = await db.updateUserAvatar(req.appUser.id, avatarDataUrl);
    res.json({ avatarUrl });
  });

  app.delete("/api/me/avatar", async (req, res) => {
    await db.updateUserAvatar(req.appUser.id, null);
    res.json({ avatarUrl: null });
  });

  // Autoatendimento — a pessoa troca o próprio nome de exibição (pedido do
  // usuário, 2026-08-31). Só o nome mostrado no app; não mexe em email nem
  // em nada usado pra login.
  app.patch("/api/me/name", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "O nome não pode ficar em branco." });
    }
    if (name.length > 120) {
      return res.status(400).json({ error: "Esse nome ficou grande demais." });
    }
    const updated = await db.updateUserName(req.appUser.id, name);
    res.json({ name: updated });
  });

  // Autoatendimento — troca a PRÓPRIA senha (exige a senha atual, diferente
  // do reset de admin em /api/admin/users/:id que não pede, já que é o
  // próprio dono da conta confirmando que é ele mesmo).
  app.patch("/api/me/password", async (req, res) => {
    // Mesmo limite por IP do login — sem isso, alguém com uma sessão
    // roubada (cookie sem saber a senha) podia tentar "senha atual"
    // ilimitadamente até acertar, sem nenhum bloqueio.
    const ipLimit = checkIpLoginLimit(req.ip);
    if (ipLimit.blocked) {
      return res
        .status(429)
        .json({ error: `Muitas tentativas vindas daqui, tenta de novo em ${ipLimit.retryAfterMinutes} min.` });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Informe a senha atual e a nova senha." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "A nova senha precisa ter no mínimo 8 caracteres." });
    }
    const valid = await bcrypt.compare(currentPassword, req.appUser.password_hash);
    if (!valid) {
      recordIpLoginFailure(req.ip);
      return res.status(401).json({ error: "Senha atual incorreta." });
    }
    if (await isPasswordPwned(newPassword)) {
      return res.status(400).json({ error: "Essa senha já apareceu em vazamentos conhecidos, escolha outra." });
    }
    resetIpLoginFailures(req.ip);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const newTokenVersion = await db.updateUserPassword(req.appUser.id, passwordHash);
    // Troca de senha invalida QUALQUER sessão aberta em outro lugar (ver
    // requireAuth) — inclusive essa aqui, se não reemitir o cookie com a
    // versão nova. Sem isso a pessoa seria deslogada na hora seguinte à
    // troca bem-sucedida da própria senha dela.
    setSessionCookie(res, req.appUser.id, newTokenVersion);
    res.json({ ok: true });
  });

  // ---------- Administração de usuários (admin only) ----------

  function requireAdmin(req, res, next) {
    if (req.appUser.role !== "admin") return res.status(403).json({ error: "Só administradores podem acessar isso." });
    next();
  }

  // Diagnóstico temporário (2026-08-31) — confirma que a autenticação com a
  // API da Cakto funciona de verdade e mostra o formato real de um pedido
  // (commissionedUsers/commissions), já que não deu pra testar isso fora do
  // servidor (CORS bloqueia do navegador, e a rede local não alcança a API
  // deles). Só devolve o pedido mais recente — não expõe token nenhum.
  app.get("/api/admin/cakto-test", requireAdmin, async (req, res) => {
    try {
      const orders = await caktoApi.listOrders({ limit: 1, ordering: "-paidAt" });
      res.json(orders);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Programa de afiliados (admin only) ----------

  app.get("/api/admin/affiliates", requireAdmin, async (req, res) => {
    res.json(await db.listAffiliates());
  });

  app.post("/api/admin/affiliates", requireAdmin, async (req, res) => {
    const { name, caktoEmail, pixKey, firstSalePercentage, recurringPercentage } = req.body || {};
    if (!name?.trim() || !caktoEmail?.trim()) {
      return res.status(400).json({ error: "Nome e email da Cakto são obrigatórios." });
    }
    const firstPct = Number(firstSalePercentage);
    const recurPct = Number(recurringPercentage);
    if (!Number.isFinite(firstPct) || firstPct < 0 || firstPct > 100 || !Number.isFinite(recurPct) || recurPct < 0 || recurPct > 100) {
      return res.status(400).json({ error: "Percentuais precisam ser números entre 0 e 100." });
    }
    try {
      const affiliate = await db.createAffiliate({
        name: name.trim(),
        caktoEmail: caktoEmail.trim(),
        pixKey: pixKey?.trim() || null,
        firstSalePercentage: firstPct,
        recurringPercentage: recurPct,
      });
      res.status(201).json(affiliate);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Já existe um afiliado com esse email da Cakto." });
      }
      throw err;
    }
  });

  app.delete("/api/admin/affiliates/:id", requireAdmin, async (req, res) => {
    await db.deleteAffiliate(Number(req.params.id));
    res.status(204).end();
  });

  app.get("/api/admin/affiliate-commissions", requireAdmin, async (req, res) => {
    res.json(await db.listAffiliateCommissions());
  });

  app.patch("/api/admin/affiliate-commissions/:id", requireAdmin, async (req, res) => {
    const updated = await db.markAffiliateCommissionPaid(Number(req.params.id), !!req.body?.paid);
    if (!updated) return res.status(404).json({ error: "Comissão não encontrada." });
    res.json(updated);
  });

  // ---------- Indicação (cliente indica cliente) ----------
  // Diferente do programa de afiliados acima (cadastro manual pelo admin):
  // aqui é o próprio cliente logado que pede o cupom pela aba "Indicação" —
  // ver frontend/src/pages/Indicacao.jsx. Qualquer usuário logado pode
  // acessar (não é feature de plano), igual Suporte/Minha Conta.

  app.get("/api/referral/me", async (req, res) => {
    const coupon = await db.getReferralCouponByUserId(req.appUser.id);
    const commissions = coupon ? await db.listReferralCommissionsByUserId(req.appUser.id) : [];
    res.json({ coupon, commissions });
  });

  app.post("/api/referral/request", async (req, res) => {
    const pixKey = typeof req.body?.pixKey === "string" ? req.body.pixKey.trim() : "";
    const whatsapp = typeof req.body?.whatsapp === "string" ? req.body.whatsapp.trim() : "";
    if (!whatsapp) {
      return res.status(400).json({ error: "WhatsApp é obrigatório pra gente conseguir avisar quando o cupom ficar pronto." });
    }
    if (!pixKey) {
      return res.status(400).json({ error: "Chave PIX é obrigatória pra gente conseguir pagar sua comissão." });
    }
    const coupon = await db.createReferralCouponRequest(req.appUser.id, pixKey, whatsapp);
    res.status(201).json(coupon);
  });

  app.patch("/api/referral/pix", async (req, res) => {
    const pixKey = typeof req.body?.pixKey === "string" ? req.body.pixKey.trim() : "";
    if (!pixKey) return res.status(400).json({ error: "Chave PIX é obrigatória." });
    const updated = await db.updateReferralCouponPix(req.appUser.id, pixKey);
    if (!updated) return res.status(404).json({ error: "Você ainda não solicitou um cupom de indicação." });
    res.json(updated);
  });

  app.patch("/api/referral/whatsapp", async (req, res) => {
    const whatsapp = typeof req.body?.whatsapp === "string" ? req.body.whatsapp.trim() : "";
    if (!whatsapp) return res.status(400).json({ error: "WhatsApp é obrigatório." });
    const updated = await db.updateReferralCouponWhatsapp(req.appUser.id, whatsapp);
    if (!updated) return res.status(404).json({ error: "Você ainda não solicitou um cupom de indicação." });
    res.json(updated);
  });

  // ---------- Indicação (admin only) ----------

  app.get("/api/admin/referrals", requireAdmin, async (req, res) => {
    res.json(await db.listReferralCoupons());
  });

  app.post("/api/admin/referrals/:id/activate", requireAdmin, async (req, res) => {
    const couponCode = String(req.body?.couponCode || "").trim();
    if (!couponCode) return res.status(400).json({ error: "Código do cupom é obrigatório." });
    try {
      const updated = await db.activateReferralCoupon(Number(req.params.id), couponCode);
      if (!updated) return res.status(404).json({ error: "Pedido de cupom não encontrado." });
      res.json(updated);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Esse código de cupom já está em uso por outra indicação." });
      }
      throw err;
    }
  });

  app.get("/api/admin/referral-commissions", requireAdmin, async (req, res) => {
    res.json(await db.listReferralCommissions());
  });

  app.patch("/api/admin/referral-commissions/:id", requireAdmin, async (req, res) => {
    const updated = await db.markReferralCommissionPaid(Number(req.params.id), !!req.body?.paid);
    if (!updated) return res.status(404).json({ error: "Comissão não encontrada." });
    res.json(updated);
  });

  // ---------- Comunidade de embaixadores ----------
  // Extensão do programa de afiliados: quem já é afiliado (identificado
  // comparando o email da sessão com affiliates.cakto_email, mesmo truque
  // que o webhook da Cakto já usa em cakto.js) pode virar dono de uma
  // comunidade fechada. Qualquer usuário logado pode acessar essas rotas —
  // o que cada um enxerga/pode fazer é decidido dentro do handler, não por
  // um gate de permissão de plano.

  const MAX_COMMUNITY_IMAGE_LENGTH = 4_000_000; // ~4MB de data URI, folga maior que avatar (post de conteúdo, não miniatura)

  async function getMyAmbassadorContext(req) {
    const affiliate = await db.findAffiliateByCaktoEmail(req.appUser.email);
    if (!affiliate) return { affiliate: null, community: null };
    const community = await db.getCommunityByAffiliateId(affiliate.id);
    return { affiliate, community };
  }

  // Devolve o "estado" da pessoa em relação à Comunidade: embaixadora (com
  // ou sem comunidade criada ainda), membro de uma comunidade, ou nenhum
  // dos dois (pode navegar o diretório pra participar de alguma).
  app.get("/api/community/status", async (req, res) => {
    const { affiliate, community } = await getMyAmbassadorContext(req);
    let ambassadorStats = null;
    if (community) {
      const activeMemberCount = await db.countActiveCommunityMembers(community.id);
      const tier = tierForActiveMembers(activeMemberCount);
      ambassadorStats = { activeMemberCount, tier: tier.name, tierLabel: tier.label, tierPercentage: tier.percentage };
    }
    const membership = req.appUser.organization_id
      ? await db.getCommunityMembershipByOrgId(req.appUser.organization_id)
      : null;
    res.json({
      isAmbassador: !!affiliate,
      ambassadorCommunity: community,
      ambassadorStats,
      memberCommunityId: membership?.community_id || null,
      tiers: TIERS.map((t) => ({ name: t.name, label: t.label, max: Number.isFinite(t.max) ? t.max : null, percentage: t.percentage })),
    });
  });

  // Embaixador cria a comunidade dele (nome + foto opcional) — só uma vez,
  // ON CONFLICT DO NOTHING no banco garante isso mesmo em corrida.
  app.post("/api/community/setup", async (req, res) => {
    const { affiliate, community } = await getMyAmbassadorContext(req);
    if (!affiliate) return res.status(403).json({ error: "Sua conta não está cadastrada como afiliado." });
    if (community) return res.status(409).json({ error: "Você já tem uma comunidade." });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nome da comunidade é obrigatório." });
    const photoUrl = typeof req.body?.photoUrl === "string" && req.body.photoUrl.startsWith("data:image/") ? req.body.photoUrl : null;
    if (photoUrl && photoUrl.length > MAX_COMMUNITY_IMAGE_LENGTH) {
      return res.status(400).json({ error: "Imagem muito grande." });
    }
    const created = await db.createCommunity(affiliate.id, name, photoUrl);
    res.status(201).json(created);
  });

  // Lista de comunidades pra quem ainda não está em nenhuma escolher onde
  // participar.
  app.get("/api/community/directory", async (req, res) => {
    res.json(await db.listCommunitiesDirectory());
  });

  app.post("/api/community/join", async (req, res) => {
    if (!req.appUser.organization_id) {
      return res.status(400).json({ error: "Sua conta não está vinculada a uma organização." });
    }
    const existing = await db.getCommunityMembershipByOrgId(req.appUser.organization_id);
    if (existing) return res.status(409).json({ error: "Você já está em uma comunidade, não é possível trocar." });
    const communityId = Number(req.body?.communityId);
    const community = await db.getCommunityById(communityId);
    if (!community) return res.status(404).json({ error: "Comunidade não encontrada." });
    const membership = await db.joinCommunity(communityId, req.appUser.organization_id);
    res.status(201).json(membership);
  });

  // Confere se a pessoa logada pode VER a comunidade `id`: é a
  // embaixadora dona dela, ou a organização dela é membro. Devolve a
  // comunidade (pra checagem de dono nas rotas de post) ou null.
  async function communityIfAllowed(req, communityId) {
    const community = await db.getCommunityById(communityId);
    if (!community) return null;
    const { affiliate } = await getMyAmbassadorContext(req);
    if (affiliate && community.affiliate_id === affiliate.id) return { community, isOwner: true };
    const membership = req.appUser.organization_id
      ? await db.getCommunityMembershipByOrgId(req.appUser.organization_id)
      : null;
    if (membership && membership.community_id === community.id) return { community, isOwner: false };
    return null;
  }

  // Edição da comunidade (nome/descrição/foto) — só o dono. Qualquer campo
  // omitido mantém o valor atual (ver db.updateCommunityDetails: nome e
  // foto usam COALESCE, descrição aceita null explícito pra dar pra
  // apagar a descrição também).
  app.patch("/api/community/:id", async (req, res) => {
    const allowed = await communityIfAllowed(req, Number(req.params.id));
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode editar." });
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : null;
    const description = typeof req.body?.description === "string" ? req.body.description.trim() || null : undefined;
    const photoUrl = typeof req.body?.photoUrl === "string" && req.body.photoUrl.startsWith("data:image/") ? req.body.photoUrl : null;
    if (photoUrl && photoUrl.length > MAX_COMMUNITY_IMAGE_LENGTH) {
      return res.status(400).json({ error: "Imagem muito grande." });
    }
    const updated = await db.updateCommunityDetails(allowed.community.id, {
      name,
      description: description === undefined ? allowed.community.description : description,
      photoUrl,
    });
    res.json(updated);
  });

  app.post("/api/community/:id/channels", async (req, res) => {
    const allowed = await communityIfAllowed(req, Number(req.params.id));
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode criar canais." });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nome do canal é obrigatório." });
    const groupName = typeof req.body?.groupName === "string" ? req.body.groupName.trim() || null : null;
    const channel = await db.createCommunityChannel(allowed.community.id, name, groupName);
    res.status(201).json(channel);
  });

  app.delete("/api/community/channels/:channelId", async (req, res) => {
    const channel = await db.getCommunityChannelById(Number(req.params.channelId));
    if (!channel) return res.status(404).json({ error: "Canal não encontrado." });
    const allowed = await communityIfAllowed(req, channel.community_id);
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode apagar canais." });
    try {
      await db.deleteCommunityChannel(channel.id);
      res.status(204).end();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // `?channelId=` escolhe qual canal mostrar (padrão: o primeiro criado,
  // igual sempre existe pelo menos o canal "Geral" automático). Devolve os
  // canais junto pra montar a barra lateral sem precisar de outra chamada.
  app.get("/api/community/:id", async (req, res) => {
    const allowed = await communityIfAllowed(req, Number(req.params.id));
    if (!allowed) return res.status(403).json({ error: "Você não tem acesso a essa comunidade." });
    const channels = await db.listCommunityChannels(allowed.community.id);
    if (channels.length === 0) return res.status(500).json({ error: "Essa comunidade não tem nenhum canal." });
    const requestedChannelId = Number(req.query.channelId);
    const activeChannel = channels.find((c) => c.id === requestedChannelId) || channels[0];
    const sort = req.query.sort === "likes" ? "likes" : "recent";
    const posts = await db.listCommunityPostsByChannel(activeChannel.id, req.appUser.id, sort);
    const comments = await db.listCommunityCommentsForCommunity(allowed.community.id);
    const activeMemberCount = await db.countActiveCommunityMembers(allowed.community.id);
    const commentsByPost = new Map();
    for (const c of comments) {
      if (!commentsByPost.has(c.post_id)) commentsByPost.set(c.post_id, []);
      commentsByPost.get(c.post_id).push(c);
    }
    res.json({
      community: allowed.community,
      isOwner: allowed.isOwner,
      channels,
      activeChannelId: activeChannel.id,
      activeMemberCount,
      posts: posts.map((p) => ({ ...p, comments: commentsByPost.get(p.id) || [] })),
    });
  });

  app.post("/api/community/:id/posts", async (req, res) => {
    const allowed = await communityIfAllowed(req, Number(req.params.id));
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode postar." });
    const bodyText = String(req.body?.body || "").trim();
    if (!bodyText) return res.status(400).json({ error: "Escreva algo pra postar." });
    const imageUrl = typeof req.body?.imageUrl === "string" && req.body.imageUrl.startsWith("data:image/") ? req.body.imageUrl : null;
    if (imageUrl && imageUrl.length > MAX_COMMUNITY_IMAGE_LENGTH) {
      return res.status(400).json({ error: "Imagem muito grande." });
    }
    const channel = await db.getCommunityChannelById(Number(req.body?.channelId));
    if (!channel || channel.community_id !== allowed.community.id) {
      return res.status(400).json({ error: "Canal inválido." });
    }
    const post = await db.createCommunityPost({ communityId: allowed.community.id, channelId: channel.id, body: bodyText, imageUrl });
    res.status(201).json({ ...post, like_count: 0, liked_by_me: false, comments: [] });
  });

  app.patch("/api/community/posts/:postId", async (req, res) => {
    const postId = Number(req.params.postId);
    const postRow = await db.getCommunityPostById(postId);
    if (!postRow) return res.status(404).json({ error: "Post não encontrado." });
    const allowed = await communityIfAllowed(req, postRow.community_id);
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode editar o post." });
    const bodyText = String(req.body?.body || "").trim();
    if (!bodyText) return res.status(400).json({ error: "Escreva algo pra postar." });
    const imageUrl = typeof req.body?.imageUrl === "string" && req.body.imageUrl.startsWith("data:image/") ? req.body.imageUrl : postRow.image_url;
    if (imageUrl && imageUrl.length > MAX_COMMUNITY_IMAGE_LENGTH) {
      return res.status(400).json({ error: "Imagem muito grande." });
    }
    const updated = await db.updateCommunityPost(postId, { body: bodyText, imageUrl });
    res.json(updated);
  });

  app.delete("/api/community/posts/:postId", async (req, res) => {
    const postId = Number(req.params.postId);
    const postRow = await db.getCommunityPostById(postId);
    if (!postRow) return res.status(404).json({ error: "Post não encontrado." });
    const allowed = await communityIfAllowed(req, postRow.community_id);
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode apagar o post." });
    await db.deleteCommunityPost(postId);
    res.status(204).end();
  });

  app.post("/api/community/posts/:postId/pin", async (req, res) => {
    const postId = Number(req.params.postId);
    const postRow = await db.getCommunityPostById(postId);
    if (!postRow) return res.status(404).json({ error: "Post não encontrado." });
    const allowed = await communityIfAllowed(req, postRow.community_id);
    if (!allowed || !allowed.isOwner) return res.status(403).json({ error: "Só o embaixador dono da comunidade pode fixar posts." });
    const updated = await db.toggleCommunityPostPin(postId);
    res.json(updated);
  });

  app.post("/api/community/posts/:postId/comments", async (req, res) => {
    const postId = Number(req.params.postId);
    const bodyText = String(req.body?.body || "").trim();
    if (!bodyText) return res.status(400).json({ error: "Escreva um comentário." });
    const postRow = await db.getCommunityPostById(postId);
    if (!postRow) return res.status(404).json({ error: "Post não encontrado." });
    const allowed = await communityIfAllowed(req, postRow.community_id);
    if (!allowed) return res.status(403).json({ error: "Você não tem acesso a essa comunidade." });
    const comment = await db.createCommunityComment({
      postId,
      authorUserId: req.appUser.id,
      authorName: req.appUser.name,
      isAmbassador: allowed.isOwner,
      body: bodyText,
    });
    res.status(201).json(comment);
  });

  app.post("/api/community/posts/:postId/like", async (req, res) => {
    const postId = Number(req.params.postId);
    const postRow = await db.getCommunityPostById(postId);
    if (!postRow) return res.status(404).json({ error: "Post não encontrado." });
    const allowed = await communityIfAllowed(req, postRow.community_id);
    if (!allowed) return res.status(403).json({ error: "Você não tem acesso a essa comunidade." });
    const result = await db.toggleCommunityPostLike(postId, req.appUser.id);
    res.json(result);
  });

  // ---------- Comunidade (admin only) ----------

  app.get("/api/admin/communities", requireAdmin, async (req, res) => {
    res.json(await db.listCommunitiesAdminOverview());
  });

  app.get("/api/admin/community-commissions", requireAdmin, async (req, res) => {
    res.json(await db.listCommunityCommissions());
  });

  app.patch("/api/admin/community-commissions/:id", requireAdmin, async (req, res) => {
    const updated = await db.markCommunityCommissionPaid(Number(req.params.id), !!req.body?.paid);
    if (!updated) return res.status(404).json({ error: "Comissão não encontrada." });
    res.json(updated);
  });

  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    const users = await db.listUsersWithCounts();
    res.json(
      users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        canAccessMinerador: u.can_access_minerador,
        searchCount: u.search_count,
        ipCount: u.ip_count,
        lastIp: u.last_ip,
        lastLoginAt: u.last_login_at,
        lastSeenAt: u.last_seen_at,
        allIps: u.all_ips || [],
        createdAt: u.created_at,
        failedLoginAttempts: u.failed_login_attempts,
        lockedUntil:
          u.locked_until && new Date(u.locked_until) > new Date() ? u.locked_until : null,
        lockedPermanently: u.locked_until && new Date(u.locked_until).getUTCFullYear() >= 9000,
        suspended: u.suspended,
        roleChangedAt: u.role_changed_at,
        roleChangedByName: u.role_changed_by_name,
        organizationId: u.organization_id,
        organizationName: u.organization_name,
        organizationPlan: u.organization_plan ? db.planLimitsFor(u.organization_plan).label : null,
        organizationExpiresAt: u.organization_expires_at,
      }))
    );
  });

  app.get("/api/admin/users/:id/ips", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const rows = await db.ipSummaryForUser(id);
    res.json(rows.map((r) => ({ ip: r.ip, count: r.count, firstAt: r.first_at, lastAt: r.last_at })));
  });

  app.post("/api/admin/users", requireAdmin, async (req, res) => {
    const { name, email, password, role, organizationId, withoutPassword } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: "name e email são obrigatórios" });
    }
    if (!withoutPassword && (!password || password.length < 8)) {
      return res.status(400).json({ error: "password (mín. 8 caracteres) é obrigatório, ou marque 'sem senha'" });
    }
    if (role !== undefined && role !== "admin" && role !== "collaborator") {
      return res.status(400).json({ error: "role deve ser 'admin' ou 'collaborator'" });
    }
    // Admin (você, dono da plataforma) não pertence a organização nenhuma —
    // colaborador (conta de cliente) sempre precisa de uma, é o que carrega
    // o plano/limite dela.
    let organization = null;
    if (role !== "admin") {
      const orgId = Number(organizationId);
      if (!Number.isInteger(orgId)) {
        return res.status(400).json({ error: "Selecione a organização desse usuário." });
      }
      organization = await db.getOrganizationById(orgId);
      if (!organization) return res.status(400).json({ error: "Organização não encontrada." });
      const currentCount = await db.countUsersInOrg(orgId);
      const limits = db.planLimitsFor(organization.plan);
      if (currentCount >= limits.maxUsers) {
        return res.status(400).json({
          error: `A organização "${organization.name}" já está no limite de ${limits.maxUsers} usuário(s) do plano ${limits.label}, mude o plano ou remova outro usuário antes.`,
        });
      }
    }

    const existing = await db.findUserByEmail(email);
    if (existing) return res.status(409).json({ error: "Já existe um usuário com esse email." });

    let passwordHash;
    if (withoutPassword) {
      // Mesmo mecanismo do webhook da Cakto (web/cakto.js): senha aleatória
      // que ninguém nunca vê, só existe porque password_hash é NOT NULL. A
      // pessoa define a própria senha de verdade em /registrar, provando que
      // é dona do email. Serve pra quando o admin precisa criar a conta na
      // mão (ex: automação da Cakto falhou) sem saber/inventar uma senha.
      passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 10);
    } else {
      if (await isPasswordPwned(password)) {
        return res.status(400).json({ error: "Essa senha já apareceu em vazamentos conhecidos, escolha outra." });
      }
      passwordHash = await bcrypt.hash(password, 10);
    }
    const user = await db.createUser({
      name,
      email,
      passwordHash,
      role: role || "collaborator",
      createdById: req.appUser.id,
      organizationId: organization ? organization.id : null,
      needsPasswordSetup: !!withoutPassword,
    });
    await db.logAdminAction(
      req.appUser.id,
      req.appUser.name,
      user.id,
      user.name,
      "created",
      withoutPassword
        ? "Criado sem senha — usuário define em /registrar"
        : role === "admin"
        ? "Criado já como admin"
        : null
    );
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  // Última linha de defesa antes de tirar admin de alguém (demote, suspender
  // ou excluir): se essa pessoa é a ÚLTIMA admin ATIVA, ninguém mais teria
  // como entrar no painel depois — bloqueia mesmo que quem esteja pedindo
  // seja ela mesma se auto-rebaixando sem perceber a consequência.
  async function assertNotLastActiveAdmin(id, actionLabel) {
    const target = await db.getAppUserById(id);
    if (!target || target.role !== "admin" || target.suspended) return null;
    const activeAdmins = await db.countActiveAdmins();
    if (activeAdmins <= 1) {
      return `Não é possível ${actionLabel} o último administrador ativo, promova outra pessoa a admin antes.`;
    }
    return null;
  }

  app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const { role, canAccessMinerador, suspended, password, organizationId } = req.body || {};
    if (role !== undefined && role !== "admin" && role !== "collaborator") {
      return res.status(400).json({ error: "role deve ser 'admin' ou 'collaborator'" });
    }
    if (suspended !== undefined && typeof suspended !== "boolean") {
      return res.status(400).json({ error: "suspended deve ser true ou false" });
    }
    if (password !== undefined && password.length < 8) {
      return res.status(400).json({ error: "A senha precisa ter no mínimo 8 caracteres." });
    }
    if (password !== undefined && (await isPasswordPwned(password))) {
      return res.status(400).json({ error: "Essa senha já apareceu em vazamentos conhecidos, escolha outra." });
    }
    if (role !== undefined && role !== "admin") {
      const error = await assertNotLastActiveAdmin(id, "remover o admin de");
      if (error) return res.status(400).json({ error });
    }
    if (suspended === true) {
      const error = await assertNotLastActiveAdmin(id, "suspender");
      if (error) return res.status(400).json({ error });
    }

    const before = await db.getAppUserById(id);
    if (!before) return res.status(404).json({ error: "Usuário não encontrado." });

    // Papel final depois desse PATCH (pode não estar mudando agora, ex:
    // só trocando a organização de um colaborador que já era colaborador).
    const finalRole = role !== undefined ? role : before.role;

    // organizationId só faz sentido combinado com o papel final: admin
    // nunca tem organização (mesma regra do POST /api/admin/users), e
    // colaborador sempre precisa de uma pra herdar plano/limite. Cobre
    // tanto "rebaixar admin pra virar cliente" quanto "mover colaborador
    // pra outra organização".
    let finalOrganizationId; // undefined = não mexe
    if (finalRole === "admin") {
      finalOrganizationId = null;
    } else if (organizationId !== undefined) {
      const orgId = Number(organizationId);
      if (!Number.isInteger(orgId)) {
        return res.status(400).json({ error: "Selecione uma organização válida." });
      }
      const organization = await db.getOrganizationById(orgId);
      if (!organization) return res.status(400).json({ error: "Organização não encontrada." });
      if (orgId !== before.organization_id) {
        const currentCount = await db.countUsersInOrg(orgId);
        const limits = db.planLimitsFor(organization.plan);
        if (currentCount >= limits.maxUsers) {
          return res.status(400).json({
            error: `A organização "${organization.name}" já está no limite de ${limits.maxUsers} usuário(s) do plano ${limits.label}, mude o plano ou remova outro usuário antes.`,
          });
        }
      }
      finalOrganizationId = orgId;
    } else if (role === "collaborator" && before.role === "admin" && !before.organization_id) {
      // Rebaixando admin pra colaborador sem escolher organização: precisa
      // de uma, senão a conta fica sem plano nenhum (mesma trava do POST
      // /api/admin/users).
      return res.status(400).json({ error: "Selecione a organização desse usuário antes de tirar o admin dele." });
    }

    // Colaborador que ganha organização (seja recém-criada por essa troca,
    // seja movida de outra) já sai liberado pro ScoutX, mesma regra de
    // db.createUser — senão a pessoa muda de plano e continua sem acesso
    // até alguém lembrar de destravar manualmente.
    const finalCanAccessMinerador =
      typeof canAccessMinerador === "boolean"
        ? canAccessMinerador
        : finalOrganizationId != null && before.organization_id !== finalOrganizationId
        ? true
        : undefined;

    await db.updateUserPermissions(id, {
      role,
      canAccessMinerador: finalCanAccessMinerador,
      suspended,
      changedById: req.appUser.id,
      organizationId: finalOrganizationId,
    });
    // Senha muda em query separada (updateUserPermissions só monta SET pros
    // campos de permissão) — admin resetando a senha de outra pessoa, ex:
    // usuário esqueceu ou perdeu acesso ao email cadastrado.
    if (password !== undefined) {
      const passwordHash = await bcrypt.hash(password, 10);
      await db.updateUserPassword(id, passwordHash);
    }

    // Auditoria: um registro por mudança de fato ocorrida (não por campo
    // presente no body) — comparar contra o estado ANTES evita logar
    // "promovido" toda vez que o admin salva a tela sem ter mexido no cargo.
    const logs = [];
    if (role !== undefined && role !== before.role) {
      logs.push([role === "admin" ? "promoted" : "demoted", null]);
    }
    if (suspended !== undefined && suspended !== before.suspended) {
      logs.push([suspended ? "suspended" : "reactivated", null]);
    }
    if (typeof canAccessMinerador === "boolean" && canAccessMinerador !== before.can_access_minerador) {
      logs.push(["permission_changed", `ScoutX: ${canAccessMinerador ? "liberado" : "removido"}`]);
    }
    if (finalOrganizationId !== undefined && finalOrganizationId !== before.organization_id) {
      const orgLabel = finalOrganizationId
        ? (await db.getOrganizationById(finalOrganizationId))?.name || `#${finalOrganizationId}`
        : "nenhuma";
      logs.push(["org_changed", `Organização: ${orgLabel}`]);
    }
    if (password !== undefined) {
      logs.push(["password_reset", null]);
    }
    for (const [action, details] of logs) {
      await db.logAdminAction(req.appUser.id, req.appUser.name, id, before.name, action, details);
    }

    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    if (id === req.appUser.id) return res.status(400).json({ error: "Você não pode remover sua própria conta." });
    const target = await db.getAppUserById(id);
    if (!target) return res.status(404).json({ error: "Usuário não encontrado." });
    const error = await assertNotLastActiveAdmin(id, "remover");
    if (error) return res.status(400).json({ error });
    await db.deleteUser(id);
    await db.logAdminAction(req.appUser.id, req.appUser.name, id, target.name, "deleted", null);
    res.json({ ok: true });
  });

  app.get("/api/admin/audit-log", requireAdmin, async (req, res) => {
    const rows = await db.listAdminAuditLog(100);
    res.json(
      rows.map((r) => ({
        id: r.id,
        actorName: r.actor_name,
        targetName: r.target_name,
        action: r.action,
        details: r.details,
        createdAt: r.created_at,
      }))
    );
  });

  // ---------- Organizações / planos (admin only) ----------

  function serializeOrg(o) {
    const limits = db.planLimitsFor(o.plan);
    return {
      id: o.id,
      name: o.name,
      plan: o.plan,
      planLabel: limits.label,
      billingCycle: o.billing_cycle,
      startedAt: o.started_at,
      expiresAt: o.expires_at,
      expired: new Date(o.expires_at) < new Date(),
      notes: o.notes,
      userCount: o.user_count,
      maxUsers: Number.isFinite(limits.maxUsers) ? limits.maxUsers : null,
      maxOperations: Number.isFinite(limits.maxOperations) ? limits.maxOperations : null,
      maxCompetitors: Number.isFinite(limits.maxCompetitors) ? limits.maxCompetitors : null,
    };
  }

  app.get("/api/admin/organizations", requireAdmin, async (req, res) => {
    const rows = await db.listOrganizationsWithCounts();
    res.json(rows.map(serializeOrg));
  });

  app.post("/api/admin/organizations", requireAdmin, async (req, res) => {
    const { name, plan, billingCycle, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Nome da organização é obrigatório." });
    if (!Object.prototype.hasOwnProperty.call(db.PLAN_LIMITS, plan)) {
      return res.status(400).json({ error: "Plano inválido." });
    }
    if (!Object.prototype.hasOwnProperty.call(db.BILLING_CYCLE_DAYS, billingCycle)) {
      return res.status(400).json({ error: "Ciclo de cobrança inválido." });
    }
    const org = await db.createOrganization({ name: name.trim(), plan, billingCycle, notes });
    await db.logAdminAction(req.appUser.id, req.appUser.name, null, org.name, "org_created", `Plano ${db.planLimitsFor(plan).label} · ${billingCycle}`);
    res.status(201).json(serializeOrg({ ...org, user_count: 0 }));
  });

  app.patch("/api/admin/organizations/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const org = await db.getOrganizationById(id);
    if (!org) return res.status(404).json({ error: "Organização não encontrada." });

    const { plan, billingCycle, expiresAt, name, notes, extendValidity } = req.body || {};
    let updated = org;

    if (plan !== undefined || billingCycle !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(db.PLAN_LIMITS, plan)) {
        return res.status(400).json({ error: "Plano inválido." });
      }
      if (!Object.prototype.hasOwnProperty.call(db.BILLING_CYCLE_DAYS, billingCycle)) {
        return res.status(400).json({ error: "Ciclo de cobrança inválido." });
      }
      // Trocar pra um plano com limite menor não desconecta ninguém — só
      // avisa; o próprio limite passa a barrar CRIAR gente nova até
      // organizar/remover quem sobra.
      const newLimits = db.planLimitsFor(plan);
      const currentCount = await db.countUsersInOrg(id);
      // extendValidity=false: upgrade/downgrade de plano no meio do ciclo,
      // cliente já pagou a diferença por fora — troca só o plano, mantém a
      // validade como está (não empurra pra frente um ciclo inteiro de
      // brinde, nem o cliente perde o que já pagou). Default (undefined ou
      // true) continua sendo o comportamento de sempre: renovação de
      // verdade, estende a validade.
      if (extendValidity === false) {
        updated = await db.changeOrganizationPlan(id, plan, billingCycle);
        await db.logAdminAction(
          req.appUser.id,
          req.appUser.name,
          null,
          org.name,
          "org_plan_changed",
          `${db.planLimitsFor(org.plan).label} → ${newLimits.label} · ${billingCycle} (upgrade, validade mantida)` +
            (currentCount > newLimits.maxUsers ? ` (⚠️ já tem ${currentCount} usuário(s), acima do novo limite)` : "")
        );
      } else {
        updated = await db.renewOrganization(id, plan, billingCycle);
        await db.logAdminAction(
          req.appUser.id,
          req.appUser.name,
          null,
          org.name,
          "org_renewed",
          `${db.planLimitsFor(org.plan).label} → ${newLimits.label} · ${billingCycle}` +
            (currentCount > newLimits.maxUsers ? ` (⚠️ já tem ${currentCount} usuário(s), acima do novo limite)` : "")
        );
      }

      // Revisão de segurança: rebaixar pra Standard tinha que travar alerta
      // no Discord na hora do PRÓXIMO envio (ver settings.py::set_discord_webhook),
      // mas quem já tinha configurado um webhook enquanto era Pro continuava
      // recebendo de graça pra sempre — create_alert nunca reconfere o plano
      // no momento de mandar. Limpa aqui, na hora da troca, pra não depender
      // de ninguém lembrar de fazer isso manualmente. Best-effort: se o
      // FastAPI estiver fora do ar nesse instante, só loga — não pode travar
      // a troca de plano em si, que já foi salva no banco daqui.
      if (plan === "solo" && org.plan !== "solo" && MINERADOR_API_URL) {
        try {
          const memberIds = await db.getOrgMemberIds(id);
          if (memberIds.length > 0) {
            const clearResp = await fetch(`${MINERADOR_API_URL.replace(/\/+$/, "")}/api/settings/discord/clear-for-users`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-User-Id": String(req.appUser.id),
                "X-User-Is-Admin": "true",
                "X-Internal-Secret": INTERNAL_API_SECRET,
              },
              body: JSON.stringify({ user_ids: memberIds }),
            });
            if (!clearResp.ok) {
              console.error(`Falha ao limpar webhooks do Discord da organização ${id} após rebaixar pra Standard: HTTP ${clearResp.status}`);
            }
          }
        } catch (err) {
          console.error(`Erro ao limpar webhooks do Discord da organização ${id} após rebaixar pra Standard:`, err);
        }
      }
    } else if (expiresAt !== undefined) {
      updated = await db.updateOrganizationExpiry(id, new Date(expiresAt));
      await db.logAdminAction(req.appUser.id, req.appUser.name, null, org.name, "org_expiry_edited", null);
    }

    if (name !== undefined || notes !== undefined) {
      await db.updateOrganizationDetails(id, { name, notes });
      updated = await db.getOrganizationById(id);
    }

    const userCount = await db.countUsersInOrg(id);
    res.json(serializeOrg({ ...updated, user_count: userCount }));
  });

  app.delete("/api/admin/organizations/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const org = await db.getOrganizationById(id);
    if (!org) return res.status(404).json({ error: "Organização não encontrada." });

    // Trava de segurança: organization_id em app_users referencia essa
    // linha sem ON DELETE — o Postgres recusaria a exclusão de qualquer
    // jeito, mas confere aqui ANTES pra devolver uma mensagem clara ("mova
    // ou remova o usuário primeiro" em vez de um erro de constraint cru).
    const userCount = await db.countUsersInOrg(id);
    if (userCount > 0) {
      return res.status(400).json({
        error: `Essa organização ainda tem ${userCount} usuário(s) vinculado(s). Remova ou mova ${userCount === 1 ? "ele" : "eles"} pra outra organização (aba Usuários) antes de excluir.`,
      });
    }

    await db.deleteOrganization(id);
    await db.logAdminAction(req.appUser.id, req.appUser.name, null, org.name, "org_deleted", null);
    res.json({ ok: true });
  });

  // ---------- Histórico de buscas (admin da plataforma, só) ----------

  // Revisão de segurança + pedido explícito do usuário: existia uma permissão
  // (can_view_history) que um admin podia conceder a um colaborador comum
  // pra ver histórico — mas as consultas não filtravam por organização, então
  // esse colaborador acabava vendo histórico de busca de QUALQUER usuário do
  // sistema, de qualquer outra organização cliente. Em vez de só corrigir o
  // filtro, a decisão foi simplificar: histórico agora é só pra admin da
  // plataforma, sem meio-termo — ver Usuarios.jsx (toggle removido) e
  // db.js/server.js (coluna can_view_history não é mais lida/gravada).
  function requireHistoryAccess(req, res, next) {
    if (req.appUser.role !== "admin") {
      return res.status(403).json({ error: "Só administradores podem ver o histórico." });
    }
    next();
  }

  app.get("/api/history", requireHistoryAccess, async (req, res) => {
    const users = await db.listUsersWithCounts();
    res.json(users.map((u) => ({ id: u.id, name: u.name, searchCount: u.search_count })));
  });

  app.get("/api/history/:userId", requireHistoryAccess, async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId inválido" });
    const rows = await db.historySummaryForUser(userId);
    res.json(rows.map((r) => ({ domain: r.domain, tool: r.tool, count: r.count, lastAt: r.last_at })));
  });

  // ---------- Mega Minerador (admin, ou quem tiver permissão) ----------

  const MINERADOR_API_URL = process.env.MINERADOR_API_URL;
  const mineradorPublicDir = path.join(__dirname, "public-minerador");

  function requireMineradorAccess(req, res, next) {
    if (req.appUser.role !== "admin" && !req.appUser.can_access_minerador) {
      if (req.path.startsWith("/api/")) {
        return res.status(403).json({ error: "Você não tem permissão para acessar o Minerador." });
      }
      return res.status(403).send("Você não tem permissão para acessar essa área.");
    }
    next();
  }

  app.all("/api/minerador/*", requireMineradorAccess, async (req, res) => {
    if (!MINERADOR_API_URL) {
      return res.status(503).json({ error: "Minerador ainda não está configurado neste ambiente." });
    }
    // O front-end do Minerador monta suas próprias URLs já com "/api/..."
    // (ex: request('/api/dashboard/summary')), então só removemos o prefixo
    // "/api/minerador" e sobra exatamente a rota que o FastAPI espera.
    const targetPath = req.originalUrl.replace(/^\/api\/minerador/, "") || "/";
    const targetUrl = `${MINERADOR_API_URL.replace(/\/+$/, "")}${targetPath}`;

    // Limite de países do plano: o FastAPI não tem acesso ao banco de
    // organizações (vive aqui, no Node) — manda quem mais são os colegas de
    // organização e o teto de países dela em headers confiáveis, mesmo
    // modelo do X-User-Id/X-User-Is-Admin abaixo. Sem organização (conta
    // admin) = sem cabeçalho nenhum = sem limite, igual hoje.
    const orgHeaders = {};
    if (req.appUser.organization_id) {
      const memberIds = await db.getOrgMemberIds(req.appUser.organization_id);
      orgHeaders["X-Org-Member-Ids"] = memberIds.join(",");
      // Chave crua do plano (solo/pro/agencia) — usada pelo FastAPI só pra
      // travar feature específica de plano (Discord, histórico de Alertas),
      // diferente dos tetos numéricos abaixo (ver deps.py::is_standard_plan).
      orgHeaders["X-Org-Plan"] = req.appUser.org_plan;
      const limits = db.planLimitsFor(req.appUser.org_plan);
      if (Number.isFinite(limits.maxOperations)) {
        orgHeaders["X-Org-Max-Operations"] = String(limits.maxOperations);
      }
      if (Number.isFinite(limits.maxCompetitors)) {
        orgHeaders["X-Org-Max-Competitors"] = String(limits.maxCompetitors);
      }
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          // Multi-tenant: o FastAPI não tem conexão com este banco (onde
          // mora app_users), então a identidade de quem está pedindo só
          // chega assim — ver backend/app/api/deps.py. Mesmo modelo de
          // confiança que já existia (rede interna do Railway, serviço sem
          // domínio público), só que agora explícito por usuário.
          "X-User-Id": String(req.appUser.id),
          "X-User-Is-Admin": req.appUser.role === "admin" ? "true" : "false",
          "X-Internal-Secret": INTERNAL_API_SECRET,
          ...orgHeaders,
        },
        body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      });
      const data = await upstream.text();
      // A prévia de produto (/api/products/:id/preview) devolve a página
      // HTML REAL de um concorrente, com CSS/fonte hospedados no domínio
      // dele — o CSP global (style-src/font-src 'self') barra tudo isso e a
      // prévia aparece sem estilo nenhum ("bugada"). Só nessa rota, libera
      // estilo/fonte/imagem de qualquer https; script continua bloqueado
      // (o back já remove <script> antes de servir, e o iframe usa
      // sandbox="" — script-src 'none' aqui é só mais uma camada).
      if (/^\/api\/products\/\d+\/preview$/.test(targetPath)) {
        applyPreviewCsp(res);
      }
      res.status(upstream.status);
      res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.send(data);
    } catch (err) {
      console.error("erro no proxy do minerador:", err);
      res.status(502).json({ error: "Não foi possível contatar o serviço do Minerador." });
    }
  });

  // Fusão dos apps: o ScoutX (React) virou o app inteiro, servido na raiz —
  // antes vivia em /minerador, com o app antigo "Buscar Barcode Shopify" na
  // raiz. requireMineradorAccess NÃO entra aqui de propósito: ele só protege
  // dado de verdade (o proxy /api/minerador/* abaixo, intacto), porque nem
  // toda tela do app novo precisa dessa permissão — Buscar Barcode/Espionar
  // Loja sempre foram liberados pra qualquer usuário logado, e agora moram
  // dentro desse mesmo React (RouteGuard no frontend cuida de esconder/
  // bloquear as telas do ScoutX em si pra quem não tem canAccessMinerador).
  app.use(express.static(mineradorPublicDir));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(mineradorPublicDir, "index.html"), (err) => {
      if (err) res.status(503).send("ScoutX ainda não está disponível neste ambiente.");
    });
  });

  // ---------- Rotas da ferramenta (mesmas do app desktop) ----------

  // Achado ao vivo (2026-08-31): "loja protegida" (admin, aba Usuários) só
  // travava o CADASTRO em Concorrentes — Buscar Fornecedor e Espionar Loja
  // buscam a URL direto aqui no Node, sem passar por register_competitor,
  // então continuavam trazendo dado de loja protegida. A lista em si vive
  // só no banco do FastAPI (tabela protected_stores), então precisa
  // perguntar pra lá — mesma dupla camada de confiança do proxy
  // /api/minerador/* (X-Internal-Secret + X-User-Id), já que essa rota
  // roda pra QUALQUER busca de QUALQUER usuário, não só admin.
  //
  // Fail-CLOSED de propósito (pedido explícito: "deixe elas impossíveis de
  // serem acessadas") — se não der pra confirmar que a loja NÃO está
  // protegida (FastAPI fora do ar, timeout, etc.), bloqueia por segurança
  // em vez de arriscar vazar dado de uma loja protegida durante a
  // instabilidade. Only exceção: MINERADOR_API_URL não configurado (ambiente
  // sem o FastAPI ligado, ex: dev local) — aí não tem lista nenhuma pra
  // proteger mesmo, segue sem bloquear.
  async function isProtectedStoreDomain(rawUrl, userId) {
    if (!MINERADOR_API_URL) return false;
    const domain = extractDomain(rawUrl);
    if (!domain) return false;
    try {
      const resp = await fetch(
        `${MINERADOR_API_URL.replace(/\/+$/, "")}/api/competitors/protected-stores/check?domain=${encodeURIComponent(domain)}`,
        { headers: { "X-User-Id": String(userId), "X-Internal-Secret": INTERNAL_API_SECRET } }
      );
      if (!resp.ok) {
        console.error(`Checagem de loja protegida falhou (HTTP ${resp.status}) — bloqueando por segurança.`);
        return true;
      }
      const data = await resp.json();
      return data.protected === true;
    } catch (err) {
      console.error("Falha ao checar loja protegida (bloqueando por segurança):", err);
      return true;
    }
  }

  app.get("/api/buscar", async (req, res) => {
    const limit = checkFetchRouteLimit(req.appUser.id);
    if (limit.blocked) {
      return res.status(429).json({ error: `Muitas buscas em pouco tempo, tenta de novo em ${limit.retryAfterSeconds}s.` });
    }
    const raw = req.query.url;
    if (!raw) {
      return res.status(400).json({ error: "Parâmetro 'url' é obrigatório" });
    }

    if (await isProtectedStoreDomain(raw, req.appUser.id)) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    const domain = extractDomain(raw);
    if (domain) {
      db.logSearch(req.appUser.id, "barcode", domain, String(raw)).catch((e) => console.error("log search:", e));
    }

    let jsonUrl;
    try {
      jsonUrl = normalizeShopifyProductUrl(raw);
    } catch (err) {
      return res.status(400).json({ error: err.message || "URL inválida" });
    }

    let safeFetch;
    try {
      safeFetch = await createPinnedFetch(new URL(jsonUrl).hostname);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let response;
    try {
      response = await safeFetch(jsonUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; BuscarBarcodeShopify/1.0)",
        },
      });
    } catch {
      return res.status(502).json({ error: "Não foi possível conectar à loja" });
    }

    if (response.status === 404) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }
    if (!response.ok) {
      return res.status(502).json({ error: "Loja não suportada" });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return res.status(502).json({ error: "Loja não suportada" });
    }

    const result = extractBarcode(payload);
    if (!result) {
      return res.status(404).json({ error: "Código de barras não encontrado para este produto" });
    }

    res.json({ jsonUrl, ...result });
  });

  app.get("/api/spy", async (req, res) => {
    const limit = checkFetchRouteLimit(req.appUser.id);
    if (limit.blocked) {
      return res.status(429).json({ error: `Muitas análises em pouco tempo, tenta de novo em ${limit.retryAfterSeconds}s.` });
    }
    const raw = req.query.url;
    if (!raw) {
      return res.status(400).json({ error: "Parâmetro 'url' é obrigatório" });
    }

    if (await isProtectedStoreDomain(raw, req.appUser.id)) {
      return res.status(502).json({ error: "Não foi possível analisar esta loja" });
    }

    const domain = extractDomain(raw);
    if (domain) {
      db.logSearch(req.appUser.id, "spy", domain, String(raw)).catch((e) => console.error("log search:", e));
    }

    if (!domain) {
      return res.status(400).json({ error: "URL inválida" });
    }
    // Valida e fixa no MESMO hostname que analyzeStore vai usar de verdade
    // pra montar as URLs (new URL(raw).hostname, sem tirar o "www." como
    // `domain` faz aqui em cima só pra agrupar no histórico de busca) —
    // senão a validação e a conexão real podiam acabar em hosts diferentes.
    let safeFetch;
    try {
      safeFetch = await createPinnedFetch(new URL(String(raw).trim()).hostname);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const result = await analyzeStore(raw, safeFetch);
      res.json(result);
    } catch (err) {
      if (err instanceof UnsupportedStoreError) {
        return res.status(400).json({ error: err.message });
      }
      console.error(err);
      res.status(502).json({ error: "Não foi possível analisar esta loja" });
    }
  });

  // Prévia (iframe) pra um produto encontrado em "Espionar Loja" — essa tela
  // não tem product_id persistido (é um scrape na hora, não fica salvo no
  // banco), então não dá pra reusar /api/minerador/api/products/:id/preview
  // (rota do FastAPI, exige produto salvo E dono pelo usuário). Espelha o
  // mesmo tratamento do preview_product_page lá (ver comentário de
  // sanitizePreviewHtml acima), só que buscando a URL recebida direto.
  app.get("/api/spy-preview", async (req, res) => {
    const limit = checkFetchRouteLimit(req.appUser.id);
    if (limit.blocked) {
      return res.status(429).json({ error: `Muitas prévias em pouco tempo, tenta de novo em ${limit.retryAfterSeconds}s.` });
    }
    const raw = req.query.url;
    let target;
    try {
      target = new URL(String(raw || "").trim());
      if (!/^https?:$/.test(target.protocol)) throw new Error("protocolo inválido");
    } catch {
      return res.status(400).json({ error: "URL inválida" });
    }

    if (await isProtectedStoreDomain(raw, req.appUser.id)) {
      applyPreviewCsp(res);
      return res.status(200).send(previewErrorPage(target.toString()));
    }

    let safeFetch;
    try {
      safeFetch = await createPinnedFetch(target.hostname);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let html;
    try {
      const response = await safeFetch(target.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BuscarBarcodeShopify/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      // redirect: "manual" (ver safe-fetch.js) faz `response.ok` já dar
      // falso pra 3xx — pra onde redirecionaria não passou pela validação
      // de IP, então tratamos igual erro em vez de seguir sem validar.
      if (!response.ok) {
        applyPreviewCsp(res);
        return res.status(200).send(previewErrorPage(target.toString()));
      }
      html = await response.text();
    } catch {
      applyPreviewCsp(res);
      return res.status(200).send(previewErrorPage(target.toString()));
    }

    applyPreviewCsp(res);
    res.status(200).send(sanitizePreviewHtml(html, target.hostname));
  });

  return app;
}

function startServer(port = process.env.PORT || 3001) {
  return new Promise((resolve, reject) => {
    db.migrate()
      .then(() => db.ensureMineradorDatabase())
      .then(() => {
        const app = createApp();
        const server = app.listen(port, () => resolve({ port: server.address().port, server }));
        server.on("error", reject);
      })
      .catch(reject);
  });
}

module.exports = { startServer, createApp };

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`ScoutX (web) rodando em http://localhost:${port}`);
  });
}
