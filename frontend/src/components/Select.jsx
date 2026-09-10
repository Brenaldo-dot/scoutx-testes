import { useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'

// Dropdown próprio — o <select> nativo do navegador não dá pra estilizar
// por dentro (o painel aberto usa o tema do sistema operacional, não o
// nosso), o que quebrava a identidade visual em qualquer tela com filtro
// (Operação no menu, loja no Dashboard, ordenação em Produtos/Anúncios).
// Mesma API de sempre (value/onChange/options), só o visual muda.
// onEditOption (opcional): mostra um lápis por opção (só as destravadas) —
// usado no seletor de país pra renomear sem sair do dropdown.
export default function Select({ value, onChange, options, placeholder = 'Selecione…', className = '', extraOption, onEditOption, onDeleteOption }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    function onEscape(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onEscape)
    }
  }, [])

  const selected = options.find((o) => String(o.value) === String(value))

  function handlePick(optionValue) {
    onChange(optionValue)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-left text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-brand-500/50 focus:border-brand-500 focus:outline-none"
      >
        <span className="truncate">
          {selected ? (
            <>
              {selected.icon && <span className="mr-1.5">{selected.icon}</span>}
              {selected.label}
            </>
          ) : (
            <span className="text-[var(--text-faint)]">{placeholder}</span>
          )}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 mt-1.5 max-h-72 w-full overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-2xl shadow-black/40">
          {options.map((option) => {
            const isSelected = String(option.value) === String(value)
            // Opção travada pelo plano (ex: país fora do limite da
            // organização) — mostra que existe, mas não deixa escolher: nome
            // riscado + selo do plano que libera, em vez de deixar escolher
            // e só descobrir o bloqueio depois de tentar salvar.
            if (option.locked) {
              return (
                <div
                  key={option.value}
                  title={option.lockedReason}
                  className="flex w-full cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--text-faint)]"
                >
                  {option.icon && <span className="opacity-50">{option.icon}</span>}
                  <span className="truncate line-through decoration-1">{option.label}</span>
                  {option.lockedReason && (
                    <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">
                      {option.lockedReason}
                    </span>
                  )}
                </div>
              )
            }
            return (
              <div key={option.value} className="group flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => handlePick(option.value)}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'bg-brand-500/15 font-medium text-brand-400'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--hover-surface)]'
                  }`}
                >
                  {option.icon && <span>{option.icon}</span>}
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <svg className="ml-auto h-4 w-4 shrink-0 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                {onEditOption && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpen(false)
                      onEditOption(option)
                    }}
                    title="Renomear"
                    className="shrink-0 rounded-md p-1.5 text-[var(--text-faint)] opacity-0 transition-opacity hover:text-brand-500 group-hover:opacity-100"
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {onDeleteOption && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpen(false)
                      onDeleteOption(option)
                    }}
                    title="Excluir"
                    className="shrink-0 rounded-md p-1.5 text-[var(--text-faint)] opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            )
          })}
          {extraOption &&
            (extraOption.locked ? (
              <div
                title={extraOption.lockedReason}
                className="mt-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded-md border-t border-[var(--border-soft)] px-3 py-2 pt-2.5 text-left text-sm text-[var(--text-faint)]"
              >
                <span className="truncate line-through decoration-1">{extraOption.label}</span>
                {extraOption.lockedReason && (
                  <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">
                    {extraOption.lockedReason}
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handlePick(extraOption.value)}
                className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-[var(--border-soft)] px-3 py-2 pt-2.5 text-left text-sm font-medium text-brand-400 transition-colors hover:bg-[var(--hover-surface)]"
              >
                {extraOption.label}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
