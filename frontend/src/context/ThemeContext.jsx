import { createContext, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'scoutx-theme'
const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) || 'dark')

  useEffect(() => {
    // Fica no <html>, não num wrapper interno — assim TODO componente sob
    // ele enxerga a variável CSS certa (index.css:root vs [data-theme=light]),
    // sem precisar prop-drilling ou re-render em cascata.
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  function toggleTheme() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme precisa estar dentro de <ThemeProvider>')
  return ctx
}
