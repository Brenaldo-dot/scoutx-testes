import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import EmptyState from '../components/EmptyState.jsx'
import LinkChip from '../components/LinkChip.jsx'
import { operationLabel, useOperation } from '../context/OperationContext.jsx'

const POLL_MS = 2500

const CONFIDENCE_STYLES = {
  alto: 'bg-red-500/15 text-red-400 border-red-500/30',
  médio: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  baixo: 'bg-[var(--hover-surface)] text-[var(--text-tertiary)] border-[var(--border)]',
}

const CONFIDENCE_LABELS = {
  alto: '🔥 Com certeza escalando',
  médio: '📈 Provável escalando',
  baixo: 'Sinal fraco',
}

function ConfidenceBadge({ confidence }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CONFIDENCE_STYLES[confidence] || CONFIDENCE_STYLES.baixo}`}
    >
      {CONFIDENCE_LABELS[confidence] || confidence}
    </span>
  )
}

function ProductGroupCard({ group }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-[var(--text-primary)]">
          {group.product_handle ? group.product_handle.replaceAll('-', ' ') : 'Produto não identificado'}
        </h4>
        <ConfidenceBadge confidence={group.confidence} />
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
        <span>
          <strong className="text-[var(--text-secondary)]">{group.total_creatives}</strong> criativo
          {group.total_creatives === 1 ? '' : 's'} ativo{group.total_creatives === 1 ? '' : 's'}
        </span>
        {group.max_duplicate_cluster > 1 && (
          <span>
            maior grupo de duplicata: <strong className="text-[var(--text-secondary)]">{group.max_duplicate_cluster}x</strong>
          </span>
        )}
        {group.distinct_dates.length > 0 && (
          <span>
            datas: <strong className="text-[var(--text-secondary)]">{group.distinct_dates.join(', ')}</strong>
          </span>
        )}
        {group.advertiser_names.length > 0 && (
          <span>
            anunciante{group.advertiser_names.length > 1 ? 's' : ''}:{' '}
            <strong className="text-[var(--text-secondary)]">{group.advertiser_names.join(', ')}</strong>
          </span>
        )}
      </div>

      <div className="space-y-2">
        {group.ads.slice(0, 5).map((ad, i) => (
          <div key={i} className="rounded-lg bg-[var(--bg-surface-2)] p-2.5 text-xs">
            <p className="line-clamp-2 text-[var(--text-tertiary)]">{ad.creative_text || 'Sem texto de criativo capturado'}</p>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[var(--text-faint)]">
              <span>{ad.started_at_raw || 'data não confirmada'}</span>
              <LinkChip href={ad.library_url} variant="violet">
                📣 Ver na biblioteca ↗
              </LinkChip>
            </div>
          </div>
        ))}
        {group.ads.length > 5 && (
          <p className="text-xs text-[var(--text-faint)]">+{group.ads.length - 5} criativo(s) a mais</p>
        )}
      </div>
    </div>
  )
}

export default function AdMiner() {
  const { operation } = useOperation()
  const [url, setUrl] = useState('')
  const [scan, setScan] = useState(null)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => () => clearTimeout(pollRef.current), [])

  function poll(id) {
    api
      .getAdMinerScan(id)
      .then((next) => {
        setScan(next)
        if (next.status === 'pending' || next.status === 'running') {
          pollRef.current = setTimeout(() => poll(id), POLL_MS)
        }
      })
      .catch((e) => setError(e.message))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!url.trim()) return
    clearTimeout(pollRef.current)
    setError(null)
    setScan(null)
    setSubmitting(true)
    try {
      const created = await api.createAdMinerScan(url.trim(), operation)
      setScan(created)
      if (created.status === 'pending' || created.status === 'running') {
        pollRef.current = setTimeout(() => poll(created.id), POLL_MS)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const result = scan?.status === 'done' ? scan.result : null
  const scanningNow = scan && (scan.status === 'pending' || scan.status === 'running')

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">Minerador de Anúncios</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Cola a URL de uma loja e o app varre Meta Ads Library, Google Ads Transparency Center e TikTok Creative
          Center (biblioteca de {operationLabel(operation)}) pra achar qual produto ela está escalando agora, sem
          precisar cadastrar a loja como concorrente.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <div className="flex flex-1 min-w-[260px] flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Cole a URL da loja concorrente</label>
          <input
            required
            placeholder="lojaexemplo.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
          />
        </div>
        <button type="submit" disabled={submitting || scanningNow} className="btn-primary">
          {scanningNow ? 'Escaneando…' : 'Analisar'}
        </button>
      </form>

      {error && <EmptyState title="Não deu pra analisar" subtitle={error} />}

      {scanningNow && (
        <EmptyState
          title="Escaneando as bibliotecas de anúncio…"
          subtitle="Meta, Google e TikTok em paralelo, costuma levar de 20 a 60 segundos."
        />
      )}

      {scan?.status === 'failed' && (
        <EmptyState title="O scan falhou" subtitle={scan.error || 'Erro desconhecido, tenta de novo.'} />
      )}

      {result && (
        <div className="space-y-8">
          {result.multi_platform_signal && (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              <p className="font-semibold">⚠️ Sinal de multi-plataforma (nível da loja)</p>
              <p className="mt-1 text-red-300/80">
                {result.domain} tem anúncio ativo na Meta E no Google ao mesmo tempo. Não dá pra confirmar se é o
                MESMO produto nas duas (o Google não expõe a URL de destino do criativo publicamente), mas é forte
                indício de operação em escala, não só teste.
              </p>
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-base font-semibold">Meta (Facebook/Instagram)</h3>
              {result.meta.scan_failed ? (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
                  ⚠️ busca falhou
                </span>
              ) : (
                <span className="rounded-full bg-[var(--hover-surface)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                  {result.meta.total_ads_found} anúncio(s) encontrado(s)
                </span>
              )}
            </div>
            {result.meta.scan_failed ? (
              <EmptyState
                title="Não deu pra escanear a Meta agora"
                subtitle="Timeout ou bloqueio temporário da própria Ads Library, isso NÃO significa que a loja não anuncia lá. Tenta escanear de novo em alguns minutos."
              />
            ) : result.meta.products.length === 0 ? (
              <EmptyState
                title="Nenhum anúncio encontrado na Meta"
                subtitle="A loja não parece estar anunciando ativamente lá no momento."
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {result.meta.products.map((group, i) => (
                  <ProductGroupCard key={group.product_handle || i} group={group} />
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div
              className={`rounded-2xl border p-4 ${result.google.scan_failed ? 'border-amber-500/30 bg-amber-500/5' : 'border-[var(--border)] bg-[var(--bg-surface)]'}`}
            >
              <h3 className="mb-1 text-base font-semibold">Google Ads Transparency</h3>
              <p className="mb-2 text-2xl font-semibold text-[var(--text-primary)]">
                {result.google.scan_failed ? '—' : result.google.total_ads_found}
              </p>
              {result.google.advertiser_names.length > 0 && (
                <p className="mb-2 text-xs text-[var(--text-muted)]">
                  Anunciante(s): {result.google.advertiser_names.join(', ')}
                </p>
              )}
              <p className={`text-xs ${result.google.scan_failed ? 'text-amber-400' : 'text-[var(--text-faint)]'}`}>
                {result.google.scan_failed && '⚠️ '}
                {result.google.note}
              </p>
            </div>
            <div
              className={`rounded-2xl border p-4 ${result.tiktok.scan_failed ? 'border-amber-500/30 bg-amber-500/5' : 'border-[var(--border)] bg-[var(--bg-surface)]'}`}
            >
              <h3 className="mb-1 text-base font-semibold">TikTok Creative Center</h3>
              <p className="mb-2 text-2xl font-semibold text-[var(--text-primary)]">
                {result.tiktok.scan_failed ? '—' : result.tiktok.total_ads_found}
              </p>
              <p className={`text-xs ${result.tiktok.scan_failed ? 'text-amber-400' : 'text-[var(--text-faint)]'}`}>
                {result.tiktok.scan_failed && '⚠️ '}
                {result.tiktok.note}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
