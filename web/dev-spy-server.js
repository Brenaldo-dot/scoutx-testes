// Servidor local SÓ PRA DESENVOLVIMENTO do detector multi-plataforma —
// não faz parte do ScoutX em produção, não tem login/banco/rate-limit real,
// é só pra rodar `node dev-spy-server.js` e testar visualmente no navegador
// antes de portar pra server.js de verdade. Reusa o mesmo safe-fetch.js
// (proteção SSRF) que a rota real usa, pra já testar com a mesma segurança.
const express = require("express");
const { createPinnedFetch } = require("./safe-fetch");
const { detectPlatform } = require("./spy/platform-detect");
const { analyzeStore, UnsupportedStoreError: ShopifyUnsupported } = require("./shopify-spy");
const { analyzeWooCommerceStore, UnsupportedStoreError: WooUnsupported } = require("./spy/woocommerce-spy");

const app = express();
const PORT = process.env.DEV_SPY_PORT || 4100;

const PLATFORM_LABELS = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  "wordpress-no-store": "WordPress sem loja (página de conteúdo/advertorial)",
  "whitelabel-cod-saas": "SaaS branca de funil COD (sem SKU público)",
  dead: "Loja fora do ar / inacessível",
  unknown: "Não reconhecida",
};

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>ScoutX — detector multi-plataforma (dev local)</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; color: #9fd0ff; }
  form { display: flex; gap: 8px; margin-bottom: 20px; max-width: 700px; }
  input { flex: 1; padding: 10px 12px; border-radius: 6px; border: 1px solid #333; background: #1a1d24; color: #fff; font-size: 14px; }
  button { padding: 10px 18px; border-radius: 6px; border: none; background: #3b82f6; color: #fff; font-weight: 600; cursor: pointer; }
  button:hover { background: #2563eb; }
  #status { margin: 12px 0; color: #9aa0a6; font-size: 13px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
  .badge.shopify { background: #16321f; color: #6bd48a; }
  .badge.woocommerce { background: #2a2340; color: #b49dff; }
  .badge.dead { background: #3a1f1f; color: #ff8b8b; }
  .badge.unknown, .badge.wordpress-no-store, .badge.whitelabel-cod-saas { background: #332b12; color: #f0c95c; }
  .meta { font-size: 13px; color: #9aa0a6; margin-bottom: 16px; line-height: 1.6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { background: #1a1d24; border: 1px solid #2a2d34; border-radius: 8px; overflow: hidden; }
  .card img { width: 100%; height: 140px; object-fit: cover; background: #000; }
  .card .body { padding: 10px; }
  .card .title { font-size: 13px; font-weight: 600; margin-bottom: 4px; line-height: 1.3; height: 34px; overflow: hidden; }
  .card .price { color: #6bd48a; font-weight: 700; font-size: 14px; }
  .card .sku { color: #9aa0a6; font-size: 11px; margin-top: 4px; }
  details { margin-top: 24px; }
  pre { background: #0a0c10; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: 500px; }
  .error { background: #3a1f1f; color: #ff8b8b; padding: 12px; border-radius: 8px; }
</style>
</head>
<body>
<h1>ScoutX — detector multi-plataforma (dev local, não é produção)</h1>
<form id="f">
  <input id="url" type="text" placeholder="https://loja-concorrente.com" required>
  <button type="submit">Analisar</button>
</form>
<div id="status"></div>
<div id="out"></div>
<script>
const f = document.getElementById('f');
const out = document.getElementById('out');
const status = document.getElementById('status');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value.trim();
  out.innerHTML = '';
  status.textContent = 'Analisando...';
  try {
    const res = await fetch('/api/dev-spy?url=' + encodeURIComponent(url));
    const data = await res.json();
    status.textContent = '';
    render(data, res.ok);
  } catch (err) {
    status.textContent = '';
    out.innerHTML = '<div class="error">Falha de rede: ' + err.message + '</div>';
  }
});
function render(data, ok) {
  const d = data.detection || {};
  let html = '<span class="badge ' + d.platform + '">' + (d.platform || '?') + '</span>';
  html += '<div class="meta">baseUrl: ' + (d.baseUrl || '-') +
    (d.reason ? ' · motivo: ' + d.reason : '') +
    (d.isHostingerAI ? ' · <b>site gerado por IA (Hostinger)</b>' : '') +
    (d.isPixelYourSite ? ' · usa PixelYourSite (pixel FB/TikTok)' : '') + '</div>';
  if (!ok || data.error) {
    html += '<div class="error">' + (data.error || 'Erro desconhecido') + '</div>';
  }
  const r = data.result;
  if (r && Array.isArray(r.products)) {
    html += '<div class="meta">' + r.products.length + ' produtos encontrados';
    if (r.totalCategories !== undefined) html += ' · ' + r.totalCategories + ' categorias';
    if (r.reviewSampleVerifiedRatio !== null && r.reviewSampleVerifiedRatio !== undefined) {
      html += ' · ' + Math.round(r.reviewSampleVerifiedRatio * 100) + '% das avaliações amostradas são verificadas (' + r.reviewSampleSize + ' amostradas)';
    }
    html += '</div>';
    html += '<div class="grid">';
    for (const p of r.products.slice(0, 60)) {
      html += '<div class="card">' +
        (p.mainImageUrl ? '<img src="' + p.mainImageUrl + '" loading="lazy">' : '') +
        '<div class="body"><div class="title">' + escapeHtml(p.title || '') + '</div>' +
        '<div class="price">' + (p.priceMin != null ? '$' + p.priceMin.toFixed(2) : '-') + '</div>' +
        '<div class="sku">SKU: ' + escapeHtml(p.supplierId || '-') + '</div></div></div>';
    }
    html += '</div>';
  }
  html += '<details><summary>JSON completo</summary><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre></details>';
  out.innerHTML = html;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>`);
});

app.get("/api/dev-spy", async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: "Parâmetro 'url' é obrigatório" });

  let safeFetch;
  try {
    safeFetch = await createPinnedFetch(new URL(String(raw).trim()).hostname);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let detection;
  try {
    detection = await detectPlatform(raw, safeFetch);
  } catch (err) {
    return res.status(400).json({ error: "Falha ao detectar plataforma: " + err.message });
  }

  try {
    if (detection.platform === "shopify") {
      const result = await analyzeStore(raw, safeFetch);
      return res.json({ detection, result });
    }
    if (detection.platform === "woocommerce") {
      const result = await analyzeWooCommerceStore(raw, safeFetch, detection);
      return res.json({ detection, result });
    }
    return res.json({ detection, result: null });
  } catch (err) {
    if (err instanceof ShopifyUnsupported || err instanceof WooUnsupported) {
      return res.status(400).json({ detection, error: err.message });
    }
    console.error(err);
    return res.status(502).json({ detection, error: "Erro inesperado ao analisar a loja." });
  }
});

app.listen(PORT, () => {
  console.log(`ScoutX dev-spy rodando em http://localhost:${PORT} (SÓ dev local, não é produção)`);
});
