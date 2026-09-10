export default function EmptyState({ title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-surface)] py-16 text-center">
      <p className="text-sm font-medium text-[var(--text-tertiary)]">{title}</p>
      {subtitle && <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">{subtitle}</p>}
    </div>
  )
}
