import { useEffect, useRef, useState } from 'react'

const PRESETS = [
  { days: 30, label: 'Últimos 30 dias' },
  { days: 60, label: 'Últimos 60 dias' },
  { days: 90, label: 'Últimos 90 dias' },
  { days: 180, label: 'Últimos 180 dias' },
  { days: 360, label: 'Últimos 360 dias' },
]

function currentLabel(range) {
  if (range.mode === 'custom') return `${range.startDate} – ${range.endDate}`
  return PRESETS.find((p) => p.days === range.days)?.label || `Últimos ${range.days} dias`
}

// Range = { mode: 'preset', days } | { mode: 'custom', startDate, endDate } — o
// pai (Dashboard.jsx) guarda esse estado e passa pra cada gráfico, todos
// respondendo ao mesmo filtro (guia de dataviz: "filtro escopa tudo abaixo
// dele, nunca dentro de um card de gráfico").
export default function DateRangeFilter({ range, onChange }) {
  const [open, setOpen] = useState(false)
  const [customStart, setCustomStart] = useState(range.startDate || '')
  const [customEnd, setCustomEnd] = useState(range.endDate || '')
  const ref = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function applyCustom() {
    if (customStart && customEnd) {
      onChange({ mode: 'custom', startDate: customStart, endDate: customEnd })
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-2)]"
      >
        📅 {currentLabel(range)}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] py-1.5 shadow-lg">
          {PRESETS.map((preset) => {
            const selected = range.mode === 'preset' && range.days === preset.days
            return (
              <button
                key={preset.days}
                onClick={() => {
                  onChange({ mode: 'preset', days: preset.days })
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-surface-2)]"
              >
                {preset.label}
                {selected && <span className="text-brand-600">✓</span>}
              </button>
            )
          })}

          <div className="mt-1 border-t border-[var(--border)] px-3 pt-2">
            <p className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">Período customizado</p>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-full rounded border border-[var(--border)] bg-[var(--bg-surface-2)] px-1.5 py-1 text-xs text-[var(--text-primary)]"
              />
              <span className="text-xs text-[var(--text-muted)]">–</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="w-full rounded border border-[var(--border)] bg-[var(--bg-surface-2)] px-1.5 py-1 text-xs text-[var(--text-primary)]"
              />
            </div>
            <button
              onClick={applyCustom}
              disabled={!customStart || !customEnd}
              className="mt-1.5 mb-1 w-full rounded-md bg-brand-600 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
