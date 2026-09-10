import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRightLeft,
  Ban,
  Building2,
  History,
  KeyRound,
  Lock,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import { api } from '../api/client.js'
import Select from '../components/Select.jsx'
import StatCard from '../components/StatCard.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import { operationLabel } from '../context/OperationContext.jsx'
import { formatDateTime, formatRelativeTime, isRecent } from '../utils/date.js'

const SORT_OPTIONS = [
  { value: 'name', label: 'Ordenar: cadastro (padrão)' },
  { value: 'inactive', label: 'Ordenar: sem logar há mais tempo' },
  { value: 'created', label: 'Ordenar: criado mais recente' },
]

// Tempo de conta — quanto tempo faz que essa pessoa tem acesso, não quantas
// vezes usou (isso já é o "Buscas"/"Alertas gerados" ao lado). Ajuda a achar
// conta velha que nunca foi revisada.
function tenureLabel(createdAt) {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)
  if (days < 1) return 'hoje'
  if (days < 30) return `${days} dia${days === 1 ? '' : 's'}`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} ${months === 1 ? 'mês' : 'meses'}`
  const years = Math.floor(months / 12)
  const remMonths = months % 12
  return remMonths > 0 ? `${years}a ${remMonths}m` : `${years} ${years === 1 ? 'ano' : 'anos'}`
}

// Contas "Legado" (migração automática) ganham validade de 10 anos — mostrar
// "vence em 3653 dias" fica um número gigante e sem sentido pra quem lê;
// acima de 1 ano vira "X+ anos", sem contar dia a dia (não é o que importa
// pra esse caso, é só sinalizar "não vence tão cedo").
function expiryCountdownLabel(expiresAt) {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000)
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

const AUDIT_ACTIONS = {
  created: { icon: UserPlus, color: 'text-emerald-400', text: (a, t) => `${a} criou o usuário ${t}` },
  promoted: { icon: ShieldCheck, color: 'text-brand-500', text: (a, t) => `${a} promoveu ${t} a admin` },
  demoted: { icon: ShieldCheck, color: 'text-amber-400', text: (a, t) => `${a} removeu o admin de ${t}` },
  suspended: { icon: Ban, color: 'text-red-400', text: (a, t) => `${a} suspendeu ${t}` },
  reactivated: { icon: RotateCcw, color: 'text-emerald-400', text: (a, t) => `${a} reativou ${t}` },
  password_reset: { icon: KeyRound, color: 'text-[var(--text-tertiary)]', text: (a, t) => `${a} redefiniu a senha de ${t}` },
  deleted: { icon: Trash2, color: 'text-red-400', text: (a, t) => `${a} removeu o usuário ${t}` },
  permission_changed: { icon: SlidersHorizontal, color: 'text-[var(--text-tertiary)]', text: (a, t) => `${a} alterou permissões de ${t}` },
  org_created: { icon: Building2, color: 'text-emerald-400', text: (a, t) => `${a} criou a organização ${t}` },
  org_renewed: { icon: RefreshCw, color: 'text-brand-500', text: (a, t) => `${a} renovou/mudou o plano de ${t}` },
  org_expiry_edited: { icon: Building2, color: 'text-amber-400', text: (a, t) => `${a} editou a validade de ${t}` },
  org_changed: { icon: Building2, color: 'text-brand-500', text: (a, t) => `${a} mudou a organização de ${t}` },
  org_plan_changed: { icon: RefreshCw, color: 'text-brand-500', text: (a, t) => `${a} mudou o plano de ${t} (validade mantida)` },
  org_deleted: { icon: Trash2, color: 'text-red-400', text: (a, t) => `${a} excluiu a organização ${t}` },
}

const emptyForm = { name: '', email: '', password: '', admin: false, organizationId: '', withoutPassword: false }

// Mesmas chaves/labels de Organizacoes.jsx (não veio pra um arquivo
// compartilhado de propósito, pra não criar acoplamento entre as duas
// telas por causa de uma lista de 3 itens que quase nunca muda).
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

const inputClass =
  'rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none'

// Switch próprio — checkbox nativo do navegador destoava do resto do app
// (mesma razão dos outros componentes trocados por versão própria: Select,
// LedIcon). Usado tanto nas permissões da tabela quanto no form de criação.
function Toggle({ checked, onChange, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-block h-5 w-9 shrink-0 rounded-full border align-middle transition-colors ${
        checked ? 'border-brand-500 bg-brand-500' : 'border-[var(--border)] bg-[var(--hover-surface)]'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export default function Usuarios() {
  const [users, setUsers] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [formMsg, setFormMsg] = useState(null)
  const [creating, setCreating] = useState(false)
  const [ipDetail, setIpDetail] = useState(null)
  const [passwordEdit, setPasswordEdit] = useState(null)
  const [orgPicker, setOrgPicker] = useState(null)
  const [planEditor, setPlanEditor] = useState(null)
  const [competitorSummary, setCompetitorSummary] = useState(null)
  const [claiming, setClaiming] = useState(false)
  const [claimMsg, setClaimMsg] = useState(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [trackerQuery, setTrackerQuery] = useState('')
  const [trackerResults, setTrackerResults] = useState(null)
  const [auditLog, setAuditLog] = useState(null)
  const [organizations, setOrganizations] = useState(null)
  const [protectedStores, setProtectedStores] = useState(null)
  const [protectForm, setProtectForm] = useState({ domain: '', note: '' })
  const [protecting, setProtecting] = useState(false)
  const [protectMsg, setProtectMsg] = useState(null)
  const [runningRetention, setRunningRetention] = useState(false)
  const [retentionMsg, setRetentionMsg] = useState(null)
  const [celeryDiag, setCeleryDiag] = useState(null)
  const [loadingDiag, setLoadingDiag] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const orgFilter = searchParams.get('org') || ''

  function setOrgFilter(value) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set('org', value)
    else next.delete('org')
    setSearchParams(next)
  }

  useEffect(() => {
    const q = trackerQuery.trim()
    if (q.length < 2) {
      setTrackerResults(null)
      return
    }
    const t = setTimeout(() => {
      api.searchCompetitorTrackers(q).then(setTrackerResults).catch(() => setTrackerResults([]))
    }, 350)
    return () => clearTimeout(t)
  }, [trackerQuery])

  const stats = useMemo(() => {
    if (!users) return null
    return {
      total: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      suspended: users.filter((u) => u.suspended).length,
      neverLoggedIn: users.filter((u) => !u.lastLoginAt).length,
    }
  }, [users])

  const filteredUsers = useMemo(() => {
    if (!users) return users
    const term = search.trim().toLowerCase()
    let list = term
      ? users.filter((u) => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term))
      : [...users]
    if (orgFilter) list = list.filter((u) => String(u.organizationId) === orgFilter)
    if (sortBy === 'inactive') {
      // Nunca logou (null) primeiro — é exatamente quem mais precisa de
      // atenção (conta criada e esquecida, ou nunca usada de propósito).
      list.sort((a, b) => new Date(a.lastLoginAt || 0) - new Date(b.lastLoginAt || 0))
    } else if (sortBy === 'created') {
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    }
    return list
  }, [users, search, sortBy, orgFilter])

  async function handleClaimOrphaned() {
    setClaiming(true)
    setClaimMsg(null)
    try {
      const result = await api.claimOrphanedCompetitors()
      setClaimMsg({
        type: 'success',
        text: result.claimed > 0
          ? `${result.claimed} concorrente(s) órfão(s) passaram a ser seus.`
          : 'Não tinha nenhum concorrente órfão pra reivindicar.',
      })
      load()
    } catch (err) {
      setClaimMsg({ type: 'error', text: err.message || 'Não foi possível reivindicar.' })
    } finally {
      setClaiming(false)
    }
  }

  function load() {
    return Promise.all([
      rawApi.listUsers().then(setUsers).catch((e) => setError(e.message)),
      api.getCompetitorSummaryByUser().then(setCompetitorSummary).catch(() => setCompetitorSummary([])),
      rawApi.listAuditLog().then(setAuditLog).catch(() => setAuditLog([])),
      rawApi.listOrganizations().then(setOrganizations).catch(() => setOrganizations([])),
      api.listProtectedStores().then(setProtectedStores).catch(() => setProtectedStores([])),
    ])
  }

  async function handleAddProtectedStore(e) {
    e.preventDefault()
    if (!protectForm.domain.trim()) return
    setProtecting(true)
    setProtectMsg(null)
    try {
      await api.addProtectedStore({ domain: protectForm.domain.trim(), note: protectForm.note.trim() || null })
      setProtectForm({ domain: '', note: '' })
      setProtectMsg({ type: 'success', text: 'Loja protegida — nunca vai ser vasculhada pelo app.' })
      load()
    } catch (err) {
      setProtectMsg({ type: 'error', text: err.message || 'Não foi possível proteger essa loja.' })
    } finally {
      setProtecting(false)
    }
  }

  async function handleRemoveProtectedStore(id) {
    try {
      await api.removeProtectedStore(id)
      load()
    } catch (err) {
      setProtectMsg({ type: 'error', text: err.message || 'Não foi possível remover a proteção.' })
    }
  }

  async function handleRunRetention() {
    setRunningRetention(true)
    setRetentionMsg(null)
    try {
      const result = await api.runRetentionNow()
      setRetentionMsg({
        type: 'success',
        text: `Limpeza concluída: ${result.scores_deleted} pontuação(ões) e ${result.snapshots_deleted} foto(s) de produto antigas removidas.`,
      })
    } catch (err) {
      setRetentionMsg({ type: 'error', text: err.message || 'Não foi possível rodar a limpeza.' })
    } finally {
      setRunningRetention(false)
    }
  }

  async function handleCeleryDiagnostics() {
    setLoadingDiag(true)
    setCeleryDiag(null)
    try {
      const result = await api.getCeleryDiagnostics()
      setCeleryDiag(result)
    } catch (err) {
      setCeleryDiag({ error: err.message || 'Não foi possível consultar os workers.' })
    } finally {
      setLoadingDiag(false)
    }
  }

  // BUG CRÍTICO corrigido (achado ao vivo, 2026-08-27 — deixava a aba
  // inteira em branco): `load` passa a devolver a Promise (ver
  // RefreshButton, precisa disso pra saber quando parar de girar) —
  // `useEffect(load, [])` chamava load() DIRETO como efeito, e o React
  // tenta usar o que o efeito retorna como função de limpeza. Uma Promise
  // não é função nem undefined — "destroy is not a function", crash sem
  // error boundary nenhum por cima, tela toda em branco. `() => { load() }`
  // não devolve nada pro React, então não quebra mais.
  useEffect(() => {
    load()
  }, [])

  async function handleCreate() {
    setFormMsg(null)
    if (!form.name.trim() || !form.email.trim()) {
      setFormMsg({ type: 'error', text: 'Preencha nome e email.' })
      return
    }
    if (!form.withoutPassword && form.password.length < 8) {
      setFormMsg({ type: 'error', text: 'Preencha uma senha com pelo menos 8 caracteres, ou marque "Criar sem senha".' })
      return
    }
    if (!form.admin && !form.organizationId) {
      setFormMsg({ type: 'error', text: 'Selecione a organização desse usuário (ou marque "Já criar como admin").' })
      return
    }
    setCreating(true)
    try {
      await rawApi.createUser({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.withoutPassword ? undefined : form.password,
        withoutPassword: form.withoutPassword,
        role: form.admin ? 'admin' : 'collaborator',
        organizationId: form.admin ? undefined : Number(form.organizationId),
      })
      setFormMsg({
        type: 'success',
        text: form.withoutPassword
          ? 'Usuário criado! Peça pra essa pessoa acessar app.scoutx.com.br/registrar com esse email pra criar a própria senha.'
          : 'Usuário criado! Envie o email e a senha combinada pra essa pessoa.',
      })
      setForm(emptyForm)
      load()
    } catch (err) {
      setFormMsg({ type: 'error', text: err.message || 'Não foi possível criar o usuário.' })
    } finally {
      setCreating(false)
    }
  }

  async function togglePermission(user, field, value) {
    if (field === 'role' && value && !confirm(`Dar acesso de ADMINISTRADOR pra ${user.name}? Isso dá acesso total ao app, inclusive a dados de outros usuários.`)) {
      return
    }
    // Rebaixar admin pra colaborador sem organização nenhuma deixaria a
    // conta sem plano (o backend recusa) — em vez de mostrar só o erro,
    // já abre o seletor de organização, que também confirma e salva o
    // rebaixamento junto (evita 2 passos separados: rebaixar, depois
    // descobrir que precisa escolher organização).
    if (field === 'role' && value === false && !user.organizationId) {
      setOrgPicker({ user, value: '', demoting: true, saving: false, error: null })
      return
    }
    const prev = users
    setUsers(users.map((u) => (u.id === user.id ? { ...u, [field]: value } : u)))
    try {
      const body = field === 'role' ? { role: value ? 'admin' : 'collaborator' } : { [field]: value }
      await rawApi.updateUser(user.id, body)
      load()
    } catch (err) {
      setUsers(prev)
      alert(err.message || 'Não foi possível salvar a alteração.')
    }
  }

  function openOrgPicker(user) {
    // Admin não tem organização por definição — colocar essa conta num
    // plano sempre passa por tirar o admin dela também (mesma trava do
    // backend, ver server.js).
    setOrgPicker({
      user,
      value: user.organizationId ? String(user.organizationId) : '',
      demoting: user.role === 'admin',
      saving: false,
      error: null,
    })
  }

  async function submitOrgPicker() {
    if (!orgPicker || !orgPicker.value) {
      setOrgPicker({ ...orgPicker, error: 'Selecione uma organização.' })
      return
    }
    setOrgPicker({ ...orgPicker, saving: true, error: null })
    try {
      const body = { organizationId: Number(orgPicker.value) }
      if (orgPicker.demoting) body.role = 'collaborator'
      await rawApi.updateUser(orgPicker.user.id, body)
      setOrgPicker(null)
      load()
    } catch (err) {
      setOrgPicker({ ...orgPicker, saving: false, error: err.message || 'Não foi possível salvar.' })
    }
  }

  // "Alterar plano" na tela de Usuários muda o plano da ORGANIZAÇÃO dessa
  // pessoa (o plano vive lá, não no usuário) — atalho pra não precisar ir
  // até Organizações só pra isso. Mesma rota/lógica do modal de lá.
  function openPlanEditor(user) {
    const org = (organizations || []).find((o) => o.id === user.organizationId)
    setPlanEditor({
      user,
      organizationId: user.organizationId,
      plan: org?.plan || 'solo',
      billingCycle: org?.billingCycle || 'mensal',
      extendValidity: false,
      saving: false,
      error: null,
    })
  }

  async function submitPlanEditor() {
    if (!planEditor) return
    setPlanEditor({ ...planEditor, saving: true, error: null })
    try {
      await rawApi.updateOrganization(planEditor.organizationId, {
        plan: planEditor.plan,
        billingCycle: planEditor.billingCycle,
        extendValidity: planEditor.extendValidity,
      })
      setPlanEditor(null)
      load()
    } catch (err) {
      setPlanEditor({ ...planEditor, saving: false, error: err.message || 'Não foi possível salvar.' })
    }
  }

  async function handleDelete(user) {
    if (!confirm(`Remover "${user.name}"?`)) return
    try {
      await rawApi.deleteUser(user.id)
      load()
    } catch (err) {
      alert(err.message || 'Não foi possível remover o usuário.')
    }
  }

  function viewIps(user) {
    setIpDetail({ user, rows: null })
    rawApi.getUserIps(user.id).then((rows) => setIpDetail({ user, rows }))
  }

  function openPasswordEdit(user) {
    setPasswordEdit({ user, value: '', saving: false, error: null })
  }

  async function submitPasswordEdit() {
    if (!passwordEdit) return
    if (passwordEdit.value.length < 8) {
      setPasswordEdit({ ...passwordEdit, error: 'A senha precisa ter no mínimo 8 caracteres.' })
      return
    }
    setPasswordEdit({ ...passwordEdit, saving: true, error: null })
    try {
      await rawApi.updateUser(passwordEdit.user.id, { password: passwordEdit.value })
      setPasswordEdit(null)
    } catch (err) {
      setPasswordEdit({ ...passwordEdit, saving: false, error: err.message || 'Não foi possível trocar a senha.' })
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Usuários</h2>
          <p className="text-sm text-[var(--text-muted)]">Quem tem acesso ao ScoutX e o que cada um pode fazer.</p>
        </div>
        <RefreshButton onRefresh={load} />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {stats && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard icon="👥" label="Usuários" value={stats.total} />
          <StatCard icon="🛡️" label="Administradores" value={stats.admins} />
          <StatCard icon="🚫" label="Suspensos" value={stats.suspended} />
          <StatCard icon="👻" label="Nunca logaram" value={stats.neverLoggedIn} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-amber-500">Concorrentes órfãos</h3>
          <p className="mb-3.5 text-sm text-[var(--text-tertiary)]">
            Concorrente sem NENHUM usuário rastreando (ex: cadastrados antes de cada um ter sua própria lista) fica
            invisível pra todo mundo. Clique abaixo pra atribuir todos eles à SUA conta.
          </p>
          <button
            onClick={handleClaimOrphaned}
            disabled={claiming}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {claiming ? 'Reivindicando…' : 'Reivindicar concorrentes órfãos'}
          </button>
          {claimMsg && (
            <p className={`mt-3 text-sm ${claimMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
              {claimMsg.text}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Loja protegida</h3>
          <p className="mb-3.5 text-sm text-[var(--text-tertiary)]">
            Domínios aqui nunca são vasculhados pelo app — nenhum usuário consegue ver preço, produto, anúncio ou
            qualquer outro dado dessa loja, não importa quem tente cadastrar.
          </p>
          <form onSubmit={handleAddProtectedStore} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Domínio</label>
              <input
                required
                placeholder="lojaexemplo.com"
                value={protectForm.domain}
                onChange={(e) => setProtectForm({ ...protectForm, domain: e.target.value })}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Motivo (opcional)</label>
              <input
                placeholder="Ex: loja da nossa equipe"
                value={protectForm.note}
                onChange={(e) => setProtectForm({ ...protectForm, note: e.target.value })}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={protecting}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {protecting ? 'Protegendo…' : 'Proteger loja'}
            </button>
          </form>
          {protectMsg && (
            <p className={`mt-3 text-sm ${protectMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
              {protectMsg.text}
            </p>
          )}
          {protectedStores?.length > 0 && (
            <ul className="mt-4 space-y-2">
              {protectedStores.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--text-primary)]">{p.domain}</p>
                    {p.note && <p className="truncate text-xs text-[var(--text-muted)]">{p.note}</p>}
                  </div>
                  <button
                    onClick={() => handleRemoveProtectedStore(p.id)}
                    className="shrink-0 text-xs font-medium text-red-400 hover:underline"
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Manutenção do banco</h3>
          <p className="mb-3.5 text-sm text-[var(--text-tertiary)]">
            Apaga pontuações e fotos de produto com mais de 14 dias (sempre mantendo a mais recente de cada
            produto) — roda sozinho de madrugada, esse botão só força na hora pra conferir se está funcionando.
          </p>
          <button
            onClick={handleRunRetention}
            disabled={runningRetention}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {runningRetention ? 'Rodando…' : 'Rodar limpeza agora'}
          </button>
          {retentionMsg && (
            <p className={`mt-3 text-sm ${retentionMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
              {retentionMsg.text}
            </p>
          )}
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <p className="mb-2 text-xs text-[var(--text-tertiary)]">
              A limpeza automática de madrugada não deixou rastro de ter rodado — diagnóstico ao vivo dos workers:
            </p>
            <button
              onClick={handleCeleryDiagnostics}
              disabled={loadingDiag}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--hover-surface)] disabled:opacity-60"
            >
              {loadingDiag ? 'Consultando…' : 'Diagnóstico Celery'}
            </button>
            {celeryDiag && (
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] p-3 text-xs text-[var(--text-secondary)]">
                {JSON.stringify(celeryDiag, null, 2)}
              </pre>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
          <h3 className="mb-3.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Criar novo usuário</h3>
          {organizations?.length === 0 && (
            <p className="mb-3.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
              Nenhuma organização criada ainda, só dá pra criar usuário collaborator depois de ter uma. Crie a
              organização primeiro na aba{' '}
              <Link to="/organizacoes" className="underline">
                Organizações
              </Link>
              .
            </p>
          )}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <input
              type="text"
              placeholder="Nome"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputClass}
            />
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className={inputClass}
            />
          </div>
          {!form.withoutPassword && (
            <input
              type="password"
              placeholder="Senha (mín. 8 caracteres)"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
              className={`${inputClass} mt-2.5 w-full`}
            />
          )}
          <label className="mt-2.5 flex items-center gap-3 text-sm text-[var(--text-secondary)]">
            <Toggle
              checked={form.withoutPassword}
              onChange={(v) => setForm({ ...form, withoutPassword: v, password: '' })}
            />
            <span>Criar sem senha (a pessoa define a própria em /registrar)</span>
          </label>
          {form.withoutPassword && (
            <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">
              Use pra recriar manualmente uma conta que deveria ter vindo de uma compra na Cakto (ex: falha no
              webhook). A pessoa acessa app.scoutx.com.br/registrar com esse mesmo email pra escolher a senha.
            </p>
          )}
          {!form.admin && (
            <Select
              className="mt-2.5"
              value={form.organizationId}
              onChange={(v) => setForm({ ...form, organizationId: v })}
              placeholder="Selecione a organização…"
              options={(organizations || []).map((o) => ({ value: String(o.id), label: `${o.name} (${o.planLabel})` }))}
            />
          )}
          <div className="mt-3.5 flex items-center justify-between gap-3">
            <label className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
              <Toggle checked={form.admin} onChange={(v) => setForm({ ...form, admin: v })} />
              <span className="whitespace-nowrap">Já criar como admin</span>
            </label>
            <button onClick={handleCreate} disabled={creating} className="btn-primary px-4 py-2 text-sm">
              {creating ? 'Criando…' : 'Criar usuário'}
            </button>
          </div>
          {formMsg && (
            <p className={`mt-3 text-sm ${formMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{formMsg.text}</p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Concorrentes por usuário</h3>
        <p className="mb-3.5 text-sm text-[var(--text-tertiary)]">
          Cada usuário só vê os próprios concorrentes, isto aqui é a visão de auditoria, só pra admin. Um mesmo
          domínio cadastrado por duas pessoas conta pra cada uma (compartilham o dado raspado, mas cada uma tem sua
          própria lista).
        </p>

        <input
          type="text"
          placeholder="Buscar por domínio ou nome da loja (ex: naiastore.com)"
          value={trackerQuery}
          onChange={(e) => setTrackerQuery(e.target.value)}
          className={`${inputClass} mb-3.5 w-full max-w-sm`}
        />

        {trackerQuery.trim().length >= 2 && (
          <div className="mb-3.5 overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2.5">Loja</th>
                  <th className="px-3 py-2.5">Operação</th>
                  <th className="px-3 py-2.5">Rastreada por</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {trackerResults === null && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-[var(--text-muted)]">
                      Buscando…
                    </td>
                  </tr>
                )}
                {trackerResults?.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-[var(--text-muted)]">
                      Nenhuma loja encontrada com esse termo.
                    </td>
                  </tr>
                )}
                {trackerResults?.map((row) => (
                  <tr key={row.competitor_id}>
                    <td className="px-3 py-2.5">
                      <div className="text-[var(--text-primary)]">{row.name}</div>
                      <div className="text-xs text-[var(--text-muted)]">{row.domain}</div>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--text-tertiary)]">{operationLabel(row.operation)}</td>
                    <td className="px-3 py-2.5">
                      {row.tracker_user_ids.length === 0 ? (
                        <span className="text-xs text-[var(--text-muted)]">Órfã (ninguém rastreando)</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.tracker_user_ids.map((uid) => (
                            <span
                              key={uid}
                              className="rounded-full bg-[var(--hover-surface)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]"
                            >
                              {users?.find((u) => u.id === uid)?.name || `Usuário #${uid}`}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2.5">Usuário</th>
                <th className="px-3 py-2.5">Por operação</th>
                <th className="px-3 py-2.5">Total</th>
                <th className="px-3 py-2.5">Alertas gerados</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {competitorSummary?.map((row) => {
                const user = users?.find((u) => u.id === row.user_id)
                return (
                  <tr key={row.user_id}>
                    <td className="px-3 py-2.5 text-[var(--text-primary)]">{user?.name || `Usuário #${row.user_id}`}</td>
                    <td className="px-3 py-2.5 text-[var(--text-tertiary)]">
                      {Object.entries(row.by_operation)
                        .map(([op, count]) => `${operationLabel(op)}: ${count}`)
                        .join(' · ')}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--text-primary)]">{row.total}</td>
                    <td className="px-3 py-2.5 text-[var(--text-tertiary)]">{row.alerts_total ?? 0}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        to={`/concorrentes?as_user_id=${row.user_id}`}
                        className="text-xs font-medium text-brand-500 hover:underline"
                      >
                        Ver concorrentes ↗
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {competitorSummary?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-[var(--text-muted)]">
                    Ninguém cadastrou nenhum concorrente ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
            <ShieldCheck size={15} className="text-brand-500" /> Controle de acesso e segurança
          </h3>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">
            Só administradores veem esta tabela. IP repetido em várias contas ou uma conta logando de muitos IPs
            diferentes pode indicar senha compartilhada ou acesso indevido, vale checar.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <input
              type="text"
              placeholder="Buscar por nome ou email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${inputClass} w-56 py-1.5`}
            />
            <Select
              className="w-56"
              value={orgFilter}
              onChange={setOrgFilter}
              options={[
                { value: '', label: 'Todas as organizações' },
                ...(organizations || []).map((o) => ({ value: String(o.id), label: o.name })),
              ]}
            />
            <Select className="w-64" value={sortBy} onChange={setSortBy} options={SORT_OPTIONS} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Organização</th>
                <th className="px-3 py-2">Criado em</th>
                <th className="px-3 py-2">Admin</th>
                <th className="px-3 py-2">Permissões</th>
                <th className="px-3 py-2 text-right">Buscas</th>
                <th className="px-3 py-2">Último login</th>
                <th className="px-3 py-2">Atividade</th>
                <th className="px-3 py-2">IPs usados</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filteredUsers?.map((u) => {
                const extraIps = Math.max(0, (u.allIps?.length || 0) - 2)
                const risky = u.ipCount > 1
                return (
                  <tr key={u.id} className="hover:bg-[var(--bg-surface-2)]">
                    <td className="px-3 py-2.5 font-medium text-[var(--text-primary)]">
                      <div>{u.name}</div>
                      {(u.suspended || u.lockedUntil) && (
                        <div className="mt-1 flex flex-col items-start gap-1">
                          {u.suspended && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                              <Ban size={10} /> Suspenso
                            </span>
                          )}
                          {u.lockedUntil && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400"
                              title={u.lockedPermanently ? undefined : `Bloqueado até ${formatDateTime(u.lockedUntil)}`}
                            >
                              <Lock size={10} /> {u.lockedPermanently ? 'Precisa de reset' : 'Bloqueado'}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--text-tertiary)]">{u.email}</td>
                    <td className="min-w-[9rem] px-3 py-2.5">
                      {u.organizationName ? (
                        <div className="flex flex-col gap-1.5">
                          <button
                            onClick={() => setOrgFilter(String(u.organizationId))}
                            className="text-left font-medium text-[var(--text-secondary)] hover:text-brand-500 hover:underline"
                            title="Filtrar por essa organização"
                          >
                            {u.organizationName}
                          </button>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="whitespace-nowrap rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-500">
                              {u.organizationPlan}
                            </span>
                            {u.organizationExpiresAt &&
                              (new Date(u.organizationExpiresAt) < new Date() ? (
                                <span className="whitespace-nowrap rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                                  vencido
                                </span>
                              ) : (
                                <span className="whitespace-nowrap text-[10px] text-[var(--text-faint)]">
                                  {expiryCountdownLabel(u.organizationExpiresAt)}
                                </span>
                              ))}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              onClick={() => openPlanEditor(u)}
                              title="Trocar o plano dessa organização (ex: upgrade)"
                              className="inline-flex items-center gap-1 rounded-md border border-brand-500/30 bg-brand-500/10 px-2 py-1 text-[10px] font-semibold text-brand-500 transition-colors hover:border-brand-500/60 hover:bg-brand-500/20"
                            >
                              <RefreshCw size={11} /> Alterar plano
                            </button>
                            <button
                              onClick={() => openOrgPicker(u)}
                              title="Mover essa pessoa pra outra organização"
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] font-medium text-[var(--text-faint)] transition-colors hover:border-brand-500/40 hover:text-brand-500"
                            >
                              <ArrowRightLeft size={11} /> Trocar organização
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => openOrgPicker(u)}
                          title={u.role === 'admin' ? 'Tira o admin dessa conta e coloca num plano' : 'Coloca essa pessoa numa organização/plano'}
                          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-faint)] transition-colors hover:border-brand-500/60 hover:bg-brand-500/10 hover:text-brand-500"
                        >
                          <PlusCircle size={12} /> Adicionar plano
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">
                      {formatDateTime(u.createdAt)}
                      <div className="text-[var(--text-faint)]">há {tenureLabel(u.createdAt)}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Toggle
                        checked={u.role === 'admin'}
                        title={u.roleChangedAt ? `Alterado por ${u.roleChangedByName || '—'} em ${formatDateTime(u.roleChangedAt)}` : undefined}
                        onChange={(v) => togglePermission(u, 'role', v)}
                      />
                    </td>
                    <td className="min-w-[8.5rem] px-3 py-2.5">
                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-3 text-xs text-[var(--text-tertiary)]">
                          <Toggle checked={u.canAccessMinerador} onChange={(v) => togglePermission(u, 'canAccessMinerador', v)} />
                          <span className="whitespace-nowrap">ScoutX</span>
                        </label>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-tertiary)]">{u.searchCount}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(u.lastLoginAt)}</td>
                    <td className="px-3 py-2.5">
                      {isRecent(u.lastSeenAt, 10) ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                          <span className="h-2 w-2 rounded-full bg-emerald-400" /> Online
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                          <span className="h-2 w-2 rounded-full bg-[var(--text-faint)]" />
                          {u.lastSeenAt ? `Visto ${formatRelativeTime(u.lastSeenAt)}` : 'Nunca acessou'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {u.allIps?.length > 0 ? (
                        <button
                          onClick={() => viewIps(u)}
                          title="Clique para ver histórico completo (data de cada login)"
                          className={`flex flex-wrap items-center gap-1 rounded-lg px-1.5 py-1 text-left ${
                            risky ? 'bg-red-500/10 ring-1 ring-red-500/30' : 'hover:bg-[var(--hover-surface)]'
                          }`}
                        >
                          {risky && <AlertTriangle size={12} className="text-red-400" title="Mais de um IP nessa conta" />}
                          {u.allIps.slice(0, 2).map((ip) => (
                            <span
                              key={ip}
                              className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                                risky ? 'bg-red-500/15 text-red-400' : 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]'
                              }`}
                            >
                              {ip}
                            </span>
                          ))}
                          {extraIps > 0 && <span className="text-[11px] text-[var(--text-muted)]">+{extraIps}</span>}
                        </button>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">Nunca logou</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openPasswordEdit(u)}
                          title="Trocar senha"
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-brand-500"
                        >
                          <KeyRound size={15} />
                        </button>
                        <button
                          onClick={() => togglePermission(u, 'suspended', !u.suspended)}
                          title={u.suspended ? 'Reativar acesso' : 'Suspender acesso'}
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-amber-400"
                        >
                          {u.suspended ? <RotateCcw size={15} /> : <Ban size={15} />}
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          title="Remover usuário"
                          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-surface)] hover:text-red-400"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filteredUsers?.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-center text-[var(--text-muted)]">
                    Nenhum usuário encontrado com esse termo.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
        <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          <History size={14} /> Log de auditoria
        </h3>
        <p className="mb-3.5 text-sm text-[var(--text-tertiary)]">
          Toda ação administrativa fica registrada aqui: quem promoveu, suspendeu, resetou senha ou removeu quem, e
          quando. Últimas 100 ações.
        </p>
        {auditLog === null && <p className="text-sm text-[var(--text-muted)]">Carregando…</p>}
        {auditLog?.length === 0 && <p className="text-sm text-[var(--text-muted)]">Nenhuma ação administrativa registrada ainda.</p>}
        {auditLog && auditLog.length > 0 && (
          <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
            {auditLog.map((entry) => {
              const cfg = AUDIT_ACTIONS[entry.action] || AUDIT_ACTIONS.permission_changed
              const Icon = cfg.icon
              return (
                <div key={entry.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-[var(--hover-surface)]">
                  <Icon size={15} className={`mt-0.5 shrink-0 ${cfg.color}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[var(--text-secondary)]">{cfg.text(entry.actorName, entry.targetName)}</p>
                    {entry.details && <p className="text-xs text-[var(--text-muted)]">{entry.details}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]" title={formatDateTime(entry.createdAt)}>
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {ipDetail && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">IPs usados por {ipDetail.user.name}</h3>
            <button onClick={() => setIpDetail(null)} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-tertiary)]">
              Fechar ✕
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2.5">IP</th>
                  <th className="px-3 py-2.5">Logins</th>
                  <th className="px-3 py-2.5">Primeira vez</th>
                  <th className="px-3 py-2.5">Última vez</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {ipDetail.rows === null && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-[var(--text-muted)]">
                      Carregando…
                    </td>
                  </tr>
                )}
                {ipDetail.rows?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-[var(--text-muted)]">
                      Nenhum login registrado ainda.
                    </td>
                  </tr>
                )}
                {ipDetail.rows?.map((row, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.ip}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.count}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(row.firstAt)}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(row.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {passwordEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPasswordEdit(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Trocar senha de {passwordEdit.user.name}</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              A pessoa passa a usar essa senha nova pro próximo login, avise ela diretamente.
            </p>
            <input
              type="password"
              autoFocus
              placeholder="Nova senha (mín. 8 caracteres)"
              value={passwordEdit.value}
              onChange={(e) => setPasswordEdit({ ...passwordEdit, value: e.target.value, error: null })}
              onKeyDown={(e) => e.key === 'Enter' && submitPasswordEdit()}
              autoComplete="new-password"
              className={`${inputClass} mt-3 w-full`}
            />
            {passwordEdit.error && <p className="mt-2 text-xs text-red-400">{passwordEdit.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPasswordEdit(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitPasswordEdit} disabled={passwordEdit.saving} className="btn-primary px-4 py-2 text-xs">
                {passwordEdit.saving ? 'Salvando…' : 'Salvar nova senha'}
              </button>
            </div>
          </div>
        </div>
      )}

      {orgPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOrgPicker(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {orgPicker.demoting ? `Tirar admin de ${orgPicker.user.name}` : `Mover ${orgPicker.user.name} de organização`}
            </h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {orgPicker.demoting
                ? 'Selecione a organização/plano que essa pessoa vai usar como cliente. Sem isso, a conta fica sem plano nenhum.'
                : 'A pessoa passa a herdar o plano e os limites da organização escolhida.'}
            </p>
            <Select
              className="mt-3"
              value={orgPicker.value}
              onChange={(v) => setOrgPicker({ ...orgPicker, value: v, error: null })}
              placeholder="Selecione a organização…"
              options={(organizations || []).map((o) => ({ value: String(o.id), label: `${o.name} (${o.planLabel})` }))}
            />
            {orgPicker.error && <p className="mt-2 text-xs text-red-400">{orgPicker.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOrgPicker(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitOrgPicker} disabled={orgPicker.saving} className="btn-primary px-4 py-2 text-xs">
                {orgPicker.saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {planEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPlanEditor(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Alterar plano de {planEditor.user.organizationName}</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {planEditor.extendValidity
                ? 'Se ainda não venceu, a validade nova soma em cima da atual. Se já venceu, conta a partir de hoje.'
                : 'Só troca o plano, a data de validade continua exatamente a mesma que já estava.'}
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              <Select value={planEditor.plan} onChange={(v) => setPlanEditor({ ...planEditor, plan: v })} options={PLAN_OPTIONS} />
              <Select
                value={planEditor.billingCycle}
                onChange={(v) => setPlanEditor({ ...planEditor, billingCycle: v })}
                options={CYCLE_OPTIONS}
              />
              <label className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <input
                  type="checkbox"
                  checked={planEditor.extendValidity}
                  onChange={(e) => setPlanEditor({ ...planEditor, extendValidity: e.target.checked })}
                />
                Estender a validade (renovação de verdade, entrou dinheiro novo)
              </label>
              {!planEditor.extendValidity && (
                <p className="text-xs text-amber-500">
                  Upgrade/downgrade no meio do ciclo: use isso quando o cliente já pagou a diferença por fora e não deve
                  ganhar nem perder dias de validade.
                </p>
              )}
            </div>
            {planEditor.error && <p className="mt-2 text-xs text-red-400">{planEditor.error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPlanEditor(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitPlanEditor} disabled={planEditor.saving} className="btn-primary px-4 py-2 text-xs">
                {planEditor.saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
