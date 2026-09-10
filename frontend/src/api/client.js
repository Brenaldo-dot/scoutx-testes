export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function buildQuery(params = {}) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  )
  return new URLSearchParams(clean).toString()
}

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    // FastAPI devolve o erro como JSON ({"detail": "..."}) — sem isso, o
    // texto cru (incluindo as chaves/aspas do JSON) aparecia direto na tela
    // pra pessoa (ex: no aviso de "concorrente já cadastrado"), em vez da
    // mensagem legível que o back escreveu. Mesmo padrão já usado em
    // rawClient.js pro lado Node (lá a chave é "error", não "detail").
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) message = body.detail
    } catch {
      // resposta sem JSON — mantém a mensagem padrão
    }
    throw new Error(message)
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  getDashboardSummary: (params = {}) => request(`/api/dashboard/summary?${buildQuery(params)}`),
  getDashboardHighlights: (params = {}) => request(`/api/dashboard/highlights?${buildQuery(params)}`),
  getActivityHeatmap: (params = {}) => request(`/api/dashboard/activity-heatmap?${buildQuery(params)}`),
  getAlertsByCompetitor: (params = {}) => request(`/api/dashboard/alerts-by-competitor?${buildQuery(params)}`),
  getAlertsByCategory: (params = {}) => request(`/api/dashboard/alerts-by-category?${buildQuery(params)}`),
  getNewProductsTimeline: (params = {}) => request(`/api/dashboard/new-products-timeline?${buildQuery(params)}`),
  getAdsTimeline: (params = {}) => request(`/api/dashboard/ads-timeline?${buildQuery(params)}`),
  getScoreDistribution: (params = {}) => request(`/api/dashboard/score-distribution?${buildQuery(params)}`),

  listCompetitors: (params = {}) => request(`/api/competitors?${buildQuery(params)}`),
  getCompetitor: (id) => request(`/api/competitors/${id}`),
  createCompetitor: (data) => request('/api/competitors', { method: 'POST', body: JSON.stringify(data) }),
  updateCompetitor: (id, data) => request(`/api/competitors/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCompetitor: (id) => request(`/api/competitors/${id}`, { method: 'DELETE' }),
  rescanAds: (id) => request(`/api/competitors/${id}/rescan-ads`, { method: 'POST' }),
  rescoreCompetitor: (id) => request(`/api/competitors/${id}/rescore`, { method: 'POST' }),
  getCompetitorSummaryByUser: () => request('/api/competitors/summary-by-user'),
  getMyOperationsLimit: () => request('/api/competitors/my-operations-limit'),
  searchCompetitorTrackers: (q) => request(`/api/competitors/search-trackers?${buildQuery({ q })}`),
  getOperationsUsage: (userIds) => request(`/api/competitors/operations-usage?${buildQuery({ user_ids: userIds.join(',') })}`),
  claimOrphanedCompetitors: () => request('/api/competitors/claim-orphaned', { method: 'POST' }),
  listProtectedStores: () => request('/api/competitors/protected-stores'),
  addProtectedStore: (data) => request('/api/competitors/protected-stores', { method: 'POST', body: JSON.stringify(data) }),
  removeProtectedStore: (id) => request(`/api/competitors/protected-stores/${id}`, { method: 'DELETE' }),
  runRetentionNow: () => request('/api/competitors/run-retention-now', { method: 'POST' }),
  getCeleryDiagnostics: () => request('/api/competitors/celery-diagnostics'),

  listProducts: (params = {}) => request(`/api/products?${buildQuery(params)}`),
  listHotProducts: (params = {}) => request(`/api/products/hot?${buildQuery(params)}`),
  getProduct: (id) => request(`/api/products/${id}`),
  productPreviewUrl: (id) => `${API_URL}/api/products/${id}/preview`,

  listAds: (params = {}) => request(`/api/ads?${buildQuery(params)}`),

  listAlerts: (params = {}) => request(`/api/alerts?${buildQuery(params)}`),
  getAlertCounts: (params = {}) => request(`/api/alerts/counts?${buildQuery(params)}`),

  sharedVendors: (minStores = 2) => request(`/api/ecosystem/shared-vendors?${buildQuery({ min_stores: minStores })}`),

  createAdMinerScan: (url, operation) =>
    request('/api/ad-miner/scans', { method: 'POST', body: JSON.stringify({ url, operation }) }),
  getAdMinerScan: (id) => request(`/api/ad-miner/scans/${id}`),

  getDiscordWebhook: () => request('/api/settings/discord'),
  setDiscordWebhook: (url) =>
    request('/api/settings/discord', { method: 'PUT', body: JSON.stringify({ discord_webhook_url: url }) }),
  removeDiscordWebhook: () => request('/api/settings/discord', { method: 'DELETE' }),
  testDiscordWebhook: () => request('/api/settings/discord/test', { method: 'POST' }),
}
