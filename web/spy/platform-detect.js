// Detecta em qual plataforma uma loja roda ANTES de tentar extrair produtos —
// hoje o Espionar Loja assume Shopify sempre (ver shopify-spy.js). Isso aqui
// generaliza pra WooCommerce e reconhece os becos sem saída já mapeados
// (SaaS branca chinesa sem SKU público, funil sem loja nenhuma por trás) pra
// não gastar tempo tentando extrair produto de loja que não tem produto.
const FETCH_HEADERS = {
  Accept: "application/json, text/html;q=0.8",
  "User-Agent": "Mozilla/5.0 (compatible; ScoutXPlatformDetect/1.0)",
};
const PROBE_TIMEOUT_MS = 8000;

// Namespaces do /wp-json/ que só aparecem quando a loja foi montada pelo
// gerador de site com IA da Hostinger (achado testando bellamexico.shop).
const HOSTINGER_AI_NAMESPACES = ["hostinger-ai-assistant", "hostinger-ai-plugin", "hostinger-easy-onboarding"];

// Assinaturas da SaaS branca chinesa de funis COD (achado testando
// mex.rrulizzy.com, whitenew.com, kuabarahamoo.com, mex.vsisoffine.com,
// mx.filessw.com): mesmo bundle JS, mesmo backend, domínios de CDN
// aleatórios diferentes por loja. Confirmado que essa plataforma NUNCA
// expõe SKU/barcode em lugar nenhum do schema — detectar só pra explicar
// por que não tem produto pra extrair, não pra tentar mesmo assim.
const WHITELABEL_COD_SAAS_SIGNATURES = [/api\.btrbdf\.com\/shopapi/i, /pageInfo\.C0m4UVq5\.js/i];

class PlatformDetectError extends Error {}

function baseUrlFromInput(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new PlatformDetectError("URL inválida");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new PlatformDetectError("URL inválida");
  }
  return `${url.protocol}//${url.host}`;
}

// TLS expirado/inválido não aparece como erro HTTP normal, o Node recusa a
// conexão antes de chegar em qualquer resposta — por isso precisa checar o
// `cause.code` do erro, não o status. Visto em 2 lojas reais (viralboom.com.mx,
// paluegoestarde.com.mx): nenhum navegador de visitante real abre essas
// páginas, então nem vale tentar detectar plataforma, só reportar "inativa".
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

async function checkLiveness(baseUrl, fetchImpl) {
  try {
    const res = await fetchImpl(baseUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status >= 500) return { alive: false, reason: `http_${res.status}` };
    return { alive: true };
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code && TLS_ERROR_CODES.has(code)) return { alive: false, reason: "ssl_expired" };
    if (err?.name === "TimeoutError") return { alive: false, reason: "timeout" };
    return { alive: false, reason: "unreachable" };
  }
}

async function probe(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // resposta não é JSON (página de desafio anti-bot, HTML normal, etc.)
    }
    return { status: res.status, json, text };
  } catch {
    return { status: 0, json: null, text: "" };
  }
}

/**
 * @returns {{baseUrl: string, platform: string, reason?: string, isHostingerAI?: boolean, isPixelYourSite?: boolean}}
 *
 * `platform` é um de: "dead" (loja fora do ar/SSL vencido), "shopify",
 * "woocommerce", "wordpress-no-store" (WordPress sem loja nenhuma, tipo
 * página de conteúdo/advertorial), "whitelabel-cod-saas" (SaaS chinesa sem
 * SKU público), "unknown" (não reconhecemos, inclusive quando um desafio
 * anti-bot bloqueou a sondagem).
 */
async function detectPlatform(rawUrl, fetchImpl) {
  const baseUrl = baseUrlFromInput(rawUrl);

  const liveness = await checkLiveness(baseUrl, fetchImpl);
  if (!liveness.alive) return { baseUrl, platform: "dead", reason: liveness.reason };

  const shopifyProbe = await probe(fetchImpl, `${baseUrl}/products.json?limit=1`);
  if (shopifyProbe.json && Array.isArray(shopifyProbe.json.products)) {
    return { baseUrl, platform: "shopify" };
  }

  const wpProbe = await probe(fetchImpl, `${baseUrl}/wp-json/`);
  if (wpProbe.json && Array.isArray(wpProbe.json.namespaces)) {
    const namespaces = wpProbe.json.namespaces;
    const hasWooCommerce = namespaces.some((n) => n.startsWith("wc/"));
    const isHostingerAI = namespaces.some((n) => HOSTINGER_AI_NAMESPACES.includes(n));
    const isPixelYourSite = namespaces.some((n) => n.startsWith("pys"));
    if (hasWooCommerce) {
      return { baseUrl, platform: "woocommerce", isHostingerAI, isPixelYourSite };
    }
    return { baseUrl, platform: "wordpress-no-store" };
  }
  if (wpProbe.status !== 0 && /checking your browser/i.test(wpProbe.text)) {
    return { baseUrl, platform: "unknown", reason: "anti_bot_challenge" };
  }

  const homeProbe = await probe(fetchImpl, baseUrl);
  if (WHITELABEL_COD_SAAS_SIGNATURES.some((re) => re.test(homeProbe.text))) {
    return { baseUrl, platform: "whitelabel-cod-saas" };
  }

  return { baseUrl, platform: "unknown" };
}

module.exports = { detectPlatform, baseUrlFromInput, PlatformDetectError };
