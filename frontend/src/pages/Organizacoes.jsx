import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, CalendarClock, RefreshCw, Trash2 } from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import { api } from '../api/client.js'
import Select from '../components/Select.jsx'
import StatCard from '../components/StatCard.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import { formatDateTime } from '../utils/date.js'

// value = chave interna, gravada em organizations.plan (não muda com o
// rebrand); label = nome de venda atual (Solo → Standard, Agência →
// Enterprise). Sem menção a usuário aqui de propósito: os 3 planos têm o
// MESMO limite (1 usuário por conta/equipe, ver PLAN_LIMITS em db.js) — só
// país e concorrente diferenciam plano.
const PLAN_OPTIONS = [
  { value: 'solo', label: 'Standard: 1 país, até 50 concorrentes' },
  { value: 'pro', label: 'Pro: até 3 países, até 250 concorrentes' },
  { value: 'agencia', label: 'Enterprise: países e concorrentes ilimitados' },
]

const CYCLE_OPTIONS = [
  { value: 'mensal', label: 'Mensal' },
  { value: 'trimestral', label: 'Trimestral' },
  { value: 'anual', label: 'Anual' },
]

const emptyForm = { name: '', plan: 'solo', billingCycle: 'mensal', notes: '' }

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none'

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
}

// Contas "Legado" (migração automática) ganham validade de 10 anos —
// "vence em 3653 dias" é um número gigante sem sentido pra quem lê; acima de
// 1 ano vira "X+ anos", só sinalizando "não vence tão cedo".
function expiryCountdownLabel(days) {
  if (days > 365) {
    const years = Math.floor(days / 365)
    return `vence em ${years}+ ano${years === 1 ? '' : 's'}`
  }
  if (days > 60) {
    const months = Math.floor(days / 30)
    return `vence em ${months} ${months === 1 ? 'mês' : 'meses'}`
  }
  return `vence em ${days} dia${days === 1 ? '' : 's'}`
}

