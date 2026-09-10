import { Medal, Award, Gem } from 'lucide-react'

// Emblema visual dos 3 níveis de embaixador (Gold/Platinum/Diamond, ver
// communityTiers.js no backend — os nomes aqui têm que bater com os `name`
// de lá). Ícone + gradiente por nível, sem depender de imagem nenhuma
// (SVG do lucide-react), pra não precisar subir/hospedar asset nenhum.
const TIER_STYLES = {
  gold: { Icon: Medal, gradient: 'from-amber-400 to-yellow-600', ring: 'ring-amber-400/40', label: 'Gold' },
  platinum: { Icon: Award, gradient: 'from-slate-300 to-slate-500', ring: 'ring-slate-300/40', label: 'Platinum' },
  diamond: { Icon: Gem, gradient: 'from-cyan-300 to-blue-500', ring: 'ring-cyan-300/40', label: 'Diamond' },
}

const SIZES = {
  sm: { box: 'h-7 w-7', icon: 13 },
  md: { box: 'h-10 w-10', icon: 18 },
  lg: { box: 'h-16 w-16', icon: 28 },
}

export default function TierBadge({ tier, size = 'md', showLabel = false }) {
  const style = TIER_STYLES[tier] || TIER_STYLES.gold
  const { box, icon } = SIZES[size] || SIZES.md
  const { Icon } = style
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex ${box} items-center justify-center rounded-full bg-gradient-to-br ${style.gradient} text-white shadow-lg ring-4 ${style.ring}`}
      >
        <Icon size={icon} strokeWidth={2.5} />
      </span>
      {showLabel && <span className="font-semibold text-[var(--text-primary)]">{style.label}</span>}
    </span>
  )
}
