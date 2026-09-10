import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client.js'
import { rangeToParams } from '../utils/dateRange.js'

// Uma série só (o filtro de loja troca QUAL série, nunca soma mais de uma
// linha ao mesmo tempo) — por isso uma cor só, sem legenda, seguindo o guia
// de dataviz: "trend over time, 1 série = sem caixa de legenda".
const BRAND = '#2563eb'

function formatDay(iso) {
  const [, month, day] = iso.split('-')
  return `${day}/${month}`
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const count = payload[0].value
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-xs shadow-lg">
      <p className="text-[var(--text-muted)]">{formatDay(label)}</p>
      <p className="font-semibold text-[var(--text-primary)]">
        {count} produto{count === 1 ? '' : 's'} novo{count === 1 ? '' : 's'}
      </p>
    </div>
  )
}

export default function NewProductsChart({ competitorId, operation, range }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api
      .getNewProductsTimeline({ competitor_id: competitorId || undefined, operation, ...rangeToParams(range) })
      .then(setData)
      .catch((e) => setError(e.message))
  }, [competitorId, operation, range])

  if (error) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">Não deu pra carregar o gráfico.</p>
  if (!data) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">Carregando…</p>

  const total = data.reduce((sum, d) => sum + d.count, 0)

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="newProductsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BRAND} stopOpacity={0.12} />
              <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
            </linearGradient>
          </defs>
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
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="count"
            stroke={BRAND}
            strokeWidth={2}
            fill="url(#newProductsFill)"
            dot={false}
            activeDot={{ r: 4, fill: BRAND, stroke: 'var(--bg-page)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      {total === 0 && (
        <p className="mt-1 text-center text-xs text-[var(--text-muted)]">
          Nenhum produto novo detectado nesse período ainda, o catálogo atual entrou todo de uma vez no cadastro. O
          sinal aparece a partir de agora, conforme os snapshots diários forem rodando.
        </p>
      )}
    </div>
  )
}
