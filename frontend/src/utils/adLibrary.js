// Mesmo mapeamento de services/competitor_service.py:country_for_operation
// no backend (e de CompetitorDetail.jsx) — usado aqui pra montar um link de
// busca por DOMÍNIO como reserva, pra quando ainda não existe um link direto
// pro anúncio específico (product_id ainda não casado com nenhum Ad — ver
// api/products.py). Buscar pelo domínio da loja sempre funciona; buscar
// pelo NOME (ex: "Guffo", o fornecedor mostrado na tabela) não — confirmado
// pelo usuário testando ao vivo.
export const OPERATION_COUNTRY = { colombia: 'CO', mexico: 'MX', equador: 'EC', guatemala: 'GT', espanha: 'ES' }

export function metaAdsLibrarySearchUrl(domain, operation) {
  if (!domain) return null
  const country = OPERATION_COUNTRY[operation] || 'CO'
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    q: domain,
    search_type: 'keyword_unordered',
  })
  return `https://www.facebook.com/ads/library/?${params.toString()}`
}
