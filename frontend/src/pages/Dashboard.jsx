import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Factory, Flame, Moon, MoonStar, Sun, Trophy, Zap } from 'lucide-react'
import { api } from '../api/client.js'
import StatCard from '../components/StatCard.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { ALERT_CATEGORIES, AlertTypeBadge, alertAccentClass } from '../components/Badges.jsx'
import NewProductsChart from '../components/NewProductsChart.jsx'
import AdsTimelineChart from '../components/AdsTimelineChart.jsx'
import ScoreDistributionChart from '../components/ScoreDistributionChart.jsx'
import ActivityHeatmap from '../components/ActivityHeatmap.jsx'
import DateRangeFilter from '../components/DateRangeFilter.jsx'
import Select from '../components/Select.jsx'
import LinkChip from '../components/LinkChip.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import ProductThumb from '../components/ProductThumb.jsx'
import PriceChangeRow from '../components/PriceChangeRow.jsx'
import { formatDateTime, formatRelativeTime, isRecent } from '../utils/date.js'
import { readCategoryVisits } from '../utils/alertsVisit.js'
import { useOperation } from '../context/OperationContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'

// Frase + ícone por faixa de horário — deixa o Dashboard menos "painel de
// dados frio" e mais alguém falando com você (pedido do usuário). Madrugada
// tem várias brincadeiras que trocam a cada acesso (pedido do usuário: nada
// fixo repetindo sempre a mesma frase); resto do dia varia o tom sem exagerar.
const MADRUGADA_JOKES = [
  (name) => `Essa hora ainda de olho nos concorrentes${name}? 🕵️`,
  (name) => `Madrugada é quando a concorrência menos espera${name} 😄`,
  (name) => `Café ou determinação${name}? 🌙`,
  (name) => `A cidade dorme, mas o painel não${name} ⚡`,
]

const MANHA_JOKES = [
  (name) => `Bom dia${name}! ☀️`,
  (name) => `Acordou já de olho no painel${name}? ☀️`,
  (name) => `Café na mão, concorrente no radar${name} ☕`,
  (name) => `Bom dia${name}! Bora ver quem mexeu ontem 👀`,
]

const TARDE_JOKES = [
  (name) => `Boa tarde${name}, hora de trabalhar! ⚡`,
  (name) => `Café da tarde analisando o concorrente${name}? ☕`,
  (name) => `Boa tarde${name}! Bora ver as novidades 👀`,
  (name) => `Tarde produtiva de olho na concorrência${name} ⚡`,
]

const NOITE_JOKES = [
  (name) => `Boa noite${name}! 🌆`,
  (name) => `Fechando o dia de olho no concorrente${name}? 🌆`,
  (name) => `Boa noite${name}! Última espiada antes de descansar 👀`,
  (name) => `Noite chegando, painel ainda ligado${name} 🌆`,
]

function pickJoke(pool, name) {
  return pool[Math.floor(Math.random() * pool.length)](name)
}

function greetingFor(hour, firstName) {
  const name = firstName ? `, ${firstName}` : ''
  if (hour < 5) return { text: pickJoke(MADRUGADA_JOKES, name), Icon: Moon }
  if (hour < 12) return { text: pickJoke(MANHA_JOKES, name), Icon: Sun }
  if (hour < 18) return { text: pickJoke(TARDE_JOKES, name), Icon: Zap }
  return { text: pickJoke(NOITE_JOKES, name), Icon: MoonStar }
}

const TODAY_LABEL = new Date().toLocaleDateString('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
})

