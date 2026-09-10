import { createContext, useContext, useState } from 'react'
import { translate } from '../i18n/translations.js'

const STORAGE_KEY = 'scoutx-language'
const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => localStorage.getItem(STORAGE_KEY) || 'pt')

  function changeLanguage(lang) {
    setLanguage(lang)
    localStorage.setItem(STORAGE_KEY, lang)
  }

  function t(key) {
    return translate(language, key)
  }

  return <LanguageContext.Provider value={{ language, changeLanguage, t }}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage precisa estar dentro de <LanguageProvider>')
  return ctx
}