export default function Organizacoes() {
  const [orgs, setOrgs] = useState(null)
  const [users, setUsers] = useState(null)
  const [usage, setUsage] = useState({})
  const [error, setError] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [formMsg, setFormMsg] = useState(null)
  const [creating, setCreating] = useState(false)
  const [renewModal, setRenewModal] = useState(null)
  const [expiryModal, setExpiryModal] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  function load() {
    return Promise.all([
      rawApi.listOrganizations().then(setOrgs).catch((e) => setError(e.message)),
      rawApi.listUsers().then(setUsers).catch(() => setUsers([])),
    ])
  }

  useEffect(() => {
    load()
  }, [])

  // Quantos países cada organização já usa — precisa da lista de ids de
  // quem é membro dela (derivada aqui de `users`, já que /api/admin/users já
  // traz organizationId por pessoa) e do FastAPI (onde vive o dado raspado
  // de verdade, ver api/competitors.py:operations_usage).
  useEffect(() => {
    if (!orgs || !users) return
    orgs.forEach((org) => {
      const memberIds = users.filter((u) => u.organizationId === org.id).map((u) => u.id)
      if (memberIds.length === 0) return
      api
        .getOperationsUsage(memberIds)
        .then((r) => setUsage((prev) => ({ ...prev, [org.id]: r })))
        .catch(() => {})
    })
  }, [orgs, users])

  const stats = useMemo(() => {
    if (!orgs) return null
    // "Ativa" = plano em dia (não vencida) — é a organização de verdade
    // pagando/usando agora, não só cadastrada em algum momento.
    const active = orgs.filter((o) => !o.expired)
    return {
      total: orgs.length,
      active: active.length,
      activeUsers: active.reduce((sum, o) => sum + o.userCount, 0),
      expired: orgs.filter((o) => o.expired).length,
      expiringSoon: active.filter((o) => daysUntil(o.expiresAt) <= 7).length,
    }
  }, [orgs])

  async function handleCreate() {
    setFormMsg(null)
    if (!form.name.trim()) {
      setFormMsg({ type: 'error', text: 'Nome da organização é obrigatório.' })
      return
    }
    setCreating(true)
    try {
      await rawApi.createOrganization({
        name: form.name.trim(),
        plan: form.plan,
        billingCycle: form.billingCycle,
        notes: form.notes.trim() || undefined,
      })
      setFormMsg({ type: 'success', text: 'Organização criada! Já pode criar os usuários dela na aba Usuários.' })
      setForm(emptyForm)
      load()
    } catch (err) {
      setFormMsg({ type: 'error', text: err.message || 'Não foi possível criar a organização.' })
    } finally {
      setCreating(false)
    }
  }

  function openRenew(org) {
    setRenewModal({ org, plan: org.plan, billingCycle: org.billingCycle, extendValidity: true, saving: false, error: null })
  }

  async function submitRenew() {
    if (!renewModal) return
    setRenewModal({ ...renewModal, saving: true, error: null })
    try {
      await rawApi.updateOrganization(renewModal.org.id, {
        plan: renewModal.plan,
        billingCycle: renewModal.billingCycle,
        extendValidity: renewModal.extendValidity,
      })
      setRenewModal(null)
      load()
    } catch (err) {
      setRenewModal({ ...renewModal, saving: false, error: err.message || 'Não foi possível renovar.' })
    }
  }

  function openExpiry(org) {
    setExpiryModal({ org, value: new Date(org.expiresAt).toISOString().slice(0, 10), saving: false, error: null })
  }

  async function submitExpiry() {
    if (!expiryModal) return
    setExpiryModal({ ...expiryModal, saving: true, error: null })
    try {
      await rawApi.updateOrganization(expiryModal.org.id, {
        expiresAt: new Date(`${expiryModal.value}T23:59:59`).toISOString(),
      })
      setExpiryModal(null)
      load()
    } catch (err) {
      setExpiryModal({ ...expiryModal, saving: false, error: err.message || 'Não foi possível salvar.' })
    }
  }

  async function handleDelete(org) {
    if (
      !window.confirm(
        `Excluir a organização "${org.name}"? Isso apaga o plano/assinatura dela, não dá pra desfazer. Só funciona se não houver mais nenhum usuário vinculado a ela.`
      )
    ) {
      return
    }
    setDeletingId(org.id)
    try {
      await rawApi.deleteOrganization(org.id)
      load()
    } catch (err) {
      setError(err.message || 'Não foi possível excluir a organização.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Organizações</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Cada organização é uma assinatura: plano, ciclo de cobrança e validade compartilhados por todos os
            usuários dela. Ativação ainda é manual: crie a organização aqui depois de fechar a venda, depois crie os
            usuários dela na aba Usuários.
          </p>
        </div>
        <RefreshButton onRefresh={load} />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {stats && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard icon="✅" label="Organizações ativas" value={stats.active} hint={`${stats.total} no total`} />
          <StatCard icon="👥" label="Usuários pagando agora" value={stats.activeUsers} />
          <StatCard icon="⏳" label="Vencendo em 7 dias" value={stats.expiringSoon} />
          <StatCard icon="🚫" label="Vencidas" value={stats.expired} />
        </div>
      )}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
        <h3 className="mb-3.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Nova organização</h3>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <input
            type="text"
            placeholder="Nome (ex: nome do cliente/empresa)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputClass}
          />
          <input
            type="text"
            placeholder="Observação (opcional: valor pago, canal de venda)"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className={inputClass}
          />
        </div>
        <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Select value={form.plan} onChange={(v) => setForm({ ...form, plan: v })} options={PLAN_OPTIONS} />
          <Select value={form.billingCycle} onChange={(v) => setForm({ ...form, billingCycle: v })} options={CYCLE_OPTIONS} />
        </div>
        <button onClick={handleCreate} disabled={creating} className="btn-primary mt-3.5 px-4 py-2 text-sm">
          {creating ? 'Criando…' : 'Criar organização'}
        </button>
        {formMsg && (
          <p className={`mt-3 text-sm ${formMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{formMsg.text}</p>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3">Organização</th>
                <th className="px-4 py-3">Plano</th>
                <th className="px-4 py-3">Ciclo</th>
                <th className="px-4 py-3">Usuários</th>
                <th className="px-4 py-3">Países</th>
                <th className="px-4 py-3">Concorrentes</th>
                <th className="px-4 py-3">Validade</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {orgs?.map((org) => {
                const usageInfo = usage[org.id]
                const days = daysUntil(org.expiresAt)
                const expiryTone = org.expired ? 'text-red-400' : days <= 7 ? 'text-amber-400' : 'text-[var(--text-muted)]'
                return (
                  <tr key={org.id} className="hover:bg-[var(--bg-surface-2)]">
                    <td className="px-4 py-3.5 font-medium text-[var(--text-primary)]">
                      <div className="flex items-center gap-2">
                        <Building2 size={14} className="text-[var(--text-faint)]" />
                        {org.name}
                      </div>
                      {org.notes && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{org.notes}</p>}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-xs font-semibold text-brand-500">
                        {org.planLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 capitalize text-[var(--text-tertiary)]">{org.billingCycle}</td>
                    <td className="px-4 py-3.5 tabular-nums text-[var(--text-tertiary)]">
                      {org.userCount} / {org.maxUsers ?? '∞'}
                    </td>
                    <td className="px-4 py-3.5 tabular-nums text-[var(--text-tertiary)]">
                      {usageInfo ? usageInfo.count : org.userCount === 0 ? 0 : '…'} / {org.maxOperations ?? '∞'}
                    </td>
                    <td className="px-4 py-3.5 tabular-nums text-[var(--text-tertiary)]">
                      {usageInfo ? usageInfo.competitorsCount : org.userCount === 0 ? 0 : '…'} / {org.maxCompetitors ?? '∞'}
                    </td>
                    <td className={`min-w-[8rem] px-4 py-3.5 text-xs ${expiryTone}`}>
                      <div className="whitespace-nowrap">{formatDateTime(org.expiresAt)}</div>
                      <div className="whitespace-nowrap">{org.expired ? 'Vencido' : expiryCountdownLabel(days)}</div>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to={`/usuarios?org=${org.id}`}
                          className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-brand-500"
                        >
                          Ver usuários ↗
                        </Link>
                        <button
                          onClick={() => openRenew(org)}
                          title="Renovar / mudar plano"
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-brand-500"
                        >
                          <RefreshCw size={15} />
                        </button>
                        <button
                          onClick={() => openExpiry(org)}
                          title="Editar validade manualmente"
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-amber-400"
                        >
                          <CalendarClock size={15} />
                        </button>
                        <button
                          onClick={() => handleDelete(org)}
                          disabled={deletingId === org.id}
                          title={org.userCount > 0 ? 'Remova os usuários dela antes de excluir' : 'Excluir organização'}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-red-400 disabled:opacity-50"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {orgs?.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-[var(--text-muted)]">
                    Nenhuma organização criada ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {renewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRenewModal(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Renovar / mudar plano de {renewModal.org.name}</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {renewModal.extendValidity
                ? 'Se ainda não venceu, a validade nova soma em cima da atual. Se já venceu, conta a partir de hoje.'
                : 'Só troca o plano, a data de validade continua exatamente a mesma que já estava.'}
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              <Select value={renewModal.plan} onChange={(v) => setRenewModal({ ...renewModal, plan: v })} options={PLAN_OPTIONS} />
              <Select
                value={renewModal.billingCycle}
                onChange={(v) => setRenewModal({ ...renewModal, billingCycle: v })}
                options={CYCLE_OPTIONS}
              />
              <label className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <input
                  type="checkbox"
                  checked={renewModal.extendValidity}
                  onChange={(e) => setRenewModal({ ...renewModal, extendValidity: e.target.checked })}
                />
                Estender a validade (renovação de verdade, entrou dinheiro novo)
              </label>
              {!renewModal.extendValidity && (
                <p className="text-xs text-amber-500">
                  Upgrade/downgrade no meio do ciclo: use isso quando o cliente já pagou a diferença por fora e não deve
                  ganhar nem perder dias de validade.
                </p>
              )}
            </div>
            {renewModal.error && <p className="mt-2 text-xs text-red-400">{renewModal.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRenewModal(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitRenew} disabled={renewModal.saving} className="btn-primary px-4 py-2 text-xs">
                {renewModal.saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {expiryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setExpiryModal(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Editar validade de {expiryModal.org.name}</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Ajuste manual: cortesia, correção, ou cancelamento antecipado (data no passado bloqueia o login
              na hora).
            </p>
            <input
              type="date"
              value={expiryModal.value}
              onChange={(e) => setExpiryModal({ ...expiryModal, value: e.target.value, error: null })}
              className={`${inputClass} mt-3 w-full`}
            />
            {expiryModal.error && <p className="mt-2 text-xs text-red-400">{expiryModal.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setExpiryModal(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitExpiry} disabled={expiryModal.saving} className="btn-primary px-4 py-2 text-xs">
                {expiryModal.saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