export default function Dashboard() {
  const { operation } = useOperation()
  const { me } = useAuth()
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const [competitors, setCompetitors] = useState([])
  const [chartCompetitorId, setChartCompetitorId] = useState('')
  const [range, setRange] = useState({ mode: 'preset', days: 30 })
  const [highlights, setHighlights] = useState(null)
  const [heatmap, setHeatmap] = useState(null)
  const [alertsByCompetitor, setAlertsByCompetitor] = useState(null)
  const [alertsByCategory, setAlertsByCategory] = useState(null)
  const [discordConfigured, setDiscordConfigured] = useState(null)
  const [unreadCount, setUnreadCount] = useState(0)
  // Incrementado pelo botão "Atualizar" — só existe pra forçar os efeitos
  // abaixo a rodar de novo sem precisar dar F5 na página inteira.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    // Achado ao vivo (2026-08-28): sem essa guarda, se a operação mudasse
    // rápido (troca manual, ou o app se reajustando sozinho depois de um
    // tempo parado) e a resposta da operação ANTIGA chegasse depois da
    // nova (rede mais lenta por qualquer motivo, nem precisa de erro), ela
    // sobrescrevia os dados certos com os de outro país — o seletor lá em
    // cima já mostrava "Colômbia" certinho, mas os números embaixo (ex:
    // "Concorrentes ativos") continuavam sendo os do México. `cancelled`
    // ignora qualquer resposta que chegue depois que a operação já mudou de
    // novo, então só a busca mais recente pode atualizar a tela.
    let cancelled = false
    setSummary(null)
    setChartCompetitorId('')
    api
      .getDashboardSummary({ operation })
      .then((data) => !cancelled && setSummary(data))
      .catch((e) => !cancelled && setError(e.message))
    api
      .listCompetitors({ operation })
      .then((data) => !cancelled && setCompetitors(data))
      .catch(() => {})
    api
      .getDashboardHighlights({ operation })
      .then((data) => !cancelled && setHighlights(data))
      .catch(() => {})
    api
      .getActivityHeatmap({ operation, weeks: 12 })
      .then((data) => !cancelled && setHeatmap(data))
      .catch(() => {})
    api
      .getAlertsByCompetitor({ operation, days: 30 })
      .then((data) => !cancelled && setAlertsByCompetitor(data))
      .catch(() => {})
    api
      .getAlertsByCategory({ operation, days: 30 })
      .then((data) => !cancelled && setAlertsByCategory(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [operation, refreshKey])

  // Nudge do Discord: só checa 1x (não depende de operação) — se não tiver
  // webhook salvo em Minha Conta, o usuário só sabe de alerta abrindo o app.
  useEffect(() => {
    api.getDiscordWebhook().then((r) => setDiscordConfigured(!!r.discord_webhook_url)).catch(() => {})
  }, [refreshKey])

  // "N alertas novos desde sua última visita" — só LÊ a marca (não
  // sobrescreve): quem marca como visto é a própria aba Alertas, ao ser
  // aberta de verdade (mesmo padrão do WhatsApp — ver a prévia no
  // Dashboard não conta como "ler", só abrir a conversa conta).
  useEffect(() => {
    const visits = readCategoryVisits(operation)
    api.getAlertCounts({ operation, since_map: JSON.stringify(visits) }).then((r) => setUnreadCount(r.total)).catch(() => {})
  }, [operation, refreshKey])

  if (error) return <EmptyState title="Não deu pra carregar o dashboard" subtitle={error} />
  if (!summary) return <p className="text-sm text-[var(--text-muted)]">Carregando…</p>

  const { text: greetingText, Icon: GreetingIcon } = greetingFor(new Date().getHours(), me?.name?.split(' ')[0])

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-6">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute right-4 top-4 z-10">
          <RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />
        </div>
        <div className="relative flex flex-col items-center text-center">
          {/* Pastilha LED maior, só pra esse momento de destaque — mesma
              classe do menu (nav-icon-active), tamanho grande porque aqui é
              o centro das atenções do card, não um ícone de navegação. */}
          <div className="nav-icon-active mb-2.5 flex h-12 w-12 items-center justify-center rounded-2xl">
            <GreetingIcon size={22} strokeWidth={2.25} />
          </div>
          <h2 className="text-xl font-semibold">{greetingText}</h2>
          <p className="mt-1 text-sm capitalize text-[var(--text-muted)]">{TODAY_LABEL}</p>
        </div>
      </div>

      {(unreadCount > 0 || discordConfigured === false) && (
        <div className="flex flex-wrap gap-3">
          {unreadCount > 0 && (
            <Link
              to="/alertas"
              className="flex items-center gap-2 rounded-xl border border-brand-500/30 bg-brand-500/10 px-4 py-2.5 text-sm font-medium text-brand-500 transition-colors hover:bg-brand-500/20"
            >
              🔔 {unreadCount} {unreadCount === 1 ? 'alerta novo' : 'alertas novos'} desde sua última visita
            </Link>
          )}
          {discordConfigured === false && (
            <Link
              to="/conta"
              className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-brand-500/40 hover:text-brand-500"
            >
              💬 Configure o Discord pra receber alerta na hora, sem precisar ficar checando o app
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          icon="🏬"
          label="Concorrentes ativos"
          value={summary.active_competitors}
          hint={`${summary.total_competitors} cadastrados`}
          to="/concorrentes"
        />
        <StatCard icon="📦" label="Produtos monitorados" value={summary.total_products} to="/produtos" />
        <StatCard icon="🔥" label="Produtos Quentes" value={summary.hot_products} hint="score 56+/100" to="/produtos-quentes" />
        <StatCard icon="🔔" label="Alertas (24h)" value={summary.alerts_last_24h} to="/alertas" />
      </div>

      {highlights && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
              <Flame size={15} className="text-orange-400" /> Quem está bombando agora
            </h3>
            {highlights.trending_products.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Nenhum salto de score nos últimos 7 dias ainda.</p>
            ) : (
              <div className="space-y-2.5">
                {highlights.trending_products.map((p) => (
                  <Link
                    key={p.product_id}
                    to={`/produtos?q=${encodeURIComponent(p.title)}`}
                    className="flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--hover-surface)]"
                  >
                    <ProductThumb src={p.image_url} title={p.title} size="h-9 w-9" rounded="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{p.title}</p>
                      <p className="truncate text-[11px] text-[var(--text-muted)]">🏬 {p.competitor_name}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] font-bold text-orange-400">
                      +{p.delta}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
              <Trophy size={15} className="text-amber-400" /> Anúncios vencedores no ar
            </h3>
            {highlights.winning_ads.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Nenhum anúncio venceu (7+ dias ativo) ainda.</p>
            ) : (
              <div className="space-y-2.5">
                {highlights.winning_ads.map((ad) => (
                  <a
                    key={ad.id}
                    href={ad.library_url || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--hover-surface)]"
                  >
                    <ProductThumb src={ad.product_image_url} title={ad.product_title} size="h-9 w-9" rounded="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{ad.product_title || 'Anúncio sem produto vinculado'}</p>
                      <p className="truncate text-[11px] text-[var(--text-muted)]">🏬 {ad.competitor_name}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-400">
                      {ad.days_active}d
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
              <Factory size={15} className="text-violet-400" /> Fornecedor mudou recentemente
            </h3>
            {highlights.vendor_changes.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Nenhuma troca de fornecedor detectada ainda.</p>
            ) : (
              <div className="space-y-2.5">
                {highlights.vendor_changes.map((v) => (
                  <Link
                    key={v.id}
                    to={v.product_title ? `/produtos?q=${encodeURIComponent(v.product_title)}` : '/alertas?categoria=fornecedor'}
                    className="block rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)]"
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">🏬 {v.competitor_name}</span>
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{formatRelativeTime(v.created_at)}</span>
                    </div>
                    <p className="truncate text-[11px] text-[var(--text-secondary)]">{v.message}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {heatmap && heatmap.some((d) => d.count > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-1 text-base font-semibold">Atividade recente</h3>
            <p className="mb-3 text-xs text-[var(--text-muted)]">Alertas por dia nas últimas 12 semanas, bate o olho e vê se teve semana parada</p>
            <ActivityHeatmap data={heatmap} />
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-1 text-base font-semibold">Quem mais alertou</h3>
            <p className="mb-3 text-xs text-[var(--text-muted)]">Últimos 30 dias, quem tá puxando o heatmap pra cima</p>
            {alertsByCompetitor && alertsByCompetitor.length > 0 ? (
              <div className="space-y-2.5">
                {alertsByCompetitor.map((row, i) => {
                  const max = alertsByCompetitor[0].count || 1
                  const pct = Math.max(8, Math.round((row.count / max) * 100))
                  return (
                    <Link
                      key={row.competitor_id}
                      to={`/concorrentes/${row.competitor_id}`}
                      className="block rounded-lg p-1 transition-colors hover:bg-[var(--hover-surface)]"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium">
                          {i + 1}. {row.competitor_name}
                        </span>
                        <span className="shrink-0 font-bold text-brand-500">{row.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--hover-surface)]">
                        <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                      </div>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Nenhum alerta nos últimos 30 dias ainda.</p>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-1 text-base font-semibold">Alertas por categoria</h3>
            <p className="mb-3 text-xs text-[var(--text-muted)]">Últimos 30 dias</p>
            {alertsByCategory && Object.values(alertsByCategory).some((c) => c > 0) ? (
              <div className="space-y-2.5">
                {ALERT_CATEGORIES.map((cat) => {
                  const count = alertsByCategory[cat.key] || 0
                  const maxCount = Math.max(...Object.values(alertsByCategory), 1)
                  const pct = count ? Math.max(6, Math.round((count / maxCount) * 100)) : 0
                  return (
                    <div key={cat.key}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium">
                          {cat.icon} {cat.label}
                        </span>
                        <span className="shrink-0 font-bold text-[var(--text-secondary)]">{count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--hover-surface)]">
                        <div className="h-1.5 rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Nenhum alerta nos últimos 30 dias ainda.</p>
            )}
          </div>
        </div>
      )}

      {/* Filtros escopam TODOS os gráficos abaixo — uma linha só, acima de
          tudo, pra loja+período nunca desacordarem entre um gráfico e outro. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          className="w-48"
          value={chartCompetitorId}
          onChange={setChartCompetitorId}
          options={[{ value: '', label: 'Todas as lojas' }, ...competitors.map((c) => ({ value: String(c.id), label: c.name }))]}
        />
        <DateRangeFilter range={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 lg:col-span-2">
          <h3 className="mb-1 text-base font-semibold">Produtos novos por dia</h3>
          <p className="mb-2 text-xs text-[var(--text-muted)]">Quando cada loja sobe produto, queda e alta de verdade, dia a dia</p>
          <NewProductsChart competitorId={chartCompetitorId} operation={operation} range={range} />
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 lg:col-span-2">
          <h3 className="mb-1 text-base font-semibold">Anúncios encontrados por dia</h3>
          <p className="mb-2 text-xs text-[var(--text-muted)]">Por plataforma, ritmo de criativo novo indica se o concorrente tá escalando mídia</p>
          <AdsTimelineChart competitorId={chartCompetitorId} operation={operation} range={range} />
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
          <h3 className="mb-1 text-base font-semibold">Produtos por faixa de score</h3>
          <p className="mb-2 text-xs text-[var(--text-muted)]">Raio-x de agora, quantos produtos em cada faixa (Frio → Escalando)</p>
          <ScoreDistributionChart competitorId={chartCompetitorId} operation={operation} />
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">Últimos alertas</h3>
          <Link to="/alertas" className="text-sm text-brand-600 hover:underline">
            Ver todos
          </Link>
        </div>
        {summary.recent_alerts.length === 0 ? (
          <EmptyState
            title="Nenhum alerta ainda"
            subtitle="Assim que um concorrente for cadastrado e monitorado, os alertas aparecem aqui."
          />
        ) : (
          <div className="space-y-2.5">
            {summary.recent_alerts.map((alert) => (
              <div
                key={alert.id}
                className={`flex gap-3 rounded-2xl border border-[var(--border)] border-l-4 bg-[var(--bg-surface)] p-3.5 text-sm transition-colors hover:border-brand-500/40 ${alertAccentClass(alert.alert_type)}`}
              >
                <ProductThumb src={alert.product_image_url} title={alert.competitor_name} size="h-11 w-11" rounded="rounded-lg" />
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
                  <p className="leading-snug text-[var(--text-secondary)]">{alert.message}</p>
                  <PriceChangeRow payload={alert.payload} message={alert.message} />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
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
      </div>
    </div>
  )
}
