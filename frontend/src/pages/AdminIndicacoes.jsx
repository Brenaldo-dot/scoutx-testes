import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import { formatDateTime } from '../utils/date.js'

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none'

function money(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Normaliza qualquer formato digitado ("(11) 91234-5678", "11912345678"...)
// pro formato que o wa.me espera (só dígitos, com DDI). Se a pessoa já
// digitou o 55 na frente, não duplica.
function toWhatsappNumber(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return ''
  return digits.startsWith('55') ? digits : `55${digits}`
}

function whatsappUrl(number, message) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

// Junta os pedidos de cupom com as comissões geradas por cada um — mesma
// ideia de summarize() em Afiliados.jsx, adaptada pro shape de indicação.
function summarize(coupons, commissions) {
  return (coupons || []).map((c) => {
    const own = (commissions || []).filter((m) => m.coupon_code === c.coupon_code && c.coupon_code)
    const pending = own.filter((m) => !m.paid).reduce((sum, m) => sum + Number(m.commission_value), 0)
    const paid = own.filter((m) => m.paid).reduce((sum, m) => sum + Number(m.commission_value), 0)
    return { ...c, commissions: own, pending, paid }
  })
}

function ActivateForm({ coupon, onActivate }) {
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!code.trim()) return
    setSaving(true)
    setErr(null)
    try {
      await onActivate(coupon.id, code.trim())
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        placeholder="Código criado na Cakto"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className={inputClass}
      />
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {saving ? 'Ativando…' : 'Ativar cupom'}
      </button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </form>
  )
}

export default function AdminIndicacoes() {
  const [coupons, setCoupons] = useState(null)
  const [commissions, setCommissions] = useState(null)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  function load() {
    return Promise.all([
      rawApi.listReferrals().then(setCoupons).catch((e) => setError(e.message)),
      rawApi.listReferralCommissions().then(setCommissions).catch((e) => setError(e.message)),
    ])
  }

  useEffect(() => {
    load()
  }, [])

  const summaries = useMemo(() => summarize(coupons, commissions), [coupons, commissions])
  const pendingRequests = summaries.filter((c) => c.status === 'requested')
  const active = summaries.filter((c) => c.status === 'active')

  async function handleActivate(id, couponCode) {
    await rawApi.activateReferral(id, couponCode)
    load()
  }

  async function togglePaid(commission) {
    await rawApi.markReferralCommissionPaid(commission.id, !commission.paid)
    load()
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Indicações</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Cliente pede o cupom pela aba "Indicação" dele (avisa no WhatsApp também). Crie o cupom de 10% na Cakto e
            cole o código aqui pra liberar. Comissão de 50% é calculada sozinha quando o webhook da Cakto trouxer
            esse couponCode numa compra nova.
          </p>
        </div>
        <RefreshButton onRefresh={load} />
      </div>

      {error && <EmptyState title="Não deu pra carregar" subtitle={error} />}

      {pendingRequests.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
            Pedidos aguardando cupom ({pendingRequests.length})
          </h3>
          <div className="space-y-3">
            {pendingRequests.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-5 py-4"
              >
                <div>
                  <p className="font-semibold text-[var(--text-primary)]">{c.user_name}</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {c.user_email}
                    {c.whatsapp ? ` · WhatsApp: ${c.whatsapp}` : ' · sem WhatsApp informado'}
                    {c.pix_key ? ` · PIX: ${c.pix_key}` : ' · sem PIX informado ainda'} · pedido em{' '}
                    {formatDateTime(c.requested_at)}
                  </p>
                </div>
                <ActivateForm coupon={c} onActivate={handleActivate} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Cupons ativos ({active.length})
        </h3>
        {active.length === 0 && !error && (
          <EmptyState title="Nenhum cupom ativo ainda" subtitle="Ative um pedido acima pra ele aparecer aqui." />
        )}
        <div className="space-y-3">
          {active.map((c) => {
            const expanded = expandedId === c.id
            return (
              <div key={c.id} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
                <button
                  onClick={() => setExpandedId(expanded ? null : c.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[var(--hover-surface)]"
                >
                  <div className="flex items-center gap-3">
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <div>
                      <p className="font-semibold text-[var(--text-primary)]">{c.user_name}</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {c.user_email} · cupom <code className="text-[var(--text-primary)]">{c.coupon_code}</code>
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-6">
                    <div className="text-center">
                      <p className="text-xs uppercase text-[var(--text-muted)]">Indicados</p>
                      <p className="font-semibold text-[var(--text-primary)]">{c.commissions.length}</p>
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
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-[var(--text-muted)]">
                        {c.pix_key ? `PIX: ${c.pix_key}` : 'Sem chave PIX informada ainda'}
                        {c.whatsapp ? ` · WhatsApp: ${c.whatsapp}` : ' · sem WhatsApp informado'}
                      </p>
                      {c.whatsapp && (
                        <a
                          href={whatsappUrl(
                            toWhatsappNumber(c.whatsapp),
                            `Oi, ${c.user_name}! Seu cupom de indicação do ScoutX foi aprovado 🎉 Já está liberado no app: ${c.coupon_code}. Pode compartilhar com quem quiser!`
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          Avisar no WhatsApp
                        </a>
                      )}
                    </div>
                    {c.commissions.length === 0 ? (
                      <p className="text-sm text-[var(--text-muted)]">Ninguém assinou com esse cupom ainda.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                            <tr>
                              <th className="px-3 py-2">Indicado</th>
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
                                <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-tertiary)]">
                                  {money(m.sale_amount)}
                                </td>
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
    </div>
  )
}
