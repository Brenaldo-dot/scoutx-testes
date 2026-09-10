import { Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

// Guarda de rota client-side. A proteção de DADO de verdade já existe no
// backend (requireMineradorAccess/requireAdmin em server.js — o proxy
// /api/minerador/* e as rotas /api/admin/* continuam recusando quem não
// tem permissão, isso aqui não muda). Esse guard é só pra não mostrar uma
// tela quebrada (cheia de 403 silencioso) pra quem clicar/entrar direto
// numa URL que não devia — mostra um aviso claro em vez disso.
export default function RouteGuard({ allow }) {
  const { me, loading } = useAuth()

  if (loading || !me) return null
  if (!allow(me)) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-8 text-center">
        <p className="text-sm text-[var(--text-tertiary)]">Você não tem permissão para acessar essa área.</p>
      </div>
    )
  }
  return <Outlet />
}
