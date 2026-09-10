import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import { formatDateTime } from '../utils/date.js'

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none'

const emptyForm = { name: '', caktoEmail: '', pixKey: '', firstSalePercentage: '40', recurringPercentage: '25' }

function money(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Agrupa as comissões (lista plana da API) por afiliado, e já soma tudo que
// a tela precisa mostrar de cara: quantos clientes distintos, quanto falta
// pagar, quanto já foi pago. Feito no front porque a lista inteira já vem
// numa chamada só (base pequena, não compensa 1 endpoint por afiliado).
function summarize(affiliates, commissions) {
  return (affiliates || []).map((a) => {
    const own = (commissions || []).filter((c) => c.affiliate_id === a.id)
    const clientCount = new Set(own.map((c) => c.customer_email)).size
    const pending = own.filter((c) => !c.paid).reduce((sum, c) => sum + Number(c.commission_value), 0)
    const paid = own.filter((c) => c.paid).reduce((sum, c) => sum + Number(c.commission_value), 0)
    return { ...a, commissions: own, clientCount, pending, paid }
  })
}

export default function Afiliados() {
  const [affiliates, setAffiliates] = useState(null)
  const [commissions, setCommissions] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [creating, setCreating] = useState(false)
  const [formMsg, setFormMsg] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  function load() {
    return Promise.all([
      rawApi.listAffiliates().then(setAffiliates).catch((e) => setError(e.message)),
      rawApi.listAffiliateCommissions().then(setCommissions).catch((e) => setError(e.message)),
    ])
  }

  useEffect(() => {
    load()
  }, [])

  const summaries = useMemo(() => summarize(affiliates, commissions), [affiliates, commissions])

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setFormMsg(null)
    try {
      await rawApi.createAffiliate(form)
      setForm(emptyForm)
      setShowForm(false)
      load()
    } catch (err) {
      setFormMsg({ type: 'error', text: err.message || 'Erro' })
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id) {
    await rawApi.deleteAffiliate(id)
    if (expandedId === id) setExpandedId(null)
    load()
  }

  async function togglePaid(commission) {
    await rawApi.markAffiliateCommissionPaid(commission.id, !commission.paid)
    load()
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Afiliados</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Comissão calculada pela nossa própria taxa (a Cakto só rastreia o link/clique). Uma venda só vira
            "a pagar" depois que o pagamento é confirmado de verdade — se o cliente cancelar ou pedir reembolso, a
            comissão pendente some sozinha.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={load} />
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {showForm ? 'Cancelar' : '+ Novo afiliado'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
          <h3 className="mb-3.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Cadastrar afiliado
          </h3>
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Nome</label>
              <input
                required
                placeholder="Ex: Eveline"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className={inputClass}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Email dela na Cakto</label>
              <input
                required
                type="email"
                placeholder="conta de afiliada"
                value={form.caktoEmail}
                onChange={(e) => setForm({ ...form, caktoEmail: e.target.value })}
                className={inputClass}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Chave PIX (opcional)</label>
              <input
                value={form.pixKey}
                onChange={(e) => setForm({ ...form, pixKey: e.target.value })}
                className={inputClass}
              />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">% 1ª venda</label>
              <input
                required
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.firstSalePercentage}
                onChange={(e) => setForm({ ...form, firstSalePercentage: e.target.value })}
                className={inputClass}
              />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">% recorrência</label>
              <input
                required
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.recurringPercentage}
                onChange={(e) => setForm({ ...form, recurringPercentage: e.target.value })}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {creating ? 'Salvando…' : 'Cadastrar'}
            </button>
          </form>
          {formMsg && <p className="mt-2 text-sm text-red-400">{formMsg.text}</p>}
        </div>
      )}

      {error && <EmptyState title="Não deu pra carregar" subtitle={error} />}

      {summaries.length === 0 && !error && (
        <EmptyState title="Nenhum afiliado cadastrado ainda" subtitle="Clique em '+ Novo afiliado' pra começar." />
      )}

      <div className="space-y-3">
        {summaries.map((a) => {
          const expanded = expandedId === a.id
          return (
            <div key={a.id} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
              <button
                onClick={() => setExpandedId(expanded ? null : a.id)}
                className="flex w-full flex-wrap items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[var(--hover-surface)]"
              >
                <div className="flex items-center gap-3">
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  <div>
                    <p className="font-semibold text-[var(--text-primary)]">{a.name}</p>
                    <p className="text-xs text-[var(--text-muted)]">{a.cakto_email}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-6">
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">Clientes</p>
                    <p className="font-semibold text-[var(--text-primary)]">{a.clientCount}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">A receber</p>
                    <p className="font-semibold text-amber-400">{money(a.pending)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase text-[var(--text-muted)]">Já recebido</p>
                    <p className="font-semibold text-emerald-400">{money(a.paid)}</p>
                  </div>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(a.id)
                    }}
                    title="Remover afiliado"
                    className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover-surface)] hover:text-red-400"
                  >
                    <Trash2 size={15} />
                  </span>
                </div>
              </button>

              {expanded && (
                <div className="border-t border-[var(--border)] px-5 py-4">
                  <p className="mb-3 text-xs text-[var(--text-muted)]">
                    {Number(a.first_sale_percentage)}% na primeira venda · {Number(a.recurring_percentage)}% nas
                    renovações{a.pix_key ? ` · PIX: ${a.pix_key}` : ''}
                  </p>
                  {a.commissions.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)]">Nenhuma venda dela ainda.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                          <tr>
                            <th className="px-3 py-2">Cliente</th>
                            <th className="px-3 py-2">Tipo</th>
                            <th className="px-3 py-2 text-right">Venda</th>
                            <th className="px-3 py-2 text-right">Comissão</th>
                            <th className="px-3 py-2">Data</th>
                            <th className="px-3 py-2">Pago</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {a.commissions.map((c) => (
                            <tr key={c.id} className="hover:bg-[var(--bg-surface-2)]">
                              <td className="px-3 py-2.5 text-[var(--text-primary)]">
                                {c.customer_name || c.customer_email}
                              </td>
                              <td className="px-3 py-2.5 text-[var(--text-tertiary)]">
                                {c.commission_type === 'first_sale' ? 'Primeira venda' : 'Recorrência'}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-tertiary)]">
                                {money(c.sale_amount)}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums font-medium text-[var(--text-primary)]">
                                {money(c.commission_value)}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">
                                {formatDateTime(c.created_at)}
                              </td>
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={() => togglePaid(c)}
                                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                                    c.paid
                                      ? 'bg-emerald-500/15 text-emerald-400'
                                      : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                                  }`}
                                >
                                  {c.paid ? 'Pago ✓' : 'Marcar como pago'}
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
