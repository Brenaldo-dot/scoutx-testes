import { useState } from 'react'
import { rawApi } from '../api/rawClient.js'
import QuickPreview from '../components/QuickPreview.jsx'
import ProductThumb from '../components/ProductThumb.jsx'
import { metaAdsLibrarySearchUrl } from '../utils/adLibrary.js'

function fmtPrice(min, max) {
  if (min === null || min === undefined) return '—'
  if (max === null || max === undefined || max === min) return `R$ ${min.toFixed(2)}`
  return `R$ ${min.toFixed(2)} – R$ ${max.toFixed(2)}`
}

function Badges({ p }) {
  const badges = []
  if (p.duplicatePageCount >= 2) {
    const titles = (p.duplicatePages || []).map((d) => d.title).join(' | ')
    badges.push(
      <span key="dup" title={titles} className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10.5px] font-medium text-red-400">
        🔁 {p.duplicatePageCount} páginas
      </span>,
    )
  }
  if (p.ageDays !== null && p.ageDays <= 45) {
    badges.push(
      <span key="new" className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10.5px] font-medium text-blue-300">
        🆕 {p.ageDays}d
      </span>,
    )
  }
  if (p.inBestsellerCollection) {
    badges.push(
      <span key="best" className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400">
        📈 {p.inBestsellerCollection} #{p.bestsellerPosition}
      </span>,
    )
  }
  if (p.variantCount >= 4) {
    badges.push(
      <span key="var" className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-400">
        🎨 {p.variantCount} variantes
      </span>,
    )
  }
  return <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
}

