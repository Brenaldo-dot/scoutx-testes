import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Image as ImageIcon, Users } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import TierBadge from '../components/TierBadge.jsx'
import { formatDateTime } from '../utils/date.js'
import { resizeImageToDataUrl } from '../utils/avatar.js'

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none'

function money(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Só pra o admin criar a comunidade em nome de um afiliado sem precisar
// logar como ele (o fluxo normal é o próprio embaixador criar a dele em
// /comunidade, isso aqui é um atalho pra já deixar pronta).
function NewCommunityForm({ affiliates, onCreated }) {
  const [affiliateId, setAffiliateId] = useState('')
  const [name, setName] = useState('')
  const [photoUrl, setPhotoUrl] = useState(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setPhotoUrl(await resizeImageToDataUrl(file, 400, 0.85))
    } catch (err) {
      setError(err.message)
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!affiliateId || !name.trim()) return
    setCreating(true)
    setError(null)
    try {
      await rawApi.createCommunityForAffiliate(Number(affiliateId), name.trim(), photoUrl)
      setAffiliateId('')
      setName('')
      setPhotoUrl(null)
      onCreated()
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Criar comunidade pra um afiliado</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Afiliado</label>
          <select required value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)} className={inputClass}>
            <option value="">Selecione…</option>
            {affiliates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.cakto_email})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Nome da comunidade</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Comunidade Samuel Laviero" className={inputClass} />
        </div>
        <label className="flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-surface-2)] text-[var(--text-faint)] hover:border-brand-500" title="Foto (opcional)">
          {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={15} />}
          <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
        </label>
        <button
          type="submit"
          disabled={creating || !affiliateId || !name.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {creating ? 'Criando…' : 'Criar comunidade'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </form>
  )
}

function tierForCount(count) {
  if (count <= 15) return 'gold'
  if (count <= 25) return 'platinum'
  return 'diamond'
}

// Junta a lista de comunidades com as comissões geradas por cada uma —
// mesmo padrão de Afiliados.jsx/AdminIndicacoes.jsx.
function summarize(communities, commissions) {
  return (communities || []).map((c) => {
    const own = (commissions || []).filter((m) => m.community_name === c.community_name)
    const pending = own.filter((m) => !m.paid).reduce((sum, m) => sum + Number(m.commission_value), 0)
    const paid = own.filter((m) => m.paid).reduce((sum, m) => sum + Number(m.commission_value), 0)
    return { ...c, commissions: own, pending, paid }
  })
}

export default function AdminComunidades() {
  const [communities, setCommunities] = useState(null)
  const [commissions, setCommissions] = useState(null)
  const [affiliates, setAffiliates] = useState([])
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [showNewForm, setShowNewForm] = useState(false)

  function load() {
    return Promise.all([
      rawApi.listAdminCommunities().then(setCommunities).catch((e) => setError(e.message)),
      rawApi.listCommunityCommissions().then(setCommissions).catch((e) => setError(e.message)),
      rawApi.listAffiliates().then(setAffiliates).catch(() => {}),
    ])
  }

  useEffect(() => {
    load()
  }, [])

  const summaries = useMemo(() => summarize(communities, commissions), [communities, commissions])

  async function togglePaid(commission) {
    await rawApi.markCommunityCommissionPaid(commission.id, !commission.paid)
    load()
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Comunidades</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Comissão calculada sozinha a cada renovação de qualquer membro ativo, pela % do nível atual da
            comunidade (Gold até 15 membros 25%, Platinum até 25 membros 30%, Diamond acima disso 35%). O
            embaixador também pode criar a própria comunidade pela aba Comunidade dele.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={load} />
          <button
            onClick={() => setShowNewForm((v) => !v)}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {showNewForm ? 'Cancelar' : '+ Nova comunidade'}
          </button>
        </div>
      </div>

      {showNewForm && (
        <NewCommunityForm
          affiliates={affiliates}
          onCreated={() => {
            setShowNewForm(false)
            load()
          }}
        />
      )}

      {error && <EmptyState title="Não deu pra carregar" subtitle={error} />}

      {summaries.length === 0 && !error && (
        <EmptyState title="Nenhuma comunidade criada ainda" subtitle="Aparece aqui assim que um afiliado criar a comunidade dele." />
      )}

      <div className="space-y-3">
        {summaries.map((c) => {
          const expanded = expandedId === c.id
          const tier = tierForCount(c.active_member_count)
          return (
            <div key={c.id} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
              <button
                onClick={() => setExpandedId(expanded ? null : c.id)}
                className="flex w-full flex-wrap items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[var(--hover-surface)]"
              >
                <div className="flex items-center gap-3">
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  <TierBadge tier={tier} />
                  <div>
                    <p className="font-semibold text-[var(--text-primary)]">{c.community_name}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {c.ambassador_name} · {c.ambassador_email}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-6">
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">Membros ativos</p>
                    <p className="flex items-center justify-center gap-1 font-semibold text-[var(--text-primary)]">
                      <Users size={13} /> {c.active_member_count}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">A pagar</p>
                    <p className="font-semibold text-amber-400">{money(c.pending)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">Já pago</p>
                    <p className="font-semibold text-emerald-400">{money(c.paid)}</p>
                  </div>
                </div>
              </button>

              {expanded && (
                <div className="border-t border-[var(--border)] px-5 py-4">
                  <p className="mb-3 text-xs text-[var(--text-muted)]">
                    {c.ambassador_pix_key ? `PIX: ${c.ambassador_pix_key}` : 'Sem chave PIX cadastrada pro afiliado'}
                  </p>
                  {c.commissions.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)]">Nenhuma renovação de membro gerou comissão ainda.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                          <tr>
                            <th className="px-3 py-2">Membro</th>
                            <th className="px-3 py-2">Nível na hora</th>
                            <th className="px-3 py-2 text-right">Venda</th>
                            <th className="px-3 py-2 text-right">Comissão</th>
                            <th className="px-3 py-2">Data</th>
                            <th className="px-3 py-2">Pago</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {c.commissions.map((m) => (
                            <tr key={m.id} className="hover:bg-[var(--bg-surface-2)]">
                              <td className="px-3 py-2.5 text-[var(--text-primary)]">{m.customer_name || m.customer_email}</td>
                              <td className="px-3 py-2.5 text-[var(--text-tertiary)]">
                                {m.tier} · {Number(m.commission_percentage)}% · {m.member_count_at_time} membros
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-tertiary)]">{money(m.sale_amount)}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums font-medium text-[var(--text-primary)]">
                                {money(m.commission_value)}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(m.created_at)}</td>
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={() => togglePaid(m)}
                                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                                    m.paid
                                      ? 'bg-emerald-500/15 text-emerald-400'
                                      : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                                  }`}
                                >
                                  {m.paid ? 'Pago ✓' : 'Marcar como pago'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
