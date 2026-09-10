import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Users } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import TierBadge from '../components/TierBadge.jsx'
import { formatDateTime } from '../utils/date.js'

function money(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
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
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  function load() {
    return Promise.all([
      rawApi.listAdminCommunities().then(setCommunities).catch((e) => setError(e.message)),
      rawApi.listCommunityCommissions().then(setCommissions).catch((e) => setError(e.message)),
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
            embaixador cria a comunidade dele pela própria conta.
          </p>
        </div>
        <RefreshButton onRefresh={load} />
      </div>

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
