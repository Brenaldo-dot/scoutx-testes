import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client.js'
import EmptyState from '../components/EmptyState.jsx'
import StatCard from '../components/StatCard.jsx'
import Pagination from '../components/Pagination.jsx'
import { ClassificationBadge, DuplicateBadge, ScalingBadge, StatusBadge, SupplierIdTag } from '../components/Badges.jsx'
import QuickPreview from '../components/QuickPreview.jsx'
import LinkChip from '../components/LinkChip.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import ProductThumb from '../components/ProductThumb.jsx'

const PAGE_SIZE = 100

// Mesmo mapeamento de services/competitor_service.py:country_for_operation
// no backend — os links "abrir na ferramenta oficial" tinham CO fixo,
// levando concorrente do México pra biblioteca do país errado igual o bug
// original do scan automático.
const OPERATION_COUNTRY = { colombia: 'CO', mexico: 'MX', equador: 'EC', guatemala: 'GT', espanha: 'ES' }

function metaAdsLibraryUrl(domain, country) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    q: domain,
    search_type: 'keyword_unordered',
  })
  return `https://www.facebook.com/ads/library/?${params.toString()}`
}

function tiktokCreativeCenterUrl(domain, country) {
  const params = new URLSearchParams({ keyword: domain, region: country, period: '30' })
  return `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?${params.toString()}`
}

function googleAdsTransparencyUrl(domain, country) {
  const params = new URLSearchParams({ region: country, domain })
  return `https://adstransparency.google.com/?${params.toString()}`
}

