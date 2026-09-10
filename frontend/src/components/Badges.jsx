// Cor de marca de cada plataforma — não a paleta genérica do resto do app,
// de propósito: aqui o objetivo é bater o olho e reconhecer Meta/Google/
// TikTok na hora, não seguir a linguagem visual interna dos outros badges.
const PLATFORM_STYLES = {
  meta: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  google: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  tiktok: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
}

const PLATFORM_LABELS = {
  meta: 'Meta',
  google: 'Google',
  tiktok: 'TikTok',
}

// Mesmas cores de marca do badge acima, em hex — Recharts precisa de cor
// crua (fill/stroke), não dá pra usar classe Tailwind ali. "Cor segue a
// entidade" (guia de dataviz): Meta/Google/TikTok sempre a mesma cor em
// qualquer gráfico do app, não é uma paleta categórica genérica. Validado
// com scripts/validate_palette.js da skill de dataviz (a dupla laranja/rosa
// original — orange-700+pink-700 — não passava no piso de visão normal:
// ΔE 11.7, abaixo do mínimo 15).
export const PLATFORM_HEX = {
  meta: '#1d4ed8',
  google: '#b45309',
  tiktok: '#9d174d',
}

export function PlatformBadge({ platform }) {
  const style = PLATFORM_STYLES[platform] || 'bg-[var(--hover-surface)] text-[var(--text-tertiary)] border-[var(--border)]'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase ${style}`}>
      {PLATFORM_LABELS[platform] || platform}
    </span>
  )
}

const STATUS_STYLES = {
  checking: 'bg-amber-500/15 text-amber-400',
  active: 'bg-emerald-500/15 text-emerald-400',
  paused: 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]',
  not_shopify: 'bg-red-500/15 text-red-400',
}

const STATUS_LABELS = {
  checking: '🔍 Verificando…',
  active: 'Ativo',
  paused: 'Pausado',
  not_shopify: 'Não é Shopify',
}

export function StatusBadge({ status }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] || 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]'}`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  )
}

const CLASS_STYLES = {
  testando: 'bg-amber-500/15 text-amber-400',
  operacao_media: 'bg-blue-500/15 text-blue-400',
  escalando: 'bg-violet-500/15 text-violet-400',
}

const CLASS_LABELS = {
  testando: 'Testando',
  operacao_media: 'Operação média',
  escalando: 'Escalando',
}

export function ClassificationBadge({ classification }) {
  if (!classification) return <span className="text-xs text-[var(--text-muted)]">—</span>
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CLASS_STYLES[classification] || 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]'}`}
    >
      {CLASS_LABELS[classification] || classification}
    </span>
  )
}

// Faixas do Módulo 5: 0–30 Frio, 31–55 Morno, 56–79 Quente, 80–100 Escalando.
const SCORE_LABEL_STYLES = {
  Frio: 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]',
  Morno: 'bg-amber-500/15 text-amber-400',
  Quente: 'bg-orange-500/15 text-orange-400',
  Escalando: 'bg-red-500/15 text-red-400',
}

// Rampa ordinal 1-hue-só (vermelho, claro→escuro) pro gráfico de barra —
// diferente das 4 cores do badge acima de propósito: o badge é lido isolado
// (não precisa de ordem perceptual), mas aqui as 4 faixas ficam lado a lado
// e viram uma comparação direta, onde a regra do guia de dataviz vale igual
// (1 hue, luminosidade monótona) — a mistura slate/amber/orange/red do badge
// falhou no validador (matiz espalhado 130°, dois degraus quase idênticos).
// Validado com scripts/validate_palette.js --ordinal.
export const SCORE_LABEL_HEX = {
  Frio: '#f87171',
  Morno: '#dc2626',
  Quente: '#b91c1c',
  Escalando: '#7f1d1d',
}

export function ScoreBadge({ score, label }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${SCORE_LABEL_STYLES[label] || 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]'}`}
    >
      {score} · {label}
    </span>
  )
}

