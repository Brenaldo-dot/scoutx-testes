// Extrai catálogo público de lojas WooCommerce via /wp-json/wc/store/v1/*
// (a mesma API que o carrinho/checkout do próprio tema WooCommerce usa —
// pública por padrão, sem precisar de chave de API). Confirmado ao vivo em
// bellamexico.shop: SKU, preço, descrição, imagens, categorias, avaliações
// e estoque vêm todos daqui sem autenticação nenhuma.
//
// NÃO tenta passar por desafio anti-bot (tela "Checking your browser...")
// — decisão consciente por enquanto: isso exigiria rodar um navegador de
// verdade no servidor (Playwright/Puppeteer), o que muda bastante o custo
// de infra. Loja atrás desse desafio aparece como platform-detect.js
// reportando "unknown"/"anti_bot_challenge" antes de chegar aqui.
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; ScoutXWooCommerceSpy/1.0)",
};
const FETCH_TIMEOUT_MS = 8000;

class UnsupportedStoreError extends Error {}

async function fetchJson(url, state) {
  if (state.rateLimited) return null;
  let res;
  try {
    res = await state.fetchImpl(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (res.status === 429) {
    state.rateLimited = true;
    return null;
  }
  if (!res.ok) return null;
  try {
    return { json: await res.json(), headers: res.headers };
  } catch {
    return null;
  }
}

async function fetchAllProducts(baseUrl, state, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchJson(`${baseUrl}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, state);
    if (!result || !Array.isArray(result.json) || result.json.length === 0) break;
    all.push(...result.json);
    const totalPages = Number(result.headers.get("x-wp-totalpages") || 0);
    if (page >= totalPages || result.json.length < 100) break;
  }
  return all;
}

async function fetchCategories(baseUrl, state) {
  const result = await fetchJson(`${baseUrl}/wp-json/wc/store/v1/products/categories?per_page=100`, state);
  return result && Array.isArray(result.json) ? result.json : [];
}

async function fetchReviewSample(baseUrl, state, size = 20) {
  const result = await fetchJson(`${baseUrl}/wp-json/wc/store/v1/products/reviews?per_page=${size}`, state);
  return result && Array.isArray(result.json) ? result.json : [];
}

// A Store API devolve o preço já multiplicado pela unidade mínima da moeda
// (ex: "99900" com currency_minor_unit=2 quer dizer $999.00) — sem dividir,
// todo preço apareceria 100x maior do que é.
function toDecimalPrice(minorUnitsStr, currencyMinorUnit) {
  const n = parseFloat(minorUnitsStr);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, currencyMinorUnit ?? 2);
}

// A Store API devolve nome/SKU/categoria com entidades HTML cruas (ex:
// "&#8211;" no lugar de "–") porque o WordPress guarda título como HTML —
// sem decodificar, a UI mostraria o código da entidade em vez do símbolo.
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", nbsp: " " };
function decodeHtmlEntities(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => HTML_ENTITIES[name] ?? m);
}

// SKU nessa plataforma costuma ser um slug digitado pelo lojista (ex:
// "2×1-base-bioaqua"), não um código de fornecedor de verdade como o
// barcode da Shopify — mas ainda é o único identificador público
// disponível, então extraímos mesmo assim e deixamos a UI decidir como
// rotular.
function pickSupplierId(sku) {
  return decodeHtmlEntities(sku).trim();
}

async function analyzeWooCommerceStore(rawUrl, fetchImpl, detection = {}) {
  const baseUrl = detection.baseUrl || new URL(String(rawUrl).trim()).origin;
  const state = { rateLimited: false, fetchImpl: fetchImpl || fetch };

  const products = await fetchAllProducts(baseUrl, state);
  if (products.length === 0) {
    throw new UnsupportedStoreError(
      state.rateLimited
        ? "Esta loja está limitando as requisições agora (rate limit). Espere alguns minutos e tente de novo."
        : "Não foi possível ler o catálogo público desta loja WooCommerce."
    );
  }

  const [categories, reviewSample] = await Promise.all([fetchCategories(baseUrl, state), fetchReviewSample(baseUrl, state)]);

  const verifiedReviews = reviewSample.filter((r) => r.verified).length;

  const enriched = products.map((p) => {
    const prices = p.prices || {};
    const priceMin = toDecimalPrice(prices.price, prices.currency_minor_unit);
    const regularPrice = toDecimalPrice(prices.regular_price, prices.currency_minor_unit);
    const images = Array.isArray(p.images) ? p.images : [];
    const categoryNames = (p.categories || []).map((c) => c.name);

    return {
      id: p.id,
      title: decodeHtmlEntities(p.name),
      handle: p.slug,
      url: p.permalink,
      vendor: "",
      supplierId: pickSupplierId(p.sku),
      productType: categoryNames.map(decodeHtmlEntities).join(", "),
      tags: (p.tags || []).map((t) => decodeHtmlEntities(t.name)).join(", "),
      createdAt: null, // Store API não devolve data de criação
      updatedAt: null,
      priceMin,
      priceMax: regularPrice && regularPrice > priceMin ? regularPrice : priceMin,
      variantCount: Array.isArray(p.variations) && p.variations.length > 0 ? p.variations.length : 1,
      imageCount: images.length,
      mainImageUrl: images[0]?.src || null,
      inStock: !!p.is_in_stock,
      averageRating: p.average_rating ? parseFloat(p.average_rating) : null,
      reviewCount: p.review_count || 0,
    };
  });

  return {
    baseUrl,
    platform: "woocommerce",
    isHostingerAI: !!detection.isHostingerAI,
    isPixelYourSite: !!detection.isPixelYourSite,
    totalProducts: products.length,
    totalCategories: categories.length,
    categories: categories.map((c) => ({ title: decodeHtmlEntities(c.name), handle: c.slug, count: c.count, url: c.permalink })),
    // Amostra pequena (não é o total real de avaliações da loja, só do que
    // conseguimos ler numa página) — sinal de quanto da prova social parece
    // verificada de verdade vs. plantada.
    reviewSampleSize: reviewSample.length,
    reviewSampleVerifiedRatio: reviewSample.length > 0 ? verifiedReviews / reviewSample.length : null,
    products: enriched,
  };
}

module.exports = { analyzeWooCommerceStore, UnsupportedStoreError };
