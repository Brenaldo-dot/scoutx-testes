import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Bell,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Flame,
  Gift,
  GripVertical,
  Handshake,
  History,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  Moon,
  Package,
  Radar,
  ScanBarcode,
  ShieldCheck,
  Store,
  Sun,
  UserCog,
  Users,
} from 'lucide-react'
import { OPERATIONS, requiredPlanForSlot, useOperation } from '../context/OperationContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { useLanguage } from '../context/LanguageContext.jsx'
import { initials } from '../utils/avatar.js'
import { readCategoryVisits } from '../utils/alertsVisit.js'
import { api } from '../api/client.js'
import Select from './Select.jsx'
import ReorderOperationsModal from './ReorderOperationsModal.jsx'
import scoutxLogo from '../assets/scoutx-logo.png'

const ADD_CUSTOM_VALUE = '__add_custom__'
const COLLAPSE_KEY = 'scoutx-sidebar-collapsed'
const DESKTOP_QUERY = '(min-width: 1024px)' // mesmo ponto de corte do breakpoint `lg` do Tailwind

// Grupos com cabeçalho + ícone de linha (não emoji) — cada item vira um LED
// azul: ícone monocromático dentro de uma pastilha com brilho, igual em
// todo item (ativo ou não), pra bater o olho sem parecer sticker de emoji.
// labelKey aponta pro dicionário de i18n/translations.js (Layout é uma das
// poucas telas totalmente traduzidas — ver comentário no topo do dicionário).
const NAV_GROUPS = [
  {
    labelKey: 'nav.principal',
    items: [
      { to: '/', labelKey: 'nav.dashboard', Icon: LayoutDashboard, end: true },
      { to: '/concorrentes', labelKey: 'nav.concorrentes', Icon: Store },
      { to: '/produtos', labelKey: 'nav.produtos', Icon: Package },
    ],
  },
  {
    labelKey: 'nav.inteligencia',
    items: [
      { to: '/produtos-quentes', labelKey: 'nav.produtosQuentes', Icon: Flame },
      { to: '/anuncios', labelKey: 'nav.anuncios', Icon: Megaphone },
      { to: '/alertas', labelKey: 'nav.alertas', Icon: Bell },
    ],
  },
]

// "Ferramentas": Buscar Barcode e Espionar Loja sempre visíveis (nunca
// tiveram permissão própria, herdado do antigo "Buscar Barcode Shopify").
// Minerador de Anúncios entra condicionalmente logo abaixo — ele bate no
// mesmo /api/minerador/* protegido por canAccessMinerador no backend.
const TOOL_ITEMS = [
  { to: '/ferramentas/buscar-barcode', labelKey: 'nav.buscarFornecedor', Icon: ScanBarcode },
  { to: '/ferramentas/espionar-loja', labelKey: 'nav.espionarLoja', Icon: Eye },
]

function navLinkClass({ isActive }, collapsed) {
  return `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
    collapsed ? 'justify-center px-0' : ''
  } ${
    isActive
      ? 'nav-active'
      : 'text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)] hover:text-[var(--text-primary)]'
  }`
}

