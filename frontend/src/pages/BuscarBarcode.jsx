import { useState } from 'react'
import { rawApi } from '../api/rawClient.js'

const HISTORY_KEY = 'buscar-barcode-shopify:history'

function loadHistory() {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

function pushHistory(loja, result) {
  const next = [{ loja, codigo: result.value }, ...loadHistory()].slice(0, 5)
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    // sessionStorage indisponível — segue sem histórico
  }
  return next
}

export default function BuscarBarcode() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState(loadHistory)

  async function buscar() {
    const trimmed = url.trim()
    if (!trimmed) {
      setError('Cole a URL do produto antes de buscar')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    setCopied(false)
    try {
      const data = await rawApi.buscarBarcode(trimmed)
      const found = { value: data.value, source: data.source, productTitle: data.productTitle }
      setResult(found)
      setHistory(pushHistory(new URL(trimmed).hostname, found))
    } catch (err) {
      setError(err.message || 'Loja não suportada')
    } finally {
      setLoading(false)
    }
  }

  async function copiar() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(`Encontrado: ${result.value}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Não foi possível copiar automaticamente, selecione o texto manualmente')
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Buscar Fornecedor</h2>
        <p className="text-sm text-[var(--text-muted)]">Cole a URL de um produto concorrente pra achar o fornecedor dele.</p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
        <label className="mb-2 block text-sm text-[var(--text-secondary)]">Cole a URL do produto concorrente:</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && buscar()}
          placeholder="https://loja-concorrente.com/products/nome-do-produto"
          autoComplete="off"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
        />
        <button onClick={buscar} disabled={loading} className="btn-primary mt-4 w-full py-2.5">
          {loading ? 'Buscando…' : 'Buscar'}
        </button>

        {error && (
          <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">{error}</div>
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2.5">
            <p className="text-sm font-medium text-emerald-400">Encontrado: {result.value}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Código do fornecedor
              {result.productTitle ? ` · ${result.productTitle}` : ''}
            </p>
            <button
              onClick={copiar}
              className="mt-3 rounded-md bg-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--hover-secondary)]"
            >
              {copied ? 'Copiado!' : 'Copiar Resultado'}
            </button>
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Últimas buscas</h3>
          <ul className="flex flex-col gap-1.5">
            {history.map((item, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-xs"
              >
                <span className="truncate text-[var(--text-muted)]">{item.loja}</span>
                <span className="shrink-0 font-medium text-emerald-400">{item.codigo}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
