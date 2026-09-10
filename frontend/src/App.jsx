import { Navigate, Route, Routes } from 'react-router-dom'
import { OperationProvider } from './context/OperationContext.jsx'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { LanguageProvider } from './context/LanguageContext.jsx'
import Layout from './components/Layout.jsx'
import RouteGuard from './components/RouteGuard.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Competitors from './pages/Competitors.jsx'
import CompetitorDetail from './pages/CompetitorDetail.jsx'
import Products from './pages/Products.jsx'
import HotProducts from './pages/HotProducts.jsx'
import Ads from './pages/Ads.jsx'
import AdMiner from './pages/AdMiner.jsx'
import Alerts from './pages/Alerts.jsx'
import BuscarBarcode from './pages/BuscarBarcode.jsx'
import EspionarLoja from './pages/EspionarLoja.jsx'
import Historico from './pages/Historico.jsx'
import Usuarios from './pages/Usuarios.jsx'
import Organizacoes from './pages/Organizacoes.jsx'
import Afiliados from './pages/Afiliados.jsx'
import AdminIndicacoes from './pages/AdminIndicacoes.jsx'
import Conta from './pages/Conta.jsx'
import Suporte from './pages/Suporte.jsx'
import Indicacao from './pages/Indicacao.jsx'
import Comunidade from './pages/Comunidade.jsx'
import AdminComunidades from './pages/AdminComunidades.jsx'

// Quem não tem acesso ao núcleo do ScoutX não deve cair numa tela de "sem
// permissão" logo depois de logar — manda direto pra ferramenta que ela
// sempre pôde usar (Buscar Barcode), em vez do Dashboard.
function Home() {
  const { me, loading } = useAuth()
  if (loading || !me) return null
  if (me.isAdmin || me.canAccessMinerador) return <Dashboard />
  return <Navigate to="/ferramentas/buscar-barcode" replace />
}

export default function App() {
  return (
    <ThemeProvider>
    <LanguageProvider>
    <AuthProvider>
      <OperationProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />

            {/* Núcleo do ScoutX — mesma permissão (isAdmin || canAccessMinerador) que
                já protegia essas telas em /minerador antes da fusão dos apps. */}
            <Route element={<RouteGuard allow={(me) => me.isAdmin || me.canAccessMinerador} />}>
              <Route path="/concorrentes" element={<Competitors />} />
              <Route path="/concorrentes/:id" element={<CompetitorDetail />} />
              <Route path="/produtos" element={<Products />} />
              <Route path="/produtos-quentes" element={<HotProducts />} />
              <Route path="/anuncios" element={<Ads />} />
              <Route path="/minerador-de-anuncios" element={<AdMiner />} />
              <Route path="/alertas" element={<Alerts />} />
            </Route>

            {/* Buscar Barcode / Espionar Loja: qualquer usuário logado sempre pôde
                usar (nunca tiveram permissão extra) — sem guard aqui de propósito. */}
            <Route path="/ferramentas/buscar-barcode" element={<BuscarBarcode />} />
            <Route path="/ferramentas/espionar-loja" element={<EspionarLoja />} />

            {/* Minha Conta: idioma, senha, notificação Discord — configuração
                da PESSOA, não da ferramenta, então qualquer usuário logado
                acessa, sem RouteGuard de permissão. */}
            <Route path="/conta" element={<Conta />} />

            {/* Suporte (WhatsApp): mesma lógica de Minha Conta — não é
                permissão de ferramenta, qualquer pessoa logada precisa
                conseguir pedir ajuda. */}
            <Route path="/suporte" element={<Suporte />} />

            {/* Indicação: mesma lógica de Minha Conta/Suporte — qualquer
                cliente logado pode pedir seu cupom, não é feature de plano. */}
            <Route path="/indicacao" element={<Indicacao />} />

            {/* Comunidade: mesma lógica — qualquer cliente logado pode
                participar ou (se for afiliado) virar embaixador dono de uma. */}
            <Route path="/comunidade" element={<Comunidade />} />

            <Route element={<RouteGuard allow={(me) => me.isAdmin} />}>
              <Route path="/ferramentas/historico" element={<Historico />} />
              <Route path="/usuarios" element={<Usuarios />} />
              <Route path="/organizacoes" element={<Organizacoes />} />
              <Route path="/afiliados" element={<Afiliados />} />
              <Route path="/admin/indicacoes" element={<AdminIndicacoes />} />
              <Route path="/admin/comunidades" element={<AdminComunidades />} />
            </Route>
          </Route>
        </Routes>
      </OperationProvider>
    </AuthProvider>
    </LanguageProvider>
    </ThemeProvider>
  )
}
