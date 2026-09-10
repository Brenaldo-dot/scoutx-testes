import { api } from '../api/client'

// Mostra a página REAL do produto (buscada no back e reservida a partir do
// nosso domínio — ver backend/app/api/products.py::preview_product_page) num
// iframe dentro da própria tela, com scroll de verdade pela página inteira —
// sem depender do Shopify deixar carregar em iframe direto (ele bloqueia por
// padrão) e sem abrir aba nova.
//
// sandbox="" (sem nenhum allow-*) bloqueia script/form/popup dentro do
// iframe — o back já remove todo <script> antes de servir, isso aqui é
// defesa em profundidade, já que é conteúdo de concorrente (não confiável).
// `previewSrc` deixa o chamador apontar pra outra rota de prévia (ver
// EspionarLoja.jsx, que usa /api/spy-preview em vez de
// /api/products/:id/preview — o produto ali vem de um scrape na hora, sem
// product_id persistido). Sem essa prop, cai no comportamento original.
export default function QuickPreview({ product, url, previewSrc, onClose }) {
  if (!product) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[var(--bg-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <p className="truncate text-xs font-medium text-[var(--text-muted)]" title={product.title}>
            Prévia · {product.title}
          </p>
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover-surface)] hover:text-[var(--text-tertiary)]"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        <iframe
          src={previewSrc || api.productPreviewUrl(product.id)}
          sandbox=""
          title={`Prévia de ${product.title}`}
          className="w-full flex-1 bg-[var(--bg-surface)]"
        />

        <div className="shrink-0 border-t border-[var(--border)] p-3 text-center">
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-600 hover:underline">
            Abrir página completa na loja ↗
          </a>
        </div>
      </div>
    </div>
  )
}