export default function CompetitorDetail() {
  const { id } = useParams()
  const [competitor, setCompetitor] = useState(null)
  const [products, setProducts] = useState(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState(null)
  const [previewProduct, setPreviewProduct] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    setCompetitor(null)
    setPage(1)
    api.getCompetitor(id).then(setCompetitor).catch((e) => setError(e.message))
  }, [id, refreshKey])

  useEffect(() => {
    api
      .listProducts({ competitor_id: id, page, limit: PAGE_SIZE })
      .then(({ items, total }) => {
        setProducts(items)
        setTotal(total)
      })
      .catch((e) => setError(e.message))
  }, [id, page, refreshKey])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const country = competitor ? OPERATION_COUNTRY[competitor.operation] || 'CO' : 'CO'

  if (error) return <EmptyState title="Não deu pra carregar o concorrente" subtitle={error} />
  if (!competitor) return <p className="text-sm text-[var(--text-muted)]">Carregando…</p>

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-3">
          <Link to="/concorrentes" className="text-sm text-brand-600 hover:underline">
            ← Concorrentes
          </Link>
          <RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold">{competitor.name}</h2>
          <StatusBadge status={competitor.status} />
          <ClassificationBadge classification={competitor.classification} />
        </div>
        <p className="text-sm text-[var(--text-muted)]">{competitor.domain}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <LinkChip href={`https://${competitor.domain}/`} variant="brand">
            🏬 Abrir loja ↗
          </LinkChip>
          <LinkChip href={metaAdsLibraryUrl(competitor.domain, country)} variant="violet">
            🔍 Meta Ads Library ↗
          </LinkChip>
          <LinkChip href={tiktokCreativeCenterUrl(competitor.domain, country)} variant="violet">
            🔍 TikTok Creative Center ↗
          </LinkChip>
          <LinkChip href={googleAdsTransparencyUrl(competitor.domain, country)} variant="violet">
            🔍 Google Ads Transparency ↗
          </LinkChip>
        </div>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          Abre a busca por "{competitor.domain}" direto na fonte, funciona mesmo se a raspagem automática falhar ou
          não achar nada, porque quem navega é você. O TikTok é limitado por natureza da ferramenta deles: a
          biblioteca pública só cobre países da União Europeia (exigência regulatória local, testado ao vivo, o
          seletor de país nem lista Colômbia), então não existe uma forma pública de confirmar anúncio de TikTok pra
          loja colombiana nenhuma, não é falha da raspagem. Já o Google cobre Colômbia normalmente, pode aparecer
          bem mais anúncio ali do que os que a raspagem automática mostra na aba Anúncios.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Produtos" value={competitor.total_products} />
        <StatCard label="Fornecedores únicos" value={competitor.vendor_count} />
        <StatCard
          label="Faixa de preço"
          value={
            competitor.price_min != null
              ? `${competitor.price_min} – ${competitor.price_max}`
              : '—'
          }
        />
        <StatCard
          label="Volume médio/dia"
          value={competitor.avg_daily_volume ?? 'aguardando dado'}
          hint="Baseado em queda de estoque (2+ pontos de dado)"
        />
      </div>

      <div>
        <h3 className="mb-3 text-base font-semibold">Stack tecnológica detectada</h3>
        {competitor.tech_stack.filter((t) => t.active).length === 0 ? (
          <EmptyState
            title="Nada detectado ainda"
            subtitle="A stack é coletada no raio-x inicial e atualizada toda semana."
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {competitor.tech_stack
              .filter((t) => t.active)
              .map((t) => (
                <span
                  key={t.name}
                  className="rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1 text-xs text-[var(--text-tertiary)]"
                  title={t.external_id ? `ID: ${t.external_id}` : undefined}
                >
                  {t.name}
                  {t.external_id && <span className="ml-1 text-[var(--text-muted)]">· {t.external_id}</span>}
                </span>
              ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-base font-semibold">Produtos{total > 0 ? ` (${total})` : ''}</h3>
        {!products || products.length === 0 ? (
          <EmptyState title="Nenhum produto encontrado ainda" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3">Produto</th>
                  <th className="px-4 py-3">Fornecedor</th>
                  <th className="px-4 py-3">Cód. fornecedor</th>
                  <th className="px-4 py-3">Preço</th>
                  <th className="px-4 py-3">Variações</th>
                  <th className="px-4 py-3">Sinais</th>
                  <th className="px-4 py-3">Anúncios</th>
                  <th className="px-4 py-3">Ver na loja</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {products.map((p) => {
                  const url = `https://${competitor.domain}/products/${p.handle}`
                  return (
                    <tr key={p.id} className="hover:bg-[var(--bg-surface-2)]">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <ProductThumb src={p.main_image_url} title={p.title} />
                          <span className="font-medium text-[var(--text-primary)]">{p.title}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">{p.vendor || '—'}</td>
                      <td className="px-4 py-3">
                        <SupplierIdTag supplierId={p.supplier_id} />
                      </td>
                      <td className="px-4 py-3">
                        {p.price_min != null
                          ? `${p.price_min}${p.price_max && p.price_max !== p.price_min ? ` – ${p.price_max}` : ''}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3">{p.variant_count}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          <DuplicateBadge duplicateCount={p.duplicate_count} duplicateOf={p.duplicate_of} />
                          <ScalingBadge scaling={p.scaling} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {p.active_ad_count > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
                              📣 {p.active_ad_count}
                            </span>
                            <a
                              href={metaAdsLibraryUrl(competitor.domain, country)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 px-2 py-0.5 text-xs font-medium text-violet-400 transition-colors hover:bg-violet-500/10"
                            >
                              Ver anúncios ↗
                            </a>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--text-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <button
                            onClick={() => setPreviewProduct(p)}
                            className="text-brand-600 hover:underline"
                            title="Prévia rápida sem sair da página"
                          >
                            👁 Ver
                          </button>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-600 hover:underline"
                            title="Abrir em aba normal"
                          >
                            ↗
                          </a>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {products && products.length > 0 && (
          <Pagination page={page} totalPages={totalPages} total={total} onChange={setPage} />
        )}
      </div>

      {previewProduct && (
        <QuickPreview
          product={previewProduct}
          url={`https://${competitor.domain}/products/${previewProduct.handle}`}
          onClose={() => setPreviewProduct(null)}
        />
      )}
    </div>
  )
}
