import { Link } from 'react-router-dom'

// `to` é opcional — sem ele o card fica igual sempre foi (ex: "Usuários" em
// Usuarios.jsx/Organizacoes.jsx, que não tem uma tela própria pra apontar).
// Com `to`, o card inteiro vira link (pedido do usuário: clicar em
// "Concorrentes ativos" no Dashboard já abrir a aba Concorrentes, em vez de
// só mostrar o número parado).
export default function StatCard({ label, value, hint, icon, to }) {
  const Wrapper = to ? Link : 'div'
  return (
    <Wrapper
      {...(to ? { to } : {})}
      className="group relative block overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 shadow-sm transition-colors hover:border-brand-500/50"
    >
      {/* Glow no canto — mesmo tratamento visual dos cards de destaque da
          referência (cards "hub"), na cor da marca em vez de roxo. */}
      <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br from-brand-500/25 to-transparent blur-2xl transition-opacity group-hover:opacity-90" />
      <div className="relative flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--text-muted)]">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{value ?? '—'}</p>
          {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
        </div>
        {icon && (
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-lg shadow-lg"
            style={{
              background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), 0 4px 14px rgba(59,130,246,0.45)',
            }}
          >
            {icon}
          </span>
        )}
      </div>
    </Wrapper>
  )
}
