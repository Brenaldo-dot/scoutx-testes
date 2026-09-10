import { Loader2 } from 'lucide-react'

// Selo pequeno "Buscando…" pra quando um filtro/ordenação troca e a
// lista antiga fica na tela enquanto a nova carrega — pedido do usuário
// (2026-08-27): a demora sem aviso nenhum parecia travado. Não troca o
// conteúdo (o chamador decide isso), só avisa que tem algo rodando.
export default function FilteringIndicator({ show, label = 'Buscando…' }) {
  if (!show) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-2.5 py-1 text-xs font-medium text-brand-500">
      <Loader2 size={12} className="animate-spin" />
      {label}
    </span>
  )
}
