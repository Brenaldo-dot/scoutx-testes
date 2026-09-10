import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, DollarSign, Factory, LayoutGrid, Lock, Megaphone, Package, Rocket } from 'lucide-react'
import { api } from '../api/client.js'
import EmptyState from '../components/EmptyState.jsx'
import Pagination from '../components/Pagination.jsx'
import { ALERT_CATEGORIES, AlertTypeBadge, alertAccentClass } from '../components/Badges.jsx'
import LinkChip from '../components/LinkChip.jsx'
import ProductThumb from '../components/ProductThumb.jsx'
import PriceChangeRow from '../components/PriceChangeRow.jsx'
import LedIcon from '../components/LedIcon.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import FilteringIndicator from '../components/FilteringIndicator.jsx'
import { formatDateTime, formatRelativeTime, isRecent } from '../utils/date.js'
import { readCategoryVisits, markCategoryVisited } from '../utils/alertsVisit.js'
import { useOperation } from '../context/OperationContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'

const PAGE_SIZE = 50

// Emoji cru nos filtros ("📦 Produto", "🏭 Fornecedor"...) destoava do resto
// do app depois da troca do menu pra ícone-em-pastilha-LED — mesmo
// tratamento aqui, por categoria.
const CATEGORY_ICONS = {
  produto: Package,
  fornecedor: Factory,
  anuncios: Megaphone,
  escala: Rocket,
  preco_estoque: DollarSign,
  outros: AlertTriangle,
}

