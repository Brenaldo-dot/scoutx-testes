#!/usr/bin/env node
/**
 * product-scout.js — extrai dados PUBLICOS (visiveis a qualquer visitante) de uma
 * pagina de produto WooCommerce ou Shopify.
 *
 * Uso:
 *   node product-scout.js <url-do-produto>
 *
 * O que extrai (tudo visivel no HTML publico, sem login/API key):
 *   - preco, status de estoque
 *   - SKU (identificador interno que o proprio dono cadastrou — nao aponta pra fornecedor)
 *   - avaliacoes (nota media, contagem)
 *   - Facebook Pixel IDs / plugins de tracking detectados na pagina
 *   - plataforma (WooCommerce / Shopify / outra)
 *
 * O que NAO extrai (porque nao existe publicamente em nenhuma loja):
 *   - faturamento, receita, numero real de vendas
 *   - fornecedor de dropshipping (a menos que o tema exponha isso explicitamente
 *     no HTML do produto, o que este script tambem tenta detectar se existir)
 *
 * Rode uma loja/produto por vez. Nao foi feito para varredura em massa do mercado.
 */

const url = process.argv[2];
if (!url) {
  console.error("Uso: node product-scout.js <url-do-produto>");
  process.exit(1);
}

async function main() {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (product-scout research tool)" } });
  if (!res.ok) {
    console.error(`Falha ao carregar (${res.status}): ${url}`);
    process.exit(1);
  }
  const html = await res.text();

  const platform = /wp-content\/plugins\/woocommerce/i.test(html)
    ? "WooCommerce"
    : /cdn\.shopify\.com|Shopify\.theme/i.test(html)
    ? "Shopify"
    : "desconhecida";

  const priceMatch = html.match(/woocommerce-Price-amount[^>]*>\s*<bdi>([^<]+)<\/bdi>/i)
    || html.match(/"price":"([\d.,]+)"/);
  const price = priceMatch ? priceMatch[1].trim() : null;

  const stockOut = /out-of-stock|Agotado|Sin existencias|sold out/i.test(html);
  const stockIn = /in-stock|En existencia/i.test(html);
  const stock = stockOut ? "esgotado" : stockIn ? "em estoque" : "nao detectado";

  const skuMatch = html.match(/data_product_sku="([^"]+)"/) || html.match(/SKU:\s*<span[^>]*>([^<]+)</i);
  const sku = skuMatch ? skuMatch[1].trim() : null;

  const ratingMatch = html.match(/rating[^"]*"\s*content="([\d.]+)"/) || html.match(/(\d(?:\.\d)?) de 5/);
  const reviewCountMatch = html.match(/(\d+)\s*(?:avaliaç|calificaci|review)/i);
  const rating = ratingMatch ? ratingMatch[1] : null;
  const reviewCount = reviewCountMatch ? reviewCountMatch[1] : null;

  const pixelIds = [...html.matchAll(/fbq\('init',\s*'(\d+)'\)/g)].map(m => m[1]);
  const uniquePixelIds = [...new Set(pixelIds)];

  const plugins = [];
  if (/pixelyoursite/i.test(html)) plugins.push("PixelYourSite");
  if (/woocommerce/i.test(html)) plugins.push("WooCommerce");
  if (/elementor/i.test(html)) plugins.push("Elementor");

  // Tenta achar sinal de "unidades vendidas" (badge de urgencia) — quando existe,
  // NAO e dado real de vendas, e sim um numero configurado manualmente pelo dono
  // da loja em algum plugin de FOMO/urgencia.
  const soldBadgeMatch = html.match(/(\d+)\s*(?:pessoas? )?(?:compraram|vendidos?|sold)/i);
  const soldBadge = soldBadgeMatch ? soldBadgeMatch[1] : null;

  console.log(`\n=== ${url} ===`);
  console.log(`Plataforma:        ${platform}`);
  console.log(`Preco:             ${price ?? "nao encontrado"}`);
  console.log(`Estoque:           ${stock}`);
  console.log(`SKU:               ${sku ?? "nao encontrado"}`);
  console.log(`Avaliacao:         ${rating ?? "n/d"} (${reviewCount ?? "?"} avaliacoes)`);
  console.log(`Facebook Pixel(s): ${uniquePixelIds.length ? uniquePixelIds.join(", ") : "nenhum detectado"}`);
  console.log(`Plugins/stack:     ${plugins.length ? plugins.join(", ") : "nenhum detectado"}`);
  console.log(`Badge "vendidos":  ${soldBadge ? soldBadge + " (atencao: normalmente configurado manualmente, nao e dado real de vendas)" : "nao encontrado"}`);
  console.log(`\nNota: faturamento real e numero real de vendas NAO ficam expostos publicamente`);
  console.log(`em nenhuma loja WooCommerce ou Shopify — isso nao existe no HTML de nenhuma pagina.`);
}

main().catch(err => {
  console.error("Erro:", err.message);
  process.exit(1);
});