// A "pastilha LED" — ícone azul dentro de um quadrado com brilho suave;
// no item ativo o brilho fica mais forte, como uma luz acesa.
function NavIcon({ Icon, active }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all ${
        active ? 'nav-icon-active' : 'bg-brand-500/10 text-brand-500'
      }`}
    >
      <Icon size={15} strokeWidth={2.25} className={active ? '' : 'text-brand-500'} />
    </span>
  )
}

// Quando a sidebar tá recolhida (só ícone), o cabeçalho do grupo some e os
// itens ficam sempre visíveis — não faz sentido "recolher" uma seção que já
// não tem rótulo pra clicar.
function NavGroup({ label, collapsed, children }) {
  const [open, setOpen] = useState(true)
  if (collapsed) return <div className="space-y-1">{children}</div>
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]"
      >
        {label}
        <ChevronDown size={13} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="space-y-1">{children}</div>}
    </div>
  )
}

export default function Layout() {
  const {
    operation,
    setOperation,
    addCustomOperation,
    labelOverrides,
    renameOperation,
    removeOperation,
    planLimit,
    needsCountryPick,
    touchedOperations,
    orderedOperations: ctxOrderedOperations,
    reorderOperations,
  } = useOperation()
  const { me } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { t } = useLanguage()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === 'true')
  const [operationModal, setOperationModal] = useState(null)
  const [deleteOperationModal, setDeleteOperationModal] = useState(null)
  const [reorderModalOpen, setReorderModalOpen] = useState(false)
  const [alertsUnreadCount, setAlertsUnreadCount] = useState(0)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // `collapsed` é preferência de DESKTOP (ícone-só) — abaixo de `lg` o menu
  // vira um drawer que, quando aberto, precisa mostrar tudo por extenso
  // (não faz sentido um overlay em tela cheia ficando em modo ícone-só só
  // porque a pessoa tinha recolhido o menu antes, num notebook, semanas
  // atrás). isDesktop decide qual das duas leituras vale a cada momento.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(DESKTOP_QUERY).matches : true
  )
  const effectiveCollapsed = collapsed && isDesktop

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed))
  }, [collapsed])

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY)
    const handler = (e) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Fecha o drawer sozinho ao navegar — sem isso a próxima tela abriria com
  // o menu ainda em cima dela.
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  // Trava o scroll de fundo enquanto o drawer tá aberto por cima do conteúdo.
  useEffect(() => {
    document.body.style.overflow = mobileNavOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileNavOpen])

  // Bolinha de não lido no menu — soma o não lido de cada categoria (mesmo
  // corte por categoria usado em Alerts.jsx), filtrado pela MESMA operação
  // selecionada — sem isso a bolinha soma alerta de todo país junto enquanto
  // a aba Alertas só mostra o país atual, e os números nunca batem (bug
  // relatado: sobrava muito mais no menu do que o total visível na aba).
  // Refaz ao trocar de rota ou de operação, e também na hora via evento
  // customizado — clicar numa categoria dentro de /alertas só muda o
  // ?categoria= da URL, sem trocar de rota, então só o pathname não seria
  // suficiente pra pegar a atualização.
  useEffect(() => {
    function refresh() {
      const visits = readCategoryVisits(operation)
      api.getAlertCounts({ operation, since_map: JSON.stringify(visits) }).then((r) => setAlertsUnreadCount(r.total)).catch(() => {})
    }
    refresh()
    window.addEventListener('scoutx:alerts-visited', refresh)
    return () => window.removeEventListener('scoutx:alerts-visited', refresh)
  }, [location.pathname, operation])

  function handleOperationChange(value) {
    if (value !== ADD_CUSTOM_VALUE) {
      setOperation(value)
      return
    }
    setOperationModal({ mode: 'add', value: null, label: '' })
  }

  function handleEditOperation(option) {
    setOperationModal({ mode: 'rename', value: option.value, label: option.label, originalLabel: option.label })
  }

  function handleDeleteOperation(option) {
    setDeleteOperationModal({ option, error: null })
  }

  function submitDeleteOperation() {
    if (!deleteOperationModal) return
    const error = removeOperation(deleteOperationModal.option.value)
    if (error) setDeleteOperationModal({ ...deleteOperationModal, error })
    else setDeleteOperationModal(null)
  }

  function submitOperationModal() {
    const name = operationModal.label.trim()
    if (!name) return
    if (operationModal.mode === 'add') addCustomOperation(name)
    else renameOperation(operationModal.value, name)
    setOperationModal(null)
  }

  // Revisão (achado ao vivo, 2026-08-25 — várias voltas):
  // 1ª: a trava era "por toque" — só fechava a Nª opção depois que a conta
  // já tinha CLICADO em N países diferentes, então logo depois de um
  // upgrade (antes de escolher qualquer país extra) tudo aparecia liberado.
  // Corrigido travando por POSIÇÃO: as N primeiras posições (N =
  // maxOperations do plano) ficam liberadas na hora.
  // 2ª: só o país ATUAL (o que está na tela agora) ia pra 1ª posição —
  // trocar de país "esquecia" o anterior, que caía pro fim da lista e podia
  // aparecer travado à toa, mesmo já tendo sido escolhido antes.
  // 3ª: a lista ficava "sambando" — toda vez que clicava num país já
  // tocado diferente, ele pulava pra 1ª posição e reordenava tudo de novo.
  // Corrigido usando `touchedHistory` (ordem de primeiro toque) como ordem
  // AUTOMÁTICA padrão: cada país ganha posição fixa assim que é tocado pela
  // primeira vez e nunca mais se move sozinho.
  // 4ª (pedido explícito do usuário): além da ordem automática, deixar a
  // pessoa arrastar pra organizar do jeito que ela quiser — isso agora vive
  // em `orderedOperations`/`reorderOperations`, dentro do OperationContext
  // (é só exibição, não mexe em quem está travado — isso continua vindo de
  // touchedOperations, não da posição na lista).
  const maxOps = planLimit?.maxOperations
  const operationOptions = ctxOrderedOperations.map((op, index) => {
    const locked = Number.isFinite(maxOps) && index >= maxOps && !touchedOperations.has(op.value)
    return {
      value: op.value,
      label: labelOverrides[op.value] || op.label,
      icon: op.flag,
      locked,
      lockedReason: locked ? `Requer plano ${requiredPlanForSlot(index + 1)}` : undefined,
    }
  })
  // Um país novo (customizado) sempre vira "tocado" na hora de criar (ver
  // addCustomOperation/setOperation) — só cabe se a conta ainda não tiver
  // esgotado as vagas de verdade (tocadas), não a lista toda.
  const atOperationCap = Number.isFinite(maxOps) && touchedOperations.size >= maxOps
  const nextFreeSlot = touchedOperations.size + 1

  const hasAccess = me?.isAdmin || me?.canAccessMinerador

  return (
    <div className="flex min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
      {/* Fundo escurecido atrás do drawer — some junto com ele acima de `lg`,
          onde o menu volta a ser fixo na tela em vez de sobrepor conteúdo. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileNavOpen(false)} />
      )}

      <aside
        // Revisão: achado ao vivo — "overflow-y-auto" aqui (mesmo sem
        // "overflow-x" nenhum) faz o navegador tratar o eixo X TAMBÉM como
        // não-visível (regra do CSS: overflow-x/-y não podem ficar um
        // "visible" e outro não ao mesmo tempo) — cortava pela metade a
        // "bolinha" de recolher, que fica de propósito -right-3 (parte pra
        // fora da borda direita). O <nav> logo abaixo já tem seu PRÓPRIO
        // overflow-y-auto pra rolar a lista de itens — o <aside> não
        // precisa rolar nada sozinho, só empurrava esse corte sem motivo.
        className={`sidebar-edge fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-[var(--bg-surface)] p-4 transition-all duration-200 lg:relative ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${collapsed ? 'lg:w-[68px] lg:px-2' : ''}`}
      >
        {/* "Bolinha" de recolher — só faz sentido em tela larga, com o menu
            fixo; no drawer mobile é tudo-ou-nada (aberto/fechado). */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t('nav.expandirMenu') : t('nav.recolherMenu')}
          className="absolute -right-3 top-16 z-10 hidden h-6 w-6 items-center justify-center rounded-full border border-brand-500/40 bg-[var(--bg-surface-2)] text-brand-500 shadow-md transition-colors hover:bg-brand-500/15 lg:flex"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>

        <div className="relative mb-4 flex items-center justify-center px-2 pt-1">
          <Link to="/" title="Ir pro Dashboard">
            <img
              src={scoutxLogo}
              alt="ScoutX"
              className={`rounded-2xl object-cover shadow-lg transition-all ${effectiveCollapsed ? 'h-9 w-9' : 'h-20 w-20'}`}
            />
          </Link>
          {!effectiveCollapsed && (
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Mudar pro tema claro' : 'Mudar pro tema escuro'}
              className="absolute right-1 top-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          )}
        </div>

        <div className={`mb-2 px-2 ${hasAccess && !effectiveCollapsed ? '' : 'hidden'}`}>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-xs font-medium text-[var(--text-muted)]">{t('nav.operacao')}</label>
            {/* Só vale a pena organizar quando tem mais de 1 país pra
                arrastar entre si — com 0 ou 1 não tem o que reordenar. */}
            {operationOptions.length > 1 && (
              <button
                type="button"
                onClick={() => setReorderModalOpen(true)}
                title="Organizar ordem dos países"
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-[var(--text-faint)] transition-colors hover:text-brand-500"
              >
                <GripVertical size={11} /> Organizar
              </button>
            )}
          </div>
          <Select
            value={operation}
            onChange={handleOperationChange}
            onEditOption={handleEditOperation}
            onDeleteOption={handleDeleteOperation}
            options={operationOptions}
            extraOption={{
              value: ADD_CUSTOM_VALUE,
              label: t('nav.adicionarPais'),
              locked: atOperationCap,
              // Uma organização nova (customOperations vazio) teria essa
              // adição como a 1ª vaga além das já usadas — mesma conta de
              // "próxima vaga livre" usada nas opções acima.
              lockedReason: atOperationCap ? `Requer plano ${requiredPlanForSlot(nextFreeSlot)}` : undefined,
            }}
          />
        </div>

        <nav className="flex-1 overflow-y-auto">
          {hasAccess &&
            NAV_GROUPS.map((group) => (
              <NavGroup key={group.labelKey} label={t(group.labelKey)} collapsed={effectiveCollapsed}>
                {group.items.map(({ to, labelKey, Icon, end }) => {
                  const unread = to === '/alertas' ? alertsUnreadCount : 0
                  return (
                    <NavLink key={to} to={to} end={end} title={effectiveCollapsed ? t(labelKey) : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                      {({ isActive }) => (
                        <>
                          <span className="relative shrink-0">
                            <NavIcon Icon={Icon} active={isActive} />
                            {/* Recolhido: só a bolinha, sem número — não tem
                                espaço pro número do lado do ícone sozinho. */}
                            {unread > 0 && effectiveCollapsed && (
                              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-[var(--bg-surface)]" />
                            )}
                          </span>
                          {!effectiveCollapsed && (
                            <span className="flex flex-1 items-center justify-between gap-2">
                              {t(labelKey)}
                              {unread > 0 && (
                                <span className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                                  {unread > 99 ? '99+' : unread}
                                </span>
                              )}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  )
                })}
              </NavGroup>
            ))}

          {!effectiveCollapsed && (
            <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{t('nav.ferramentas')}</p>
          )}
          <div className={`space-y-1 ${effectiveCollapsed ? 'mt-2' : ''}`}>
            {hasAccess && (
              <NavLink to="/minerador-de-anuncios" title={effectiveCollapsed ? t('nav.mineradorAnuncios') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Radar} active={isActive} />
                    {!effectiveCollapsed && t('nav.mineradorAnuncios')}
                  </>
                )}
              </NavLink>
            )}
            {TOOL_ITEMS.map(({ to, labelKey, Icon }) => (
              <NavLink key={to} to={to} title={effectiveCollapsed ? t(labelKey) : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Icon} active={isActive} />
                    {!effectiveCollapsed && t(labelKey)}
                  </>
                )}
              </NavLink>
            ))}

            {me?.isAdmin && (
              <NavLink to="/ferramentas/historico" title={effectiveCollapsed ? t('nav.historico') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={History} active={isActive} />
                    {!effectiveCollapsed && t('nav.historico')}
                  </>
                )}
              </NavLink>
            )}

            {me?.isAdmin && (
              <NavLink to="/usuarios" title={effectiveCollapsed ? t('nav.usuarios') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Users} active={isActive} />
                    {!effectiveCollapsed && t('nav.usuarios')}
                  </>
                )}
              </NavLink>
            )}

            {me?.isAdmin && (
              <NavLink to="/organizacoes" title={effectiveCollapsed ? t('nav.organizacoes') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Building2} active={isActive} />
                    {!effectiveCollapsed && t('nav.organizacoes')}
                  </>
                )}
              </NavLink>
            )}

            {me?.isAdmin && (
              <NavLink to="/afiliados" title={effectiveCollapsed ? t('nav.afiliados') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Handshake} active={isActive} />
                    {!effectiveCollapsed && t('nav.afiliados')}
                  </>
                )}
              </NavLink>
            )}

            {me?.isAdmin && (
              <NavLink to="/admin/indicacoes" title={effectiveCollapsed ? t('nav.adminIndicacoes') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Gift} active={isActive} />
                    {!effectiveCollapsed && t('nav.adminIndicacoes')}
                  </>
                )}
              </NavLink>
            )}

            {me && (
              <NavLink to="/indicacao" title={effectiveCollapsed ? t('nav.indicacao') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Gift} active={isActive} />
                    {!effectiveCollapsed && t('nav.indicacao')}
                  </>
                )}
              </NavLink>
            )}

            {me?.isAdmin && (
              <NavLink to="/admin/comunidades" title={effectiveCollapsed ? t('nav.adminComunidades') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Users} active={isActive} />
                    {!effectiveCollapsed && t('nav.adminComunidades')}
                  </>
                )}
              </NavLink>
            )}

            {me && (
              <NavLink to="/comunidade" title={effectiveCollapsed ? t('nav.comunidade') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={Users} active={isActive} />
                    {!effectiveCollapsed && t('nav.comunidade')}
                  </>
                )}
              </NavLink>
            )}

            {me && (
              <NavLink to="/suporte" title={effectiveCollapsed ? t('nav.suporte') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={MessageCircle} active={isActive} />
                    {!effectiveCollapsed && t('nav.suporte')}
                  </>
                )}
              </NavLink>
            )}

            {me && (
              <NavLink to="/conta" title={effectiveCollapsed ? t('nav.minhaConta') : undefined} className={(state) => navLinkClass(state, effectiveCollapsed)}>
                {({ isActive }) => (
                  <>
                    <NavIcon Icon={UserCog} active={isActive} />
                    {!effectiveCollapsed && t('nav.minhaConta')}
                  </>
                )}
              </NavLink>
            )}
          </div>
        </nav>

        {me && (
          <div className={`mt-4 border-t border-[var(--border)] pt-3 ${effectiveCollapsed ? 'flex flex-col items-center gap-2' : 'px-2'}`}>
            <Link
              to="/conta"
              className={`flex items-center gap-2.5 rounded-xl transition-colors hover:bg-[var(--hover-surface)] ${effectiveCollapsed ? '' : 'p-1.5'}`}
              title={effectiveCollapsed ? me.name : 'Trocar foto em Minha Conta'}
            >
              {me.avatarUrl ? (
                <img src={me.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              ) : (
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{
                    background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), 0 2px 8px rgba(59,130,246,0.4)',
                  }}
                >
                  {initials(me.name)}
                </span>
              )}
              {!effectiveCollapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{me.name}</p>
                  {me.isAdmin ? (
                    <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-500">
                      <ShieldCheck size={9} /> Admin
                    </span>
                  ) : me.planLabel ? (
                    <span className="mt-0.5 inline-block rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-500">
                      Plano {me.planLabel}
                    </span>
                  ) : null}
                </div>
              )}
            </Link>
            <a
              href="/logout"
              title={t('nav.sair')}
              className={
                effectiveCollapsed
                  ? 'flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover-surface)] hover:text-red-400'
                  : 'mt-1.5 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover-surface)] hover:text-red-400'
              }
            >
              <LogOut size={effectiveCollapsed ? 14 : 12} />
              {!effectiveCollapsed && t('nav.sair')}
            </a>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra só-mobile: sem ela não teria como abrir o drawer abaixo de
            `lg`, já que a sidebar fica fora da tela até alguém tocar aqui. */}
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 lg:hidden">
          <button
            onClick={() => setMobileNavOpen(true)}
            title={t('nav.expandirMenu')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
          >
            <Menu size={20} />
          </button>
          <Link to="/" title="Ir pro Dashboard">
            <img src={scoutxLogo} alt="ScoutX" className="h-8 w-8 rounded-xl object-cover shadow" />
          </Link>
          <span className="w-9" />
        </div>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>

      {operationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOperationModal(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {operationModal.mode === 'add' ? 'Adicionar país' : 'Renomear país'}
            </h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {operationModal.mode === 'add'
                ? 'Só muda como aparece no menu, não afeta nada já cadastrado.'
                : `Isso só muda como "${operationModal.originalLabel}" aparece pra você, os concorrentes já cadastrados continuam no mesmo lugar.`}
            </p>
            <input
              type="text"
              autoFocus
              placeholder="Nome do país/operação (ex: Chile, Peru…)"
              value={operationModal.label}
              onChange={(e) => setOperationModal({ ...operationModal, label: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submitOperationModal()}
              className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOperationModal(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button onClick={submitOperationModal} className="btn-primary px-4 py-2 text-xs">
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {reorderModalOpen && (
        <ReorderOperationsModal
          items={operationOptions.map((op) => ({ value: op.value, label: op.label, icon: op.icon }))}
          onClose={() => setReorderModalOpen(false)}
          onSave={(newOrderValues) => {
            reorderOperations(newOrderValues)
            setReorderModalOpen(false)
          }}
        />
      )}

      {deleteOperationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteOperationModal(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Excluir "{deleteOperationModal.option.label}"?
            </h3>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              Sai da sua lista de países e libera a vaga do plano — dá pra adicionar outro país depois, a qualquer
              momento. Não apaga nenhum concorrente já cadastrado.
            </p>
            {deleteOperationModal.error && (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {deleteOperationModal.error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteOperationModal(null)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--hover-surface)]"
              >
                Cancelar
              </button>
              <button
                onClick={submitDeleteOperation}
                className="rounded-full bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700"
              >
                Excluir país
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Escolha inicial de país — só pra colaborador (cliente pagante) que
          ainda nunca escolheu nada nesse navegador (needsCountryPick, ver
          OperationContext.jsx). Admin não tem organização/plano, não faz
          sentido pra ele. Não bloqueia o app: dá pra clicar fora e continuar
          usando com o padrão de sempre, só que agora avisado, e o aviso
          volta a aparecer enquanto a pessoa não escolher de fato. */}
      {needsCountryPick && !operationModal && !deleteOperationModal && hasAccess && !me?.isAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => {}}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--bg-surface)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-[var(--text-primary)]">Qual país você vai monitorar?</h3>
            <p className="mt-1.5 text-sm text-[var(--text-muted)]">
              Escolha o país onde ficam os concorrentes que você quer acompanhar. Dá pra adicionar outros países depois,
              a qualquer momento, pelo menu lateral.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {OPERATIONS.map((op) => (
                <button
                  key={op.value}
                  onClick={() => setOperation(op.value)}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-4 text-center transition-colors hover:border-brand-500 hover:bg-brand-500/10"
                >
                  <span className="text-2xl">{op.flag}</span>
                  <span className="text-xs font-medium text-[var(--text-secondary)]">{op.label}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setOperationModal({ mode: 'add', value: null, label: '' })}
              className="mt-3 w-full rounded-xl border border-dashed border-[var(--border)] px-3 py-3 text-center text-xs font-medium text-[var(--text-faint)] transition-colors hover:border-brand-500/60 hover:text-brand-500"
            >
              🌎 Meu país não está na lista
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
