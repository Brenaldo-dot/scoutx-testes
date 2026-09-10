import { useEffect, useState } from 'react'
import { Gift, Copy, Check } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import { formatDateTime } from '../utils/date.js'

function money(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export default function Indicacao() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [pixKey, setPixKey] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [copied, setCopied] = useState(false)

  function load() {
    return rawApi
      .getMyReferral()
      .then(setData)
      .catch((e) => setError(e.message))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleRequest(e) {
    e.preventDefault()
    setRequesting(true)
    setError(null)
    try {
      await rawApi.requestReferralCoupon(pixKey.trim() || null, whatsapp.trim())
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setRequesting(false)
    }
  }

  function copyCoupon(code) {
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const coupon = data?.coupon || null
  const commissions = data?.commissions || []
  const pendingTotal = commissions.filter((c) => !c.paid).reduce((s, c) => s + Number(c.commission_value), 0)
  const paidTotal = commissions.filter((c) => c.paid).reduce((s, c) => s + Number(c.commission_value), 0)

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Indicação</h2>
        <p className="text-sm text-[var(--text-muted)]">Indique o ScoutX e ganhe comissão em dobro por cada amigo que assinar.</p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Como funciona</h3>
        <ul className="mt-3 space-y-2 text-sm text-[var(--text-muted)]">
          <li>
            1. Você solicita seu cupom pessoal de indicação, que dá{' '}
            <span className="font-medium text-[var(--text-primary)]">10% de desconto</span> pro seu amigo assinar o
            ScoutX.
          </li>
          <li>2. Você compartilha esse cupom com quem quiser.</li>
          <li>
            3. Quando alguém assina usando o seu cupom, você recebe{' '}
            <span className="font-medium text-emerald-400">50% do valor do plano</span> que essa pessoa escolheu.
          </li>
        </ul>
      </div>

      {error && <EmptyState title="Não deu pra carregar" subtitle={error} />}

      {!coupon && data && (
        <div className="overflow-hidden rounded-2xl border border-brand-500/25 bg-[var(--bg-surface)]">
          <div className="flex items-center gap-3 border-b border-[var(--border)] bg-brand-500/5 px-6 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg shadow-brand-600/30">
              <Gift size={18} />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Solicitar meu cupom de desconto</h3>
              <p className="text-xs text-[var(--text-muted)]">Nome e e-mail já são os da sua conta, é só completar abaixo.</p>
            </div>
          </div>
          <form onSubmit={handleRequest} className="flex flex-wrap items-end gap-3 px-6 py-5">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">WhatsApp</label>
              <input
                required
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
                placeholder="(11) 91234-5678"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Chave PIX</label>
              <input
                required
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
                placeholder="CPF, email, telefone ou chave aleatória"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={requesting}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              <Gift size={16} />
              {requesting ? 'Solicitando…' : 'Solicite o seu cupom de desconto'}
            </button>
          </form>
        </div>
      )}

      {coupon && coupon.status === 'requested' && (
        <div className="flex items-start gap-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
            <Check size={18} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-amber-400">Solicitação enviada com sucesso</h3>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Assim que seu cupom for aprovado, ele aparece automaticamente aqui nesta tela. Pode aguardar, a gente
              te avisa.
            </p>
          </div>
        </div>
      )}

      {coupon && coupon.status === 'active' && (
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
          <h3 className="text-sm font-semibold text-emerald-400">Seu cupom está ativo</h3>
          <div className="mt-3 flex items-center gap-2">
            <code className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-4 py-2.5 text-lg font-bold tracking-wide text-[var(--text-primary)]">
              {coupon.coupon_code}
            </code>
            <button
              onClick={() => copyCoupon(coupon.coupon_code)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--text-muted)] hover:bg-[var(--hover-surface)]"
            >
              {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        </div>
      )}

      {coupon && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Suas comissões</h3>
            <div className="flex gap-6">
              <div className="text-right">
                <p className="text-xs uppercase text-[var(--text-muted)]">A receber</p>
                <p className="font-semibold text-amber-400">{money(pendingTotal)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase text-[var(--text-muted)]">Já recebido</p>
                <p className="font-semibold text-emerald-400">{money(paidTotal)}</p>
              </div>
            </div>
          </div>

          {commissions.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--text-muted)]">Ninguém assinou com seu cupom ainda.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                  <tr>
                    <th className="px-3 py-2">Indicado</th>
                    <th className="px-3 py-2 text-right">Comissão</th>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {commissions.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2.5 text-[var(--text-primary)]">{c.customer_name || c.customer_email}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-[var(--text-primary)]">
                        {money(c.commission_value)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(c.created_at)}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                            c.paid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
                          }`}
                        >
                          {c.paid ? 'Pago' : 'Pendente'}
                        </span>
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
}
