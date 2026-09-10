export default function Pagination({ page, totalPages, total, onChange }) {
  if (totalPages <= 1) return null

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-1 py-2 text-sm text-[var(--text-tertiary)]">
      <span>
        Página {page} de {totalPages} · {total} no total
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium hover:bg-[var(--hover-surface)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Anterior
        </button>
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium hover:bg-[var(--hover-surface)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Próxima →
        </button>
      </div>
    </div>
  )
}