// Mesmo padrão de Products.jsx (👁 Ver = prévia num modal, ↗ = link direto,
// "Ver anúncios ↗" = biblioteca de anúncios da loja) — aqui não existe
// active_ad_count (não é uma raspagem de anúncio, é só o catálogo público),
// então o link de anúncios aparece sempre, não só quando já sabemos que tem
// anúncio ativo.
function ProductLinks({ p, domain, onPreview }) {
  const adsHref = domain ? metaAdsLibrarySearchUrl(domain) : null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <button
        onClick={() => onPreview(p)}
        className="text-xs font-medium text-brand-400 hover:underline"
        title="Prévia rápida sem sair da página"
      >
        👁 Ver
      </button>
      <a
        href={p.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-medium text-brand-400 hover:underline"
        title="Abrir em aba normal"
      >
        ↗
      </a>
      {adsHref && (
        <a
          href={adsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 px-2 py-0.5 text-[10.5px] font-medium text-violet-400 transition-colors hover:bg-violet-500/10"
        >
          Ver anúncios ↗
        </a>
      )}
    </div>
  )
}

const STATS = [
  { key: 'totalProducts', label: 'Produtos públicos' },
  { key: 'totalCollections', label: 'Coleções encontradas' },
  { key: 'bestsellerCollectionsUsed', label: 'Coleções de "mais vendidos" usadas', fn: (d) => d.bestsellerCollectionsUsed.length },
  { key: 'new', label: 'Produtos criados nos últimos 45 dias', fn: (d) => d.products.filter((p) => p.ageDays !== null && p.ageDays <= 45).length },
  { key: 'totalVendors', label: 'Fornecedores distintos' },
  { key: 'totalDuplicatedListings', label: 'Produtos com páginas duplicadas' },
]

export default function EspionarLoja() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [previewProduct, setPreviewProduct] = useState(null)

  async function analisar() {
    const trimmed = url.trim()
    if (!trimmed) {
      setError('Cole a URL da loja antes de analisar')
      return
    }
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const result = await rawApi.espionarLoja(trimmed)
      setData(result)
    } catch (err) {
      setError(err.message || 'Não foi possível analisar esta loja')
    } finally {
      setLoading(false)
    }
  }

  const top = data ? data.products.filter((p) => p.score > 0).slice(0, 15) : []
  const storeDomain = data ? new URL(data.baseUrl).hostname : null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Espionar Loja</h2>
        <p className="text-sm text-[var(--text-muted)]">Analisa o catálogo público de uma loja concorrente inteira.</p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
        <label className="mb-2 block text-sm text-[var(--text-secondary)]">Cole a URL da loja ou de um produto do concorrente:</label>
        <div className="flex items-end gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && analisar()}
            placeholder="https://loja-concorrente.com"
            autoComplete="off"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
          />
          <button onClick={analisar} disabled={loading} className="btn-primary shrink-0 whitespace-nowrap py-2.5">
            {loading ? 'Analisando… (pode levar até 1-2 min em lojas grandes)' : 'Analisar Loja'}
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Só usa dados públicos da loja (catálogo, coleções, datas). Não existe forma pública de saber vendas/faturamento
          reais. Pra achar o fornecedor certo de cada produto, a ferramenta busca a página dele individualmente, então
          lojas grandes demoram mais. Quando o produto realmente não tem fornecedor cadastrado, o campo fica em "—".
        </p>
        {error && (
          <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">{error}</div>
        )}
      </div>

      {data && (
        <>
          <div className="flex flex-wrap gap-3">
            {STATS.map((s) => (
              <div key={s.key} className="min-w-[140px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
                <div className="text-xl font-semibold text-[var(--text-primary)]">{s.fn ? s.fn(data) : data[s.key]}</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{s.label}</div>
              </div>
            ))}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              🔥 Maior sinal de destaque (provável escalando)
            </h3>
            {top.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                Nenhum sinal forte encontrado, a loja não expõe coleções de mais-vendidos ou datas recentes publicamente.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Duas linhas, não uma só: com título + miniatura + até 4
                    badges + score + 3 links de ação, uma linha única
                    (justify-between) deixava o grupo de badges/links "comer"
                    todo o espaço em telas menores e o título sumia,
                    espremido a zero de largura (relatado pelo usuário com
                    print — badges e botões amontoados, sem nome do produto
                    nenhum aparecendo). Título agora tem a linha só pra ele,
                    nunca disputa espaço com o resto. */}
                {top.map((p, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-2.5"
                  >
                    <div className="flex items-center gap-2.5">
                      <ProductThumb src={p.mainImageUrl} title={p.title} size="h-9 w-9" rounded="rounded-lg" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">{p.title}</span>
                      <span className="shrink-0 rounded-full border border-pink-500/35 bg-pink-500/10 px-2 py-0.5 text-[10.5px] font-medium text-pink-400">
                        score {p.score}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <Badges p={p} />
                      <ProductLinks p={p} domain={storeDomain} onPreview={setPreviewProduct} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Catálogo completo</h3>
            <div className="max-h-[420px] overflow-auto rounded-lg border border-[var(--border)]">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[var(--bg-surface-2)] text-[var(--text-muted)]">
                  <tr>
                    {['Produto', 'Fornecedor', 'ID Fornecedor', 'Preço', 'Variantes', 'Imagens', 'Criado há', 'Coleção destaque', 'Páginas duplicadas', 'Score', 'Ações'].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-[var(--border)] px-2.5 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p, i) => (
                    <tr key={i} className="border-b border-[var(--border-soft)] hover:bg-[var(--bg-surface)]">
                      <td className="max-w-[260px] whitespace-normal px-2.5 py-1.5 text-[var(--text-primary)]">
                        <div className="flex items-center gap-2">
                          <ProductThumb src={p.mainImageUrl} title={p.title} size="h-8 w-8" rounded="rounded-md" />
                          <span>{p.title}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.vendor || '—'}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.supplierId || '—'}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{fmtPrice(p.priceMin, p.priceMax)}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.variantCount}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.imageCount}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.ageDays !== null ? `${p.ageDays}d` : '—'}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">
                        {p.inBestsellerCollection ? `${p.inBestsellerCollection} (#${p.bestsellerPosition})` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.duplicatePageCount >= 2 ? `🔁 ${p.duplicatePageCount}` : '—'}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-secondary)]">{p.score}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">
                        <ProductLinks p={p} domain={storeDomain} onPreview={setPreviewProduct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data.vendorsBreakdown?.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Fornecedores (vendor) e quantidade de produtos</h3>
              <ul className="flex flex-wrap gap-1.5">
                {data.vendorsBreakdown.map((v, i) => (
                  <li key={i} className="rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[var(--text-tertiary)]">
                    {v.vendor} ({v.count})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.collections?.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Coleções públicas da loja</h3>
              <ul className="flex flex-wrap gap-1.5">
                {data.collections.map((c, i) => (
                  <li key={i} className="rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[var(--text-tertiary)]">
                    {c.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {previewProduct && (
        <QuickPreview
          product={previewProduct}
          url={previewProduct.url}
          previewSrc={rawApi.spyPreviewUrl(previewProduct.url)}
          onClose={() => setPreviewProduct(null)}
        />
      )}
    </div>
  )
}
