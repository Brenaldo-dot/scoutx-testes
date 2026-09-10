import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import EmptyState from '../components/EmptyState.jsx'
import Pagination from '../components/Pagination.jsx'
import Select from '../components/Select.jsx'
import { DuplicateBadge, ScalingBadge, SupplierIdTag } from '../components/Badges.jsx'
import ProductThumb from '../components/ProductThumb.jsx'
import QuickPreview from '../components/QuickPreview.jsx'
import RefreshButton from '../components/RefreshButton.jsx'
import FilteringIndicator from '../components/FilteringIndicator.jsx'
import { formatDate } from '../utils/date.js'
import { metaAdsLibrarySearchUrl } from '../utils/adLibrary.js'
import { useOperation } from '../context/OperationContext.jsx'

const PAGE_SIZE = 100
const SORT_VALUES = ['recent', 'duplicates', 'active_ads']

export default function Products() {
  const { operation } = useOperation()
  const [searchParams, setSearchParams] = useSearchParams()
  const competitorId = searchParams.get('competitor_id') || ''
  // Antes filtrava Product.scaling (score 80+, só "Escalando" puro) — trocado
  // pra "quente" (score 56+, Quente OU Escalando, mesmo corte da aba Produtos
  // Quentes) a pedido do usuário: o filtro antigo escondia a maioria do que
  // a pessoa já considera "quente" no resto do app.
  const hotOnly = searchParams.get('hot_only') === 'true'
  const sort = SORT_VALUES.includes(searchParams.get('sort')) ? searchParams.get('sort') : 'recent'
  const q = searchParams.get('q') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)

  const [competitors, setCompetitors] = useState([])
  const [products, setProducts] = useState(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState(null)
  const [previewProduct, setPreviewProduct] = useState(null)
  const [searchInput, setSearchInput] = useState(q)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filtering, setFiltering] = useState(false)

  // `cancelled` (mesmo achado ao vivo de HotProducts.jsx, 2026-09-05): sem
  // essa trava, uma resposta antiga chegando depois da mais recente podia
  // zerar a lista de lojas por um instante, derrubando os links que
  // dependem do domínio de TODOS os produtos de uma vez.
  useEffect(() => {
    let cancelled = false
    api
      .listCompetitors({ operation })
      .then((data) => !cancelled && setCompetitors(data))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [operation, refreshKey])

  useEffect(() => {
    // Revisão (achado ao vivo, 2026-08-27): trocar filtro/ordenação
    // mantinha a lista ANTIGA na tela sem indicação nenhuma de que algo
    // estava carregando, até a lista nova aparecer do nada — parecia
    // travado. `filtering` liga um indicador pequeno, sem sumir com o
    // conteúdo atual.
    //
    // `cancelled` (achado ao vivo, 2026-08-28, mesmo bug do Dashboard):
    // sem essa trava, se `operation` mudasse rápido e a resposta da
    // operação ANTIGA chegasse depois da nova, ela sobrescrevia a lista
    // certa com produtos do país errado.
    let cancelled = false
    setFiltering(true)
    api
      .listProducts({
        competitor_id: competitorId || undefined,
        operation: competitorId ? undefined : operation,
        hot_only: hotOnly || undefined,
        q: q || undefined,
        sort,
        page,
        limit: PAGE_SIZE,
      })
      .then(({ items, total }) => {
        if (cancelled) return
        setProducts(items)
        setTotal(total)
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setFiltering(false))
    return () => {
      cancelled = true
    }
  }, [competitorId, operation, hotOnly, q, sort, page, refreshKey])

  // Busca com debounce — sem isso dispararia 1 request por letra digitada.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (searchInput !== q) updateParam('q', searchInput.trim())
    }, 400)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  const competitorNames = Object.fromEntries(competitors.map((c) => [c.id, c.name]))
  const competitorDomains = Object.fromEntries(competitors.map((c) => [c.id, c.domain]))
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function productUrl(p) {
    const domain = competitorDomains[p.competitor_id]
    return domain ? `https://${domain}/products/${p.handle}` : null
  }

  function updateParam(key, value) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    // Qualquer mudança de filtro volta pra página 1 — senão a pessoa fica
    // presa numa página 8 vazia depois de trocar de loja, por exemplo.
    next.delete('page')
    setSearchParams(next)
  }

  function toggleHotOnly(checked) {
    const next = new URLSearchParams(searchParams)
    if (checked) next.set('hot_only', 'true')
    else next.delete('hot_only')
    next.delete('page')
    setSearchParams(next)
  }

  function goToPage(nextPage) {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) next.delete('page')
    else next.set('page', String(nextPage))
    setSearchParams(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-semibold">Produtos</h2>
            <FilteringIndicator show={filtering} />
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            Todos os produtos ativos descobertos nas lojas monitoradas{total > 0 ? `, ${total} no total` : ''}
          </p>
        </div>
        <RefreshButton onRefresh={() => setRefreshKey((k) => k + 1)} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Pesquisar produto</label>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Nome do produto…"
            className="w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Loja</label>
          <Select
            className="w-44"
            value={competitorId}
            onChange={(v) => updateParam('competitor_id', v)}
            options={[{ value: '', label: 'Todas as lojas' }, ...competitors.map((c) => ({ value: String(c.id), label: c.name }))]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--text-muted)]">Ordenar por</label>
          <Select
            className="w-56"
            value={sort}
            onChange={(v) => updateParam('sort', v === 'recent' ? '' : v)}
            options={[
              { value: 'recent', label: 'Vistos recentemente' },
              { value: 'duplicates', label: 'Mais duplicados primeiro' },
              { value: 'active_ads', label: 'Mais anúncios ativos primeiro' },
            ]}
          />
        </div>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--text-tertiary)]">
          <input type="checkbox" checked={hotOnly} onChange={(e) => toggleHotOnly(e.target.checked)} />
          🔥 Só produtos quentes
        </label>
      </div>

      {error && <EmptyState title="Não deu pra carregar os produtos" subtitle={error} />}

      {products && products.length === 0 && (
        <EmptyState
          title="Nenhum produto encontrado"
          subtitle={
            q
              ? `Nenhum produto com "${q}" no nome, com esses filtros.`
              : sort === 'duplicates'
                ? 'Nenhum produto com página duplicada detectada ainda, com esses filtros.'
                : sort === 'active_ads'
                  ? 'Nenhum produto com anúncio ativo detectado ainda, com esses filtros.'
                  : 'Ajuste os filtros ou espere o próximo raio-x rodar.'
          }
        />
      )}

      {products && products.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3">Produto</th>
                {!competitorId && <th className="px-4 py-3">Loja</th>}
                <th className="px-4 py-3">Fornecedor</th>
                <th className="px-4 py-3">Cód. fornecedor</th>
                <th className="px-4 py-3">Preço</th>
                <th className="px-4 py-3">Variações</th>
                <th className="px-4 py-3">📣 Anúncios ativos</th>
                <th className="px-4 py-3">Visto pela última vez</th>
                <th className="px-4 py-3">Sinais</th>
                <th className="px-4 py-3">Ver na loja</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-[var(--bg-surface-2)]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <ProductThumb src={p.main_image_url} title={p.title} />
                      <span className="font-medium text-[var(--text-primary)]">{p.title}</span>
                    </div>
                  </td>
                  {!competitorId && (
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {competitorNames[p.competitor_id] || `#${p.competitor_id}`}
                    </td>
                  )}
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
                    {p.active_ad_count > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
                          📣 {p.active_ad_count}
                        </span>
                        {(() => {
                          // Sempre busca por DOMÍNIO da loja na Meta Ads
                          // Library — nunca o link direto de um anúncio
                          // específico (?id=...), que só mostra os anúncios
                          // DAQUELE anunciante/página. Uma mesma loja costuma
                          // ter vários anunciantes diferentes rodando anúncio
                          // pra ela ao mesmo tempo (confirmado ao vivo pelo
                          // usuário: buscar pelo domínio achou anúncio de 2
                          // páginas diferentes pra mesma loja, buscar pelo
                          // nome de só 1 delas perdia a outra inteira).
                          const href = metaAdsLibrarySearchUrl(competitorDomains[p.competitor_id], operation)
                          return (
                            href && (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 px-2 py-0.5 text-xs font-medium text-violet-400 transition-colors hover:bg-violet-500/10"
                              >
                                Ver anúncios ↗
                              </a>
                            )
                          )
                        })()}
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                    {formatDate(p.last_seen_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <DuplicateBadge duplicateCount={p.duplicate_count} duplicateOf={p.duplicate_of} />
                      <ScalingBadge scaling={p.scaling} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {productUrl(p) && (
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <button
                          onClick={() => setPreviewProduct(p)}
                          className="text-brand-600 hover:underline"
                          title="Prévia rápida sem sair da página"
                        >
                          👁 Ver
                        </button>
                        <a
                          href={productUrl(p)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline"
                          title="Abrir em aba normal"
                        >
                          ↗
                        </a>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {products && products.length > 0 && (
        <Pagination page={page} totalPages={totalPages} total={total} onChange={goToPage} />
      )}

      {previewProduct && (
        <QuickPreview product={previewProduct} url={productUrl(previewProduct)} onClose={() => setPreviewProduct(null)} />
      )}
    </div>
  )
}
