// Cliente da API pública da Cakto (docs.cakto.com.br) — usado pra puxar
// detalhes de um pedido depois que o webhook avisa que ele existe, já que o
// webhook em si (ver cakto.js) NÃO manda informação de afiliado nenhuma, só
// customer/product/offer/subscription. A API de Pedidos manda mais: cada
// pedido vem com `commissionedUsers` (quem recebe comissão) e `commissions`
// (tipo — producer/coproducer/affiliate — + percentual/valor calculado pela
// PRÓPRIA Cakto). A gente usa isso só pra DESCOBRIR quem é o afiliado da
// venda; o valor de comissão que pagamos de verdade é calculado por nós
// mesmos (ver affiliateService.js), não o que a Cakto calcula, porque ela só
// suporta uma taxa única por produto (achado ao vivo, 2026-08-31 — não dá
// pra configurar % diferente pra primeira venda vs. recorrência lá).

const TOKEN_URL = "https://api.cakto.com.br/public_api/token/";
const API_BASE = "https://api.cakto.com.br/public_api";

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }
  const clientId = process.env.CAKTO_CLIENT_ID;
  const clientSecret = process.env.CAKTO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("CAKTO_CLIENT_ID/CAKTO_CLIENT_SECRET não configurados.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Falha ao autenticar na API da Cakto (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // expires_in vem em segundos (documentado ~36000 = 10h) — cacheia em
  // memória do processo, sem persistir em banco (token de vida curta, não
  // vale a pena).
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function caktoFetch(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cakto API ${path} devolveu ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Lista pedidos (paginado) — usado principalmente pra achar o pedido
// específico de uma compra (por refId/id) quando o webhook não manda todo
// mundo que recebe comissão.
function listOrders(params = {}) {
  return caktoFetch("/orders/", params);
}

function getOrder(orderId) {
  return caktoFetch(`/orders/${orderId}/`);
}

module.exports = { getAccessToken, listOrders, getOrder };
