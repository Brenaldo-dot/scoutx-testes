// Mesma "pastilha LED" do menu lateral (components/Layout.jsx) — ícone azul
// monocromático numa pastilha com brilho, acesa quando `active`. Extraído
// pra componente à parte pra reusar fora do menu (ex: filtros da aba
// Alertas, que ainda usavam emoji cru — pedido do usuário pra unificar).
export default function LedIcon({ Icon, active, size = 14 }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-all ${
        active ? 'nav-icon-active' : 'bg-brand-500/10 text-brand-500'
      }`}
    >
      <Icon size={size} strokeWidth={2.25} className={active ? '' : 'text-brand-500'} />
    </span>
  )
}