// Bolinha de não lido tipo WhatsApp — só aparece com contagem > 0, some
// sozinha na próxima visita (a marca de "visto" já foi atualizada pra agora
// assim que a página abriu, ver useEffect abaixo).
function UnreadDot({ count }) {
  if (!count) return null
  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-md ring-2 ring-[var(--bg-page)]">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function Alerts() {
  const { operation } = useOperation()
  const { me } = useAuth()
  // Standard (chave interna "solo") só vê as 5 notificações mais recentes,
  // sempre na visão "Todos" — o back já ignora `category` e trava o limite
  // pra esse plano (backend/app/api/alerts.py), isso aqui só reflete a MESMA
  // regra na tela (categoria sempre aparece como "Todos" selecionado, nunca
  // deixa clicar numa categoria) em vez de deixar a pessoa "selecionar" uma
  // aba que o back vai ignorar silenciosamente.
  const isStandardPlan = me?.plan === 'solo'
  const [searchParams, setSearchParams] = useSearchParams()
  const category = isStandardPlan ? '' : searchParams.get('categoria') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)

  const [alerts, setAlerts] = useState(null)
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState(null)
  const [unreadCounts, setUnreadCounts] = useState(null)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filtering, setFiltering] = useState(false)

  // `cancelled` nos três efeitos abaixo (achado ao vivo, 2026-08-28, mesmo
  // bug do Dashboard): sem essa trava, se a operação mudasse rápido e a
  // resposta da operação ANTIGA chegasse depois da nova, ela sobrescrevia
  // os números/lista certos com os de outro país.
  useEffect(() => {
    let cancelled = false
    api
      .getAlertCounts({ operation })
      .then((data) => !cancelled && setCounts(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [operation, refreshKey])

  // Contagem de não lido por categoria — cada uma com seu próprio corte
  // (ver utils/alertsVisit.js). Só abrir a aba Alertas (visão "Todos") não
  // marca nada como lido; isso só acontece ao clicar numa categoria de
  // verdade, em selectCategory abaixo.
  useEffect(() => {
    let cancelled = false
    const visits = readCategoryVisits(operation)
    api
      .getAlertCounts({ operation, since_map: JSON.stringify(visits) })
      .then((data) => !cancelled && setUnreadCounts(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [operation, refreshKey])

  useEffect(() => {
    // Revisão (achado ao vivo, 2026-08-27): trocar de categoria mantinha a
    // lista ANTIGA na tela sem indicação nenhuma de que algo estava
    // carregando — parecia travado. `filtering` liga um indicador
    // pequeno, sem sumir com o conteúdo atual.
    let cancelled = false
    setFiltering(true)
    api
      .listAlerts({ operation, category: category || undefined, page, limit: PAGE_SIZE })
      .then(({ items, total }) => {
        if (cancelled) return
        setAlerts(items)
        setTotal(total)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setFiltering(false))
    return () => {
      cancelled = true
    }
  }, [operation, category, page, refreshKey])

  function selectCategory(key) {
    // Standard não navega pra categoria nenhuma (botão fica desabilitado,
    // ver render abaixo) — trava aqui também, defesa extra caso o clique
    // escape do `disabled` de algum jeito.
    if (key && isStandardPlan) return
    // "Todos" (key vazio) é só visão geral, não marca nada como lido — cada
    // categoria só some quando a pessoa clica nela de verdade.
    if (key) {
      markCategoryVisited(operation, key)
      setUnreadCounts((prev) => {
        const cleared = prev?.by_category?.[key] || 0
        if (!cleared) return prev
        return {
          ...prev,
          total: Math.max(0, (prev.total || 0) - cleared),
          by_category: { ...prev.by_category, [key]: 0 },
        }
      })
    }
    const next = new URLSearchParams(searchParams)
    if (key) next.set('categoria', key)
    else next.delete('categoria')
    next.delete('page')
    setSearchParams(next)
  }

  function goToPage(nextPage) {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) next.delete('page')
    else next.set('page', String(nextPage))
    setSearchParams(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-semibold">Alertas</h2>
              <FilteringIndicator show={filtering} />
            </div>
            <p className="text-sm text-[var(--text-muted)]">
              Separado por assunto: fornecedor, anúncios, produto etc., cada um no seu canto, em vez de um fluxo só
              misturando tudo. Histórico completo, sempre: nada some por causa de outro alerta mais novo.
            </p>
          </div>
          <RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />
        </div>
        {isStandardPlan && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400">
            🔒 Plano Standard mostra só as 5 notificações mais recentes, tudo junto. Categorias separadas (Produto,
            Fornecedor, Anúncios…) e o histórico completo são exclusivos do plano Pro.
          </div>
        )}
      </div>

      {counts && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => selectCategory('')}
            className={`relative flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-sm font-medium transition-colors ${
              category === '' ? 'border-brand-600 bg-brand-600 text-white' : 'border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]'
            }`}
          >
            {category === '' ? <LayoutGrid size={14} /> : <LedIcon Icon={LayoutGrid} />}
            Todos ({counts.total})
          </button>
          {ALERT_CATEGORIES.map((cat) => {
            const CatIcon = CATEGORY_ICONS[cat.key]
            const locked = isStandardPlan
            return (
              <button
                key={cat.key}
                onClick={() => selectCategory(cat.key)}
                disabled={locked || !counts.by_category[cat.key]}
                title={locked ? 'Disponível no plano Pro, assine pra separar os alertas por categoria.' : undefined}
                className={`relative flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  category === cat.key
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]'
                }`}
              >
                {locked ? <Lock size={13} /> : category === cat.key ? <CatIcon size={14} /> : <LedIcon Icon={CatIcon} />}
                {cat.label} ({counts.by_category[cat.key] || 0})
                {!locked && <UnreadDot count={unreadCounts?.by_category?.[cat.key]} />}
              </button>
            )
          })}
        </div>
      )}

      {error && <EmptyState title="Não deu pra carregar os alertas" subtitle={error} />}

      {alerts && alerts.length === 0 && (
        <EmptyState
          title="Nenhum alerta aqui ainda"
          subtitle={
            category
              ? 'Nenhum alerta dessa categoria até agora.'
              : 'Cadastre um concorrente pra começar a receber alertas.'
          }
        />
      )}

      {alerts && alerts.length > 0 && (
        <div className="space-y-2.5">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`flex gap-3 rounded-2xl border border-[var(--border)] border-l-4 bg-[var(--bg-surface)] p-4 transition-colors hover:border-brand-500/40 ${alertAccentClass(alert.alert_type)}`}
            >
              <ProductThumb src={alert.product_image_url} title={alert.competitor_name} size="h-12 w-12" rounded="rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <AlertTypeBadge type={alert.alert_type} />
                  <span className="rounded-full bg-[var(--hover-surface)] px-2 py-0.5 text-xs font-medium text-[var(--text-tertiary)]">
                    🏬 {alert.competitor_name}
                  </span>
                  {isRecent(alert.created_at) && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                      Novo
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-[var(--text-muted)]" title={formatDateTime(alert.created_at)}>
                    {formatRelativeTime(alert.created_at)}
                  </span>
                </div>
                <p className="text-sm leading-snug text-[var(--text-secondary)]">{alert.message}</p>
                <PriceChangeRow payload={alert.payload} message={alert.message} />
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {alert.product_title && (
                    <LinkChip to={`/produtos?q=${encodeURIComponent(alert.product_title)}`} variant="neutral">
                      🔎 Buscar em Produtos
                    </LinkChip>
                  )}
                  <LinkChip href={alert.product_url} variant="brand">
                    🔗 Ver produto ↗
                  </LinkChip>
                  <LinkChip href={alert.ad_library_url} variant="violet">
                    📣 Ver na biblioteca ↗
                  </LinkChip>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isStandardPlan && alerts && alerts.length > 0 && (
        <p className="text-center text-xs text-[var(--text-muted)]">
          Mostrando as {alerts.length} notificações mais recentes
          {counts?.total > alerts.length ? ` de ${counts.total}` : ''}, assine o plano Pro pra ver o histórico
          completo, sem limite.
        </p>
      )}

      {!isStandardPlan && alerts && alerts.length > 0 && (
        <Pagination page={page} totalPages={totalPages} total={total} onChange={goToPage} />
      )}
    </div>
  )
}
