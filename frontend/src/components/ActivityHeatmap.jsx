import { useMemo } from 'react'

const DAY_MS = 24 * 60 * 60 * 1000

const LEVEL_BG = [
  'bg-[var(--hover-surface)]',
  'bg-brand-900',
  'bg-brand-700',
  'bg-brand-600',
  'bg-brand-500',
]

function levelFor(count, maxCount) {
  if (!count || !maxCount) return 0
  const ratio = count / maxCount
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

// Heatmap tipo GitHub — recebe [{date:'YYYY-MM-DD', count}] já contínuo dia a
// dia (ver /api/dashboard/activity-heatmap) e alinha em colunas de
// segunda-a-domingo pra bater o olho e ver semana parada sem entrar em Alertas.
export default function ActivityHeatmap({ data }) {
  const { weeks, maxCount } = useMemo(() => {
    if (!data || data.length === 0) return { weeks: [], maxCount: 0 }
    const byDate = new Map(data.map((d) => [d.date, d.count]))
    const first = new Date(`${data[0].date}T00:00:00`)
    const last = new Date(`${data[data.length - 1].date}T00:00:00`)
    const firstMonday = new Date(first)
    firstMonday.setDate(first.getDate() - ((first.getDay() + 6) % 7))

    const cols = []
    let cursor = firstMonday
    let peak = 0
    while (cursor <= last) {
      const col = []
      for (let i = 0; i < 7; i++) {
        const iso = cursor.toISOString().slice(0, 10)
        const inRange = cursor >= first && cursor <= last
        const count = inRange ? byDate.get(iso) || 0 : null
        if (count) peak = Math.max(peak, count)
        col.push({ date: iso, count })
        cursor = new Date(cursor.getTime() + DAY_MS)
      }
      cols.push(col)
    }
    return { weeks: cols, maxCount: peak }
  }, [data])

  if (weeks.length === 0) return null

  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {weeks.map((col, i) => (
        <div key={i} className="flex flex-col gap-1">
          {col.map((cell) =>
            cell.count === null ? (
              <div key={cell.date} className="h-3 w-3 rounded-sm" />
            ) : (
              <div
                key={cell.date}
                title={`${cell.date} · ${cell.count} alerta${cell.count === 1 ? '' : 's'}`}
                className={`h-3 w-3 rounded-sm ${LEVEL_BG[levelFor(cell.count, maxCount)]}`}
              />
            ),
          )}
        </div>
      ))}
    </div>
  )
}
