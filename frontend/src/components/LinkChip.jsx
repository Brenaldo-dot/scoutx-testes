import { Link } from 'react-router-dom'

// Pill de link — substitui os antigos links de texto sublinhado ("Ver
// produto ↗") por um botão chamativo, com cor por domínio (produto = marca,
// anúncio/biblioteca = violeta, igual ao resto do app) em vez de um azul
// genérico de link de navegador. `href` = link externo (nova aba); `to` =
// navegação interna do próprio app (ex: mandar pra aba Produtos já com
// busca preenchida).
const VARIANTS = {
  brand:
    'border-brand-500/30 bg-brand-500/10 text-brand-500 hover:border-brand-500/60 hover:bg-brand-500/20 hover:text-brand-400',
  violet:
    'border-violet-500/30 bg-violet-500/10 text-violet-400 hover:border-violet-500/60 hover:bg-violet-500/20',
  neutral:
    'border-[var(--border)] bg-[var(--hover-surface)] text-[var(--text-secondary)] hover:border-brand-500/50 hover:text-brand-500',
}

export default function LinkChip({ href, to, children, variant = 'brand', className = '' }) {
  if (!href && !to) return null
  const classes = `inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${VARIANTS[variant] || VARIANTS.brand} ${className}`

  if (to) {
    return (
      <Link to={to} className={classes}>
        {children}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
      {children}
    </a>
  )
}
