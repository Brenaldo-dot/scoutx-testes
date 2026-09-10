import { createContext, useContext, useEffect, useState } from 'react'
import { rawApi } from '../api/rawClient.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)

  function refreshMe() {
    return rawApi.me().then(setMe)
  }

  useEffect(() => {
    refreshMe()
      .catch(() => {
        // Sessão expirada/ausente — as próprias rotas Express (/login) já
        // tratam o redirect server-side quando a pessoa navega ali; aqui só
        // evita travar o app numa tela em branco esperando /api/me.
        window.location.href = '/login'
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <AuthContext.Provider value={{ me, loading, refreshMe }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return ctx
}
