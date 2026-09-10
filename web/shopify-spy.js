const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; BuscarBarcodeShopify/1.0)",
};

const BESTSELLER_RE = /best[\s-]?sell|m[aá]i?s[\s-]?vendid|top[\s-]?vendas|populares?|trending|escalando/i;
const NEW_RE = /novidad|new[\s-]?arrival|lan[çc]amento|rec[ée]m[\s-]?chegad/i;

class UnsupportedStoreError extends Error {}

function baseUrlFromInput(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new UnsupportedStoreError("URL inválida");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new UnsupportedStoreError("URL inválida");
  }
  return `${url.protocol}//${url.host}`;
}

// Se a loja bloquear/atrasar (rate limit, WAF), não podemos deixar a UI travada
// esperando o timeout padrão de rede (que pode levar bem mais que isso). Cada
// chamada falha rápido e a análise segue com o que já conseguiu buscar.
// `state.rateLimited` é criado do zero a cada chamada de analyzeStore (não é
// global) — senão uma loja bloqueada deixaria TODAS as análises seguintes
// (de qualquer loja) mudas até reiniciar o app.
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url, state) {
  if (state.rateLimited) return null;

  let res;
  try {
    res = await state.fetchImpl(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (res.status === 429) {
    // A loja está limitando nossas requisições: paramos de insistir no resto
    // desta análise em vez de continuar martelando e piorar o bloqueio.
    state.rateLimited = true;
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAllProducts(baseUrl, state, maxPages = 20) {
  const all = [];
  const seenIds = new Set();
  let lastPageFirstId = null;

  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJson(`${baseUrl}/products.json?limit=250&page=${page}`, state);
    const products = data && Array.isArray(data.products) ? data.products : [];
    if (products.length === 0) break;

    // Algumas lojas ignoram o parâmetro "page" e sempre devolvem a primeira página:
    // se a primeira ID da página bater com a da página anterior, paramos aqui.
    if (products[0] && products[0].id === lastPageFirstId) break;
    lastPageFirstId = products[0] ? products[0].id : null;

    for (const p of products) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        all.push(p);
      }
    }

    if (products.length < 250) break;
  }

  return all;
}

async function fetchCollections(baseUrl, state) {
  const data = await fetchJson(`${baseUrl}/collections.json?limit=250`, state);
  return data && Array.isArray(data.collections) ? data.collections : [];
}

async function fetchCollectionProducts(baseUrl, state, handle, limit = 50) {
  const data = await fetchJson(`${baseUrl}/collections/${handle}/products.json?limit=${limit}`, state);
  return data && Array.isArray(data.products) ? data.products : [];
}

function priceRange(variants) {
  const prices = (variants || [])
    .map((v) => parseFloat(v.price))
    .filter((n) => Number.isFinite(n));
  if (prices.length === 0) return { min: null, max: null };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

// Um SKU/barcode de verdade não tem espaço (ex: "A12400M080", "7263"). Se o campo
// contém espaço, é quase sempre uma descrição digitada errado no lugar do código
// (ex: "rache 108 piezas"). Números curtos tipo "-1", "-2", "0" também são
// descartados: apps de importação usam isso como placeholder de posição, não
// como identificador real do produto.
function looksLikeId(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return false;
  if (/\s/.test(v)) return false;
  if (/^-?\d{1,2}$/.test(v)) return false;
  return true;
}

function pickBarcode(variants) {
  for (const v of variants || []) {
    if (looksLikeId(v.barcode)) return v.barcode.trim();
  }
  return "";
}

function pickSku(variants) {
  for (const v of variants || []) {
    if (looksLikeId(v.sku)) return v.sku.trim();
  }
  return "";
}

function pickSupplierId(variants) {
  return pickBarcode(variants) || pickSku(variants);
}

// A listagem em massa do Shopify (/products.json) NUNCA inclui o campo "barcode",
// só "sku" — e o SKU é um campo livre que cada app de importação usa do seu
// jeito (às vezes é o código real, às vezes é um placeholder tipo "-1" ou "v678"
// que não tem como distinguir de um código de verdade só de olhar o formato).
// A única forma confiável de saber o barcode real é buscar a página do produto
// individualmente, igual a aba "Buscar Barcode" faz.
async function fetchRealBarcode(baseUrl, state, handle) {
  const data = await fetchJson(`${baseUrl}/products/${handle}.json`, state);
  const product = data && data.product;
  if (!product) return "";
  return pickBarcode(product.variants);
}

/** Roda `worker` sobre `items` com no máximo `concurrency` chamadas em paralelo. */
async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

function imageKey(src) {
  try {
    const u = new URL(src);
    return u.pathname.toLowerCase();
  } catch {
    return String(src).toLowerCase();
  }
}

/**
 * Agrupa produtos que provavelmente são a MESMA oferta publicada em páginas
 * separadas (mesmo SKU/barcode, ou mesmas imagens reaproveitadas). Isso é um
 * sinal forte de escala: lojas só duplicam a página de um produto com ângulos
 * de copy diferentes quando ele já está vendendo bem.
 */
function clusterDuplicateListings(items) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const bySku = new Map();
  const byImage = new Map();

  items.forEach((it, i) => {
    if (it.supplierId) {
      const arr = bySku.get(it.supplierId) || [];
      arr.push(i);
      bySku.set(it.supplierId, arr);
    }
    for (const key of it.imageKeys) {
      const arr = byImage.get(key) || [];
      arr.push(i);
      byImage.set(key, arr);
    }
  });

  for (const arr of bySku.values()) {
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }
  for (const arr of byImage.values()) {
    if (arr.length > 1) {
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = clusters.get(r) || [];
    arr.push(i);
    clusters.set(r, arr);
  }

  return items.map((it, i) => {
    const cluster = clusters.get(find(i));
    const others = cluster.filter((j) => j !== i).map((j) => ({ title: items[j].title, url: items[j].url }));
    return { duplicatePageCount: cluster.length, duplicatePages: others };
  });
}

// `fetchImpl` vem já fixado (pinned) no IP validado pelo chamador (ver
// safe-fetch.js) — todas as chamadas dessa análise (products.json,
// collections.json, cada produto individual pro barcode real) reusam o
// MESMO endereço já validado, em vez de cada uma resolver DNS de novo (o
// que reabriria a janela de DNS rebinding que o pin existe pra fechar).
// Sem `fetchImpl`, cai no fetch global normal (sem pin) — server.js sempre
// passa o pinned, esse fallback é só rede de segurança pra outro chamador.
async function analyzeStore(rawUrl, fetchImpl) {
  const baseUrl = baseUrlFromInput(rawUrl);
  const state = { rateLimited: false, fetchImpl: fetchImpl || fetch };

  const [products, collections] = await Promise.all([fetchAllProducts(baseUrl, state), fetchCollections(baseUrl, state)]);

  if (products.length === 0 && collections.length === 0) {
    throw new UnsupportedStoreError(
      state.rateLimited
        ? "Esta loja está limitando as requisições agora (rate limit). Espere alguns minutos e tente de novo."
        : "Não foi possível ler o catálogo público desta loja (não parece ser Shopify ou está bloqueada)"
    );
  }

  const signalCollections = collections.filter((c) => BESTSELLER_RE.test(c.title || "") || BESTSELLER_RE.test(c.handle || ""));
  const newArrivalCollections = collections.filter((c) => NEW_RE.test(c.title || "") || NEW_RE.test(c.handle || ""));

  const bestsellerPositions = new Map();
  for (const col of signalCollections.slice(0, 5)) {
    if (state.rateLimited) break;
    const colProducts = await fetchCollectionProducts(baseUrl, state, col.handle, 50);
    colProducts.forEach((p, idx) => {
      const key = p.id;
      const existing = bestsellerPositions.get(key);
      const entry = { collectionTitle: col.title, position: idx + 1 };
      if (!existing || entry.position < existing.position) {
        bestsellerPositions.set(key, entry);
      }
    });
  }

  const base = products.map((p) => {
    const { min, max } = priceRange(p.variants);
    const ageDays = daysSince(p.created_at);
    const updatedDays = daysSince(p.updated_at);
    const variantCount = Array.isArray(p.variants) ? p.variants.length : 0;
    const images = Array.isArray(p.images) ? p.images : [];
    const bestsellerHit = bestsellerPositions.get(p.id);

    const supplierId = pickSupplierId(p.variants);

    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      url: `${baseUrl}/products/${p.handle}`,
      vendor: p.vendor || "",
      supplierId,
      productType: p.product_type || "",
      tags: p.tags || "",
      createdAt: p.created_at || null,
      updatedAt: p.updated_at || null,
      ageDays,
      updatedDays,
      priceMin: min,
      priceMax: max,
      variantCount,
      imageCount: images.length,
      // Só a primeira imagem (capa do produto na listagem) — pedido do
      // usuário pra Espionar Loja mostrar foto igual Produtos já mostra,
      // sem precisar baixar/guardar a galeria inteira de cada produto.
      mainImageUrl: images[0]?.src || null,
      imageKeys: images.map((img) => imageKey(img.src)).filter(Boolean),
      inBestsellerCollection: bestsellerHit ? bestsellerHit.collectionTitle : null,
      bestsellerPosition: bestsellerHit ? bestsellerHit.position : null,
    };
  });

  // Algumas lojas usam o mesmo SKU "placeholder" (ex: sequência "-1", "-2"...)
  // em dezenas de produtos sem relação nenhuma entre si. Se um "ID" se repete
  // em muitos produtos diferentes, não é um identificador de verdade — zeramos
  // ele pra não aparecer como ID nem contar como sinal de página duplicada.
  const SUPPLIER_ID_JUNK_THRESHOLD = 6;
  const supplierIdFreq = new Map();
  for (const p of base) {
    if (p.supplierId) supplierIdFreq.set(p.supplierId, (supplierIdFreq.get(p.supplierId) || 0) + 1);
  }
  for (const p of base) {
    if (p.supplierId && supplierIdFreq.get(p.supplierId) > SUPPLIER_ID_JUNK_THRESHOLD) {
      p.supplierId = "";
    }
  }

  // O SKU acima veio da listagem em massa, que não tem o campo "barcode" — e o
  // SKU é um campo livre que cada app de importação usa do seu jeito (às vezes
  // é o código real, às vezes um placeholder tipo "-1" ou "v678" indistinguível
  // de um código de verdade só pelo formato). Por isso buscamos o barcode
  // verdadeiro de CADA produto individualmente (mesma rota da aba "Buscar
  // Barcode") e, quando existir, ele sempre substitui o valor da listagem em
  // massa. Fica mais lento em lojas grandes, então roda em paralelo com um
  // limite de conexões simultâneas pra não sobrecarregar o site.
  const ENRICH_CAP = 600;
  if (!state.rateLimited) {
    const toEnrich = base.slice(0, ENRICH_CAP);
    await runWithConcurrency(toEnrich, 6, async (p) => {
      const realBarcode = await fetchRealBarcode(baseUrl, state, p.handle);
      if (realBarcode) p.supplierId = realBarcode;
    });
  }

  const dupInfo = clusterDuplicateListings(base);

  const enriched = base.map((p, i) => {
    const { duplicatePageCount, duplicatePages } = dupInfo[i];

    let score = 0;
    if (p.inBestsellerCollection) score += Math.max(1, 4 - Math.floor(p.bestsellerPosition / 15));
    if (p.ageDays !== null && p.ageDays <= 45) score += 2;
    if (p.updatedDays !== null && p.updatedDays <= 14 && p.ageDays !== p.updatedDays) score += 1;
    if (p.variantCount >= 4) score += 1;
    if (p.imageCount >= 5) score += 1;
    if (duplicatePageCount >= 2) score += 3 + (duplicatePageCount - 2);

    const { imageKeys, updatedDays, ...rest } = p;
    return { ...rest, duplicatePageCount, duplicatePages, score };
  });

  enriched.sort((a, b) => b.score - a.score);

  const vendorCounts = new Map();
  for (const p of enriched) {
    const key = p.vendor || "(sem fornecedor informado)";
    vendorCounts.set(key, (vendorCounts.get(key) || 0) + 1);
  }
  const vendorsBreakdown = [...vendorCounts.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    .sort((a, b) => b.count - a.count);

  return {
    baseUrl,
    totalProducts: products.length,
    totalCollections: collections.length,
    totalVendors: vendorsBreakdown.length,
    totalDuplicatedListings: enriched.filter((p) => p.duplicatePageCount >= 2).length,
    vendorsBreakdown,
    collections: collections.map((c) => ({ title: c.title, handle: c.handle, url: `${baseUrl}/collections/${c.handle}` })),
    bestsellerCollectionsUsed: signalCollections.map((c) => c.title),
    newArrivalCollections: newArrivalCollections.map((c) => ({ title: c.title, url: `${baseUrl}/collections/${c.handle}` })),
    products: enriched,
  };
}

module.exports = { analyzeStore, UnsupportedStoreError };