// Anúncio no ar há 30+ dias é sinal quase certo de operação vencedora, 14-29
// já é forte indício, 7-13 é sinal fraco-a-médio — a cor sobe de intensidade
// junto (cinza → âmbar → laranja → vermelho), mesma rampa de calor usada no
// ScoreBadge, pra bater o olho sem precisar ler o número.
function daysActiveStyle(days) {
  if (days >= 30) return 'bg-red-500/15 text-red-400'
  if (days >= 14) return 'bg-orange-500/15 text-orange-400'
  if (days >= 7) return 'bg-amber-500/15 text-amber-400'
  return 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]'
}

export function DaysActiveBadge({ days, title }) {
  if (days == null) return null
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${daysActiveStyle(days)}`} title={title}>
      📅 {days}d ativo
    </span>
  )
}

// Ícone + cor por tipo de sinal de escala (scoring_service.py) — cada sinal
// já tinha um ícone fixo espalhado em HotProducts.jsx; centralizado aqui e
// com cor própria por sinal, pra "anúncios crescendo" e "páginas duplicadas"
// pararem de se misturar visualmente com o resto (mesma cor cinza de tudo).
const SIGNAL_STYLES = [
  [/^anuncio_ativo/, '📢', 'bg-blue-500/15 text-blue-400'],
  [/^anuncios_crescendo/, '🚀', 'bg-violet-500/15 text-violet-400'],
  [/^paginas_duplicadas/, '📄', 'bg-orange-500/15 text-orange-400'],
  [/^fornecedor_mudou/, '🔄', 'bg-amber-500/15 text-amber-400'],
  [/^estoque_caindo/, '📦', 'bg-red-500/15 text-red-400'],
  [/^variacoes_aumentaram/, '🎨', 'bg-blue-500/15 text-blue-400'],
]

export function SignalChip({ signal }) {
  const match = SIGNAL_STYLES.find(([re]) => re.test(signal))
  const [, icon, style] = match || [null, '•', 'bg-[var(--hover-surface)] text-[var(--text-tertiary)]']
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {icon} {signal.replace(/_/g, ' ')}
    </span>
  )
}

export function ScalingBadge({ scaling }) {
  if (!scaling) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-400">
      🚀 Escalando
    </span>
  )
}

// duplicateCount = quantas OUTRAS páginas foram agrupadas com essa (mesmo
// supplier_id ou imagem reaproveitada — scrapers/duplicate_detector.py).
// O tooltip (hover) mostra quais, sem precisar de mais uma tela.
export function DuplicateBadge({ duplicateCount, duplicateOf }) {
  if (!duplicateCount) return null
  const titles = (duplicateOf || []).map((d) => d.title).join(' · ')
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-400"
      title={titles ? `Mesma oferta de:\n${titles}` : undefined}
    >
      📄 duplicado ({duplicateCount}x)
    </span>
  )
}

// Verde = tem código de fornecedor confirmado; vermelho = não tem. A cor
// facilita bater o olho na tabela inteira sem precisar ler célula por célula.
export function SupplierIdTag({ supplierId }) {
  if (!supplierId) {
    return (
      <span
        className="inline-block whitespace-nowrap rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-400"
        title="Nenhum código de fornecedor confirmado pra este produto"
      >
        Fornecedor não cadastrado
      </span>
    )
  }
  return (
    <span
      className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-xs text-emerald-400"
      title="Código de fornecedor confirmado"
    >
      {supplierId}
    </span>
  )
}

const ALERT_LABELS = {
  new_product: 'Novo produto',
  product_removed: 'Produto removido',
  price_change: 'Mudança de preço',
  stock_change: 'Mudança de estoque',
  variations_added: 'Novas variações',
  title_change: 'Título mudou',
  image_change: 'Imagem mudou',
  urgency_detected: 'Urgência detectada',
  vendor_changed: 'Fornecedor trocou',
  supplier_id_changed: 'Cód. fornecedor mudou',
  duplicate_detected: 'Duplicado detectado',
  scaling_detected: 'Escalando',
  new_ad: 'Novo anúncio',
  winning_ad: 'Anúncio vencedor',
  ad_killed: 'Anúncio morreu',
  not_shopify: 'Não é Shopify',
}

export function alertLabel(type) {
  return ALERT_LABELS[type] || type
}

// Categoria — pra separar o feed de alerta por assunto (usuário pediu:
// fornecedor mudou num lugar, anúncio em outro) em vez de um único fluxo
// cronológico misturando tudo. Ordem aqui também é a ordem das abas na tela.
export const ALERT_CATEGORIES = [
  {
    key: 'produto',
    label: 'Produto novo/sumiu',
    icon: '📦',
    types: ['new_product', 'product_removed'],
  },
  {
    key: 'fornecedor',
    label: 'Fornecedor',
    icon: '🏭',
    types: ['vendor_changed', 'supplier_id_changed'],
  },
  {
    key: 'anuncios',
    label: 'Anúncios',
    icon: '📣',
    types: ['new_ad', 'winning_ad', 'ad_killed'],
  },
  {
    key: 'escala',
    label: 'Sinais de escala',
    icon: '🚀',
    types: ['scaling_detected', 'duplicate_detected', 'variations_added'],
  },
  {
    key: 'preco_estoque',
    label: 'Preço e estoque',
    icon: '💲',
    types: ['price_change', 'stock_change'],
  },
  {
    key: 'outros',
    label: 'Outros',
    icon: '⚠️',
    types: ['not_shopify', 'title_change', 'image_change', 'urgency_detected'],
  },
]

const TYPE_TO_CATEGORY = Object.fromEntries(
  ALERT_CATEGORIES.flatMap((cat) => cat.types.map((type) => [type, cat.key])),
)

export function alertCategory(type) {
  return TYPE_TO_CATEGORY[type] || 'outros'
}

// Cor por tipo de alerta — a mesma linguagem visual dos outros badges
// (verde/roxo pra sinal positivo, vermelho pra negativo, azul pra neutro),
// pra bater o olho e já saber o tipo sem ler o texto inteiro.
const ALERT_TYPE_STYLES = {
  new_product: 'bg-green-900/40 text-green-500 border-green-700/40',
  stock_change: 'bg-red-500/15 text-red-400 border-red-500/30',
  variations_added: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  new_ad: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  price_change: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  urgency_detected: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  vendor_changed: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  supplier_id_changed: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  duplicate_detected: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  scaling_detected: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  winning_ad: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  product_removed: 'bg-red-500/15 text-red-400 border-red-500/30',
  ad_killed: 'bg-red-500/15 text-red-400 border-red-500/30',
  not_shopify: 'bg-red-500/15 text-red-400 border-red-500/30',
}

export function AlertTypeBadge({ type }) {
  const style = ALERT_TYPE_STYLES[type] || 'bg-[var(--hover-surface)] text-[var(--text-tertiary)] border-[var(--border)]'
  return (
    <span className={`inline-block shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${style}`}>
      {alertLabel(type)}
    </span>
  )
}

// Mesmo agrupamento de cor de ALERT_TYPE_STYLES acima, só que como borda
// sólida (não translúcida) — usada como faixa colorida na lateral do card de
// alerta, pra bater o olho no tipo antes de ler qualquer texto.
const ALERT_ACCENT = {
  new_product: 'border-green-700',
  stock_change: 'border-red-500',
  variations_added: 'border-blue-500',
  new_ad: 'border-blue-500',
  price_change: 'border-emerald-500',
  urgency_detected: 'border-orange-500',
  vendor_changed: 'border-orange-500',
  supplier_id_changed: 'border-orange-500',
  duplicate_detected: 'border-orange-500',
  scaling_detected: 'border-violet-500',
  winning_ad: 'border-violet-500',
  product_removed: 'border-red-500',
  ad_killed: 'border-red-500',
  not_shopify: 'border-red-500',
}

export function alertAccentClass(type) {
  return ALERT_ACCENT[type] || 'border-[var(--border)]'
}
