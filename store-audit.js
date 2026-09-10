#!/usr/bin/env node
/**
 * store-audit.js — auditoria de dados PUBLICOS expostos por uma loja WordPress/WooCommerce.
 * Feito para a loja do proprio dono, para descobrir o que qualquer visitante/concorrente
 * consegue puxar sem login, sem senha e sem contornar nenhuma protecao.
 *
 * Uso:
 *   node store-audit.js <https://dominio.com>
 *
 * Gera um relatorio em texto no stdout e um JSON em ./audit-output.json
 */

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) {
  console.error("Uso: node store-audit.js <https://dominio.com>");
  process.exit(1);
}

const UA = { "User-Agent": "Mozilla/5.0 (store-audit self-scan tool)" };

async function get(path) {
  try {
    const res = await fetch(base + path, { headers: UA });
    const text = await res.text();
    return { status: res.status, text, headers: Object.fromEntries(res.headers) };
  } catch (e) {
    return { status: 0, text: "", error: e.message };
  }
}

async function main() {
  const report = { base, generatedAt: new Date().toISOString(), findings: {} };

  // 1. robots.txt + sitemap
  const robots = await get("/robots.txt");
  report.findings.robots = { status: robots.status, body: robots.text };

  const sitemapIndex = await get("/wp-sitemap.xml");
  const sitemapUrls = [...sitemapIndex.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  report.findings.sitemapIndex = { status: sitemapIndex.status, sitemaps: sitemapUrls };

  // 2. wp-json root -> namespaces (which plugins expose REST APIs)
  const wpjson = await get("/wp-json/");
  let namespaces = [];
  try { namespaces = JSON.parse(wpjson.text).namespaces || []; } catch {}
  report.findings.restNamespaces = namespaces;

  // 3. User enumeration (real vulnerability if it returns emails/usernames)
  const users = await get("/wp-json/wp/v2/users");
  let userLeak = null;
  try {
    const parsed = JSON.parse(users.text);
    if (Array.isArray(parsed) && parsed.length) {
      userLeak = parsed.map(u => ({ id: u.id, slug: u.slug, name: u.name, is_super_admin: u.is_super_admin }));
    }
  } catch {}
  report.findings.userEnumeration = { status: users.status, leaked: userLeak };

  // 4. Users sitemap (separate leak path even if REST API is later locked down)
  const usersSitemap = await get("/wp-sitemap-users-1.xml");
  const authorUrls = [...usersSitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  report.findings.usersSitemap = { status: usersSitemap.status, authorUrls };

  // 5. WordPress version disclosure
  const readme = await get("/readme.html");
  report.findings.readmeExposed = { status: readme.status };

  // 6. xmlrpc.php reachable (brute-force / amplification vector if enabled)
  const xmlrpc = await get("/xmlrpc.php");
  report.findings.xmlrpc = { status: xmlrpc.status, reachable: xmlrpc.status !== 404 };

  // 7. Common sensitive file exposure
  const sensitiveFiles = ["wp-config.php.bak", "wp-config.php~", ".env", ".env.bak", "wp-content/debug.log", ".git/config"];
  report.findings.sensitiveFiles = {};
  for (const f of sensitiveFiles) {
    const r = await get("/" + f);
    report.findings.sensitiveFiles[f] = r.status;
  }

  // 8. Theme / plugin fingerprint from homepage HTML
  const home = await get("/");
  const assetPaths = [...new Set([...home.text.matchAll(/wp-content\/(plugins|themes)\/([a-zA-Z0-9_-]+)/g)].map(m => `${m[1]}/${m[2]}`))];
  report.findings.detectedPluginsThemes = assetPaths;

  const pixelIds = [...new Set([...home.text.matchAll(/fbq\('init',\s*'(\d+)'\)/g)].map(m => m[1]))];
  report.findings.facebookPixelIds = pixelIds;

  const gaIds = [...new Set([...home.text.matchAll(/(G-[A-Z0-9]+|UA-\d+-\d+)/g)].map(m => m[1]))];
  report.findings.googleAnalyticsIds = gaIds;

  // 9. Public WooCommerce Store API — full catalog, no auth required by design
  const storeApiFirst = await get("/wp-json/wc/store/v1/products?per_page=1");
  const totalProducts = storeApiFirst.headers?.["x-wp-total"] || null;
  report.findings.wooCommerceStoreApi = {
    status: storeApiFirst.status,
    totalProductsExposed: totalProducts,
    note: "API publica por design do WooCommerce — qualquer visitante pode listar todo o catalogo (preco, estoque, SKU, descricao) sem autenticacao.",
  };

  // Pull full catalog (paginated) for the file the user asked for
  const allProducts = [];
  if (storeApiFirst.status === 200 && totalProducts) {
    const totalPages = Math.ceil(Number(totalProducts) / 20);
    for (let page = 1; page <= totalPages; page++) {
      const r = await get(`/wp-json/wc/store/v1/products?per_page=20&page=${page}`);
      try {
        const items = JSON.parse(r.text);
        for (const p of items) {
          allProducts.push({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: p.prices?.price,
            currency: p.prices?.currency_code,
            stock_status: p.is_in_stock ? "in_stock" : "out_of_stock",
            permalink: p.permalink,
          });
        }
      } catch {}
    }
  }
  report.findings.fullPublicCatalog = allProducts;

  // ---- print human-readable report ----
  console.log(`\n===== AUDITORIA DE DADOS PUBLICOS: ${base} =====\n`);

  console.log("[1] robots.txt / sitemap");
  console.log(`    status: ${robots.status}, sitemaps encontrados: ${sitemapUrls.length}`);

  console.log("\n[2] APIs REST expostas (namespaces)");
  console.log(`    ${namespaces.length} namespaces publicos, incluindo: ${namespaces.slice(0, 8).join(", ")}...`);

  console.log("\n[3] VAZAMENTO — enumeracao de usuario via /wp-json/wp/v2/users");
  if (userLeak) {
    console.log(`    ENCONTRADO: ${JSON.stringify(userLeak)}`);
    console.log("    -> O 'name' e 'slug' do admin revelam o e-mail pessoal publicamente.");
    console.log("    -> RECOMENDACAO: trocar o 'display name' do usuario admin (nao usar o email),");
    console.log("       e considerar plugin que desative /wp/v2/users para visitantes anonimos.");
  } else {
    console.log("    nenhum usuario exposto (bom sinal)");
  }

  console.log("\n[4] VAZAMENTO — sitemap de usuarios (/wp-sitemap-users-1.xml)");
  console.log(`    status: ${usersSitemap.status}, URLs: ${authorUrls.join(", ") || "nenhuma"}`);
  if (authorUrls.length) console.log("    -> Mesmo problema do item 3, por uma via diferente (sitemap, nao REST API).");

  console.log("\n[5] Divulgacao de versao (readme.html)");
  console.log(`    status: ${readme.status} ${readme.status === 200 ? "-> readme.html acessivel, pode revelar versao do WP" : ""}`);

  console.log("\n[6] xmlrpc.php");
  console.log(`    status: ${xmlrpc.status} ${xmlrpc.status !== 404 ? "-> endpoint ativo (potencial vetor de brute-force/DDoS amplification se nao protegido)" : "-> desativado/bloqueado"}`);

  console.log("\n[7] Arquivos sensiveis comuns");
  for (const [f, s] of Object.entries(report.findings.sensitiveFiles)) {
    console.log(`    ${f}: HTTP ${s} ${s === 200 ? "!! EXPOSTO !!" : "(ok, bloqueado/nao existe)"}`);
  }

  console.log("\n[8] Stack detectada (plugins/tema)");
  console.log(`    ${assetPaths.join(", ")}`);
  console.log(`    Facebook Pixel ID(s): ${pixelIds.join(", ") || "nenhum"}`);
  console.log(`    Google Analytics ID(s): ${gaIds.join(", ") || "nenhum"}`);

  console.log("\n[9] Catalogo publico via WooCommerce Store API");
  console.log(`    Total de produtos expostos sem autenticacao: ${totalProducts}`);
  console.log(`    (preco, SKU, estoque, descricao completa de cada um — dado publico por design do WooCommerce)`);

  console.log(`\n===== FIM — ver audit-output.json para o dump completo (inclui os ${allProducts.length} produtos) =====\n`);

  const fs = await import("fs");
  fs.writeFileSync(new URL("./audit-output.json", import.meta.url), JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
