import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import { api } from '../api/client.js'
import EmptyState from '../components/EmptyState.jsx'
import Select from '../components/Select.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import { ClassificationBadge, StatusBadge } from '../components/Badges.jsx'
import { formatDateTime } from '../utils/date.js'
import { operationLabel, useOperation } from '../context/OperationContext.jsx'

// "Ordenar por" — mesmo padrão de HotProducts.jsx/Ads.jsx (Select em vez de
// vários botões/chip lado a lado). `default` é a ordem que o backend já
// devolve (created_at desc, mais recente cadastrado primeiro); as outras 3
// são só um sort client-side em cima da lista que já veio inteira (não é
// paginado, então não precisa ida-e-volta no back pra reordenar).
const SORT_OPTIONS = [
  { value: 'default', label: 'Mais recentes primeiro' },
  { value: 'products', label: 'Loja com mais produtos' },
  { value: 'hot', label: 'Lojas com mais produtos quentes' },
  { value: 'oldest', label: 'Lojas mais antigas no mercado' },
]

// Sem acento/maiúscula pra comparar — "espanha" acha "Espanhã" e por aí vai,
// não obriga a pessoa a digitar exatamente igual ao que está cadastrado.
function normalizeSearch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

function filterCompetitors(list, query) {
  const q = normalizeSearch(query)
  if (!q) return list
  return list.filter((c) => normalizeSearch(c.name).includes(q) || normalizeSearch(c.domain).includes(q))
}

function sortCompetitors(list, sort) {
  const sorted = [...list]
  if (sort === 'products') {
    sorted.sort((a, b) => (b.total_products || 0) - (a.total_products || 0))
  } else if (sort === 'hot') {
    sorted.sort((a, b) => (b.hot_products || 0) - (a.hot_products || 0))
  } else if (sort === 'oldest') {
    // "Mais antiga no mercado" = data de criação (na Shopify) do produto
    // ATIVO mais antigo da loja (oldest_product_at, calculado no backend) —
    // não a data em que NÓS cadastramos a loja. Loja sem nenhum produto com
    // essa data preenchida (raro, mas acontece) vai pro final, não pro topo.
    sorted.sort((a, b) => {
      if (!a.oldest_product_at && !b.oldest_product_at) return 0
      if (!a.oldest_product_at) return 1
      if (!b.oldest_product_at) return -1
      return new Date(a.oldest_product_at) - new Date(b.oldest_product_at)
    })
  }
  return sorted
}

