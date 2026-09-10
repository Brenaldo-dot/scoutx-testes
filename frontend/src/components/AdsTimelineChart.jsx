import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client.js'
import { PLATFORM_HEX } from './Badges.jsx'
import { rangeToParams } from '../utils/dateRange.js'

const SERIES = [
  { key: 'meta', label: 'Meta' },
  { key: 'google', label: 'Google' },
  { key: 'tiktok', label: 'TikTok' },
]

function formatDay(iso) {
  const [, month, day] = iso.split('-')
  return `${day}/${month}`
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((p) => p.value > 0)
  if (rows.length === 0) return null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-[var(--text-muted)]">{formatDay(label)}</p>
      {rows.map((row) => (
        <p key={row.dataKey} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3" style={{ backgroundColor: row.fill }} />
          <span className="font-semibold text-[var(--text-primary)]">{row.value}</span>
          <span className="text-[var(--text-muted)]">{SERIES.find((s) => s.key === row.dataKey)?.label}</span>
        </p>
      ))}
    </div>
  )
}

export default function AdsTimelineChart({ competitorId, operation, range }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api
      .getAdsTimeline({ competitor_id: competitorId || undefined, operation, ...rangeToParams(range) })
      .then(setData)
      .catch((e) => setError(e.message))
  }, [competitorId, operation, range])

  if (error) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">Não deu pra carregar o gráfico.</p>
  if (!data) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">Carregando…</p>

  const total = data.reduce((sum, d) => sum + d.meta + d.google + d.tiktok, 0)

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDay}
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis allowDecimals={false} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={28} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--hover-surface)' }} />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }}
            formatter={(value) => SERIES.find((s) => s.key === value)?.label || value}
          />
          {SERIES.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="ads" fill={PLATFORM_HEX[s.key]} maxBarSize={20} radius={0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {total === 0 && (
        <p className="mt-1 text-center text-xs text-[var(--text-muted)]">Nenhum anúncio detectado nesse período.</p>
      )}
    </div>
  )
}
