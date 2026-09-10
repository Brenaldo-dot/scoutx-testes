// Cliente separado do client.js: aquele prefixa toda chamada com API_URL
// (`/api/minerador` em produção, indo pro FastAPI). As rotas herdadas do
// app Node (login, /api/me, /api/buscar, /api/spy, /api/admin/*,
// /api/history*) são Express puro, no MESMO domínio, sem esse prefixo — daí
// precisar de um client à parte. Caminho relativo funciona tanto hoje (App
// servido em /minerador) quanto depois da fusão (App servido na raiz), já
// que é sempre resolvido a partir da raiz do domínio, não da rota atual.
async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      // resposta sem JSON — mantém a mensagem padrão
    }
    throw new Error(message)
  }
  if (res.status === 204) return null
  return res.json()
}

function qs(params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  return new URLSearchParams(clean).toString()
}

export const rawApi = {
  me: () => request('/api/me'),
  setDefaultOperation: (value, { force = false } = {}) =>
    request('/api/me/default-operation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, force }),
    }),
  changeMyPassword: (currentPassword, newPassword) =>
    request('/api/me/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  updateMyAvatar: (avatarDataUrl) =>
    request('/api/me/avatar', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarDataUrl }),
    }),
  removeMyAvatar: () => request('/api/me/avatar', { method: 'DELETE' }),
  updateMyName: (name) =>
    request('/api/me/name', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  listAffiliates: () => request('/api/admin/affiliates'),
  createAffiliate: (data) =>
    request('/api/admin/affiliates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  deleteAffiliate: (id) => request(`/api/admin/affiliates/${id}`, { method: 'DELETE' }),
  listAffiliateCommissions: () => request('/api/admin/affiliate-commissions'),
  markAffiliateCommissionPaid: (id, paid) =>
    request(`/api/admin/affiliate-commissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid }),
    }),

  getMyReferral: () => request('/api/referral/me'),
  requestReferralCoupon: (pixKey, whatsapp) =>
    request('/api/referral/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pixKey, whatsapp }),
    }),
  updateReferralPix: (pixKey) =>
    request('/api/referral/pix', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixKey }) }),
  updateReferralWhatsapp: (whatsapp) =>
    request('/api/referral/whatsapp', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whatsapp }) }),

  listReferrals: () => request('/api/admin/referrals'),
  activateReferral: (id, couponCode) =>
    request(`/api/admin/referrals/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ couponCode }),
    }),
  listReferralCommissions: () => request('/api/admin/referral-commissions'),
  markReferralCommissionPaid: (id, paid) =>
    request(`/api/admin/referral-commissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid }),
    }),

  getCommunityStatus: () => request('/api/community/status'),
  setupCommunity: (name, photoUrl) =>
    request('/api/community/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, photoUrl }) }),
  listCommunityDirectory: () => request('/api/community/directory'),
  joinCommunity: (communityId) =>
    request('/api/community/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ communityId }) }),
  getCommunity: (id, { channelId, sort } = {}) => request(`/api/community/${id}?${qs({ channelId, sort })}`),
  updateCommunity: (id, { name, description, photoUrl }) =>
    request(`/api/community/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, photoUrl }) }),
  createCommunityChannel: (id, name, groupName) =>
    request(`/api/community/${id}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, groupName }) }),
  deleteCommunityChannel: (channelId) => request(`/api/community/channels/${channelId}`, { method: 'DELETE' }),
  createCommunityPost: (id, channelId, body, imageUrl) =>
    request(`/api/community/${id}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId, body, imageUrl }) }),
  updateCommunityPost: (postId, body, imageUrl) =>
    request(`/api/community/posts/${postId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, imageUrl }) }),
  deleteCommunityPost: (postId) => request(`/api/community/posts/${postId}`, { method: 'DELETE' }),
  toggleCommunityPostPin: (postId) => request(`/api/community/posts/${postId}/pin`, { method: 'POST' }),
  createCommunityComment: (postId, body) =>
    request(`/api/community/posts/${postId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }),
  toggleCommunityPostLike: (postId) => request(`/api/community/posts/${postId}/like`, { method: 'POST' }),

  listAdminCommunities: () => request('/api/admin/communities'),
  listCommunityCommissions: () => request('/api/admin/community-commissions'),
  markCommunityCommissionPaid: (id, paid) =>
    request(`/api/admin/community-commissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid }),
    }),

  buscarBarcode: (url) => request(`/api/buscar?${qs({ url })}`),
  espionarLoja: (url) => request(`/api/spy?${qs({ url })}`),
  spyPreviewUrl: (url) => `/api/spy-preview?${qs({ url })}`,

  listHistoryUsers: () => request('/api/history'),
  getHistoryDetail: (userId) => request(`/api/history/${userId}`),

  listUsers: () => request('/api/admin/users'),
  getUserIps: (id) => request(`/api/admin/users/${id}/ips`),
  listAuditLog: () => request('/api/admin/audit-log'),
  createUser: (data) => request('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  deleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),

  listOrganizations: () => request('/api/admin/organizations'),
  createOrganization: (data) => request('/api/admin/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  updateOrganization: (id, data) => request(`/api/admin/organizations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  deleteOrganization: (id) => request(`/api/admin/organizations/${id}`, { method: 'DELETE' }),
}