// Sem campo de logo no backend — puxa o favicon direto do domínio via
// serviço do Google (sem chave, funciona pra qualquer site). Se falhar
// (loja bloqueia hotlink, favicon não existe etc.), cai pra um avatar com a
// inicial do nome, nunca deixa buraco vazio no card.
function CompetitorLogo({ domain, name }) {
  const [failed, setFailed] = useState(false)
  if (failed || !domain) {
    return (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/15 text-sm font-bold text-brand-500">
        {(name || domain || '?').charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?sz=64&domain=${domain}`}
      alt=""
      onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded-xl border border-[var(--border)] bg-white object-contain p-1"
    />
  )
}

export default function Competitors() {
  const { operation, planLimit, atCompetitorCap } = useOperation()
  const [searchParams, setSearchParams] = useSearchParams()
  // Só admin consegue popular isso de verdade (link vem da tela de
  // Usuários) — o backend também confere (resolve_target_user em
  // api/deps.py), isto aqui só decide o que MOSTRAR: modo auditoria é
  // somente leitura, não faz sentido admin cadastrar/excluir em nome de
  // outra pessoa.
  const asUserId = searchParams.get('as_user_id')
  const sort = searchParams.get('sort') || 'default'
  const [competitors, setCompetitors] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ domain: '', name: '', niche: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)
  const [formSuccess, setFormSuccess] = useState(null)
  const successTimeoutRef = useRef(null)
  const [deletingId, setDeletingId] = useState(null)
  const [deleteModal, setDeleteModal] = useState(null)
  const pollRef = useRef(null)
  const requestIdRef = useRef(0)

  const visibleCompetitors = useMemo(
    () => (competitors ? sortCompetitors(filterCompetitors(competitors, search), sort) : []),
    [competitors, search, sort]
  )

  function load() {
    // BUG corrigido (achado ao vivo, 2026-08-28): no modo auditoria
    // (as_user_id, "Ver concorrentes" na aba Usuários), filtrar por
    // `operation` usava o país que está selecionado no seletor do PRÓPRIO
    // ADMIN — sem relação nenhuma com os países que o usuário auditado de
    // fato usa. Se o admin estivesse vendo "Colômbia" e a pessoa auditada
    // só tivesse concorrente em "México", a lista vinha vazia mesmo com
    // dado de verdade cadastrado. Auditoria deve mostrar TODOS os países
    // dessa pessoa, não filtrar pelo que o admin está olhando no momento.
    //
    // BUG corrigido (achado ao vivo, 2026-08-28, "voltei do PC parado, tava
    // no seletor Colômbia mas os números eram do México"): sem trava de
    // request, se `operation` mudasse rápido (troca manual ou o app se
    // reajustando sozinho) e a resposta da operação ANTIGA chegasse depois
    // da nova (rede mais lenta, sem nem precisar de erro), ela sobrescrevia
    // os dados certos. requestIdRef garante que só a resposta da chamada
    // MAIS RECENTE (seja do efeito, do botão Atualizar, ou do polling de
    // "checking" acima) pode atualizar a tela — qualquer uma que chegue
    // atrasada é ignorada.
    const requestId = ++requestIdRef.current
    return api
      .listCompetitors({ operation: asUserId ? undefined : operation, as_user_id: asUserId || undefined })
      .then((list) => {
        if (requestId !== requestIdRef.current) return
        setCompetitors(list)
        // Enquanto tiver concorrente "checking" (verificação + raio-x
        // rodando em background — ver tasks/onboarding.py), continua
        // atualizando a lista sozinho até virar "active"/"not_shopify",
        // sem precisar a pessoa dar F5 pra ver o resultado.
        clearTimeout(pollRef.current)
        if (list.some((c) => c.status === 'checking')) {
          pollRef.current = setTimeout(load, 6000)
        }
      })
      .catch((e) => requestId === requestIdRef.current && setError(e.message))
  }

  useEffect(() => {
    load()
    return () => clearTimeout(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, asUserId])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.domain.trim()) return
    setSubmitting(true)
    setFormError(null)
    setFormSuccess(null)
    try {
      await api.createCompetitor({
        domain: form.domain.trim(),
        name: form.name.trim() || null,
        niche: form.niche.trim() || null,
        tags: [],
        operation,
      })
      setForm({ domain: '', name: '', niche: '' })
      load()
      setFormSuccess('Concorrente adicionado com sucesso!')
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = setTimeout(() => setFormSuccess(null), 5000)
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => () => clearTimeout(successTimeoutRef.current), [])

  function handleDelete(c) {
    setDeleteModal({ competitor: c, error: null })
  }

  async function submitDelete() {
    if (!deleteModal) return
    const c = deleteModal.competitor
    setDeletingId(c.id)
    try {
      await api.deleteCompetitor(c.id)
      setDeleteModal(null)
      load()
    } catch (err) {
      setDeleteModal({ ...deleteModal, error: err.message || 'Não foi possível excluir.' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Concorrentes</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Lojas Shopify monitoradas diariamente, operação {operationLabel(operation)}
          </p>
        </div>
        <RefreshButton onRefresh={load} />
      </div>

      {asUserId && (
        <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="text-sm text-amber-400">
            👁️ Vendo a lista do usuário #{asUserId} (modo auditoria, só leitura).
          </p>
          <button
            onClick={() => setSearchParams({})}
            className="text-xs font-medium text-amber-400 hover:underline"
          >
            Voltar pra minha lista
          </button>
        </div>
      )}

      {!asUserId && atCompetitorCap && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
          📦 Sua organização atingiu o limite de {planLimit.maxCompetitors} concorrentes cadastrados do plano, fale
          com um administrador pra liberar mais, ou remova um concorrente antes de cadastrar outro.
        </div>
      )}

      {!asUserId && (
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Domínio *</label>
            <input
              required
              placeholder="lojaexemplo.com"
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              className="w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Nome</label>
            <input
              placeholder="Opcional"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-48 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Nicho</label>
            <input
              placeholder="Opcional"
              value={form.niche}
              onChange={(e) => setForm({ ...form, niche: e.target.value })}
              className="w-40 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
            />
          </div>
          <button type="submit" disabled={submitting || atCompetitorCap} className="btn-primary">
            {submitting ? 'Adicionando…' : '+ Adicionar concorrente'}
          </button>
          {formError && <p className="w-full text-sm text-red-600">{formError}</p>}
          {formSuccess && <p className="w-full text-sm text-green-600">✓ {formSuccess}</p>}
        </form>
      )}

      {competitors && competitors.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Buscar loja</label>
            <div className="relative w-full max-w-xs">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
              <input
                type="text"
                placeholder="Nome ou domínio…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] py-2 pl-9 pr-8 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  title="Limpar busca"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Ordenar por</label>
            <Select
              className="w-64"
              value={sort}
              onChange={(v) => {
                const next = new URLSearchParams(searchParams)
                if (!v || v === 'default') next.delete('sort')
                else next.set('sort', v)
                setSearchParams(next)
              }}
              options={SORT_OPTIONS}
            />
          </div>
        </div>
      )}

      {error && <EmptyState title="Não deu pra carregar os concorrentes" subtitle={error} />}

      {competitors && competitors.length === 0 && (
        <EmptyState
          title="Nenhum concorrente cadastrado"
          subtitle="Adicione um domínio Shopify acima pra começar o monitoramento."
        />
      )}

      {competitors && competitors.length > 0 && visibleCompetitors.length === 0 && (
        <EmptyState
          title="Nenhuma loja encontrada"
          subtitle={`Nada bate com "${search}" — confira a grafia ou limpe a busca.`}
        />
      )}

      {visibleCompetitors.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleCompetitors.map((c) => (
            <div
              key={c.id}
              className="group relative flex flex-col gap-2.5 overflow-hidden rounded-2xl border-2 border-[var(--border)] bg-[var(--bg-surface)] p-3.5 transition-colors hover:border-brand-500/50"
            >
              <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gradient-to-br from-brand-500/20 to-transparent blur-2xl transition-opacity group-hover:opacity-90" />

              <div className="relative flex items-center gap-2.5">
                <CompetitorLogo domain={c.domain} name={c.name} />
                <div className="min-w-0 flex-1">
                  <Link to={`/concorrentes/${c.id}`} className="block truncate text-sm font-semibold text-[var(--text-primary)] hover:text-brand-500">
                    {c.name}
                  </Link>
                  <p className="truncate text-xs text-[var(--text-muted)]">{c.domain}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={c.status} />
                <ClassificationBadge classification={c.classification} />
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl bg-[var(--bg-surface-2)] p-2.5 text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Produtos</p>
                  <p className="font-semibold text-[var(--text-primary)]">{c.total_products}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">🔥 Quentes</p>
                  <p className={`font-semibold ${c.hot_products > 0 ? 'text-orange-400' : 'text-[var(--text-primary)]'}`}>
                    {c.hot_products}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Volume/dia</p>
                  <p className="font-semibold text-[var(--text-primary)]">
                    {c.avg_daily_volume != null ? c.avg_daily_volume : <span className="text-[11px] font-normal text-[var(--text-muted)]">—</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Verificado</p>
                  <p className="text-[11px] text-[var(--text-secondary)]">{formatDateTime(c.last_checked_at)}</p>
                </div>
              </div>

              {!asUserId && (
                <div className="mt-auto flex items-center justify-end gap-2.5 pt-0.5">
                  <button
                    onClick={() => handleDelete(c)}
                    disabled={deletingId === c.id}
                    title="Excluir concorrente (apaga produtos, anúncios e alertas dele)"
                    className="text-[11px] font-medium text-[var(--text-muted)] hover:text-red-400 disabled:opacity-50"
                  >
                    {deletingId === c.id ? 'Excluindo…' : '🗑️ Excluir'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteModal(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5">
              <CompetitorLogo domain={deleteModal.competitor.domain} name={deleteModal.competitor.name} />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">
                  Excluir "{deleteModal.competitor.name}"?
                </h3>
                <p className="truncate text-xs text-[var(--text-muted)]">{deleteModal.competitor.domain}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Isso apaga todo o histórico de produtos, anúncios e alertas dessa loja. Não dá pra desfazer.
            </p>
            {deleteModal.error && (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {deleteModal.error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteModal(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button
                onClick={submitDelete}
                disabled={deletingId === deleteModal.competitor.id}
                className="rounded-full bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {deletingId === deleteModal.competitor.id ? 'Excluindo…' : 'Excluir loja'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
