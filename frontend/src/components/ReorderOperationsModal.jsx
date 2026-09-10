import { useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'

// Arrastar com Pointer Events (não HTML5 Drag and Drop) de propósito: DnD
// nativo não funciona direito em touch (celular) — pointer events cobrem
// mouse e touch com o mesmo código, sem precisar de biblioteca externa.
// setPointerCapture no "manico" (grip) faz TODO o gesto (mesmo quando o
// dedo/cursor sai da linha) continuar chegando nesse elemento — por isso o
// cálculo de "em cima de qual linha estou" usa clientY comparado contra o
// getBoundingClientRect de cada linha, em vez de depender de onPointerMove
// disparar em cada uma conforme o cursor passa por cima (não dispararia,
// já que o ponteiro está "capturado" no grip).
export default function ReorderOperationsModal({ items, onClose, onSave }) {
  const [order, setOrder] = useState(items)
  const dragIndexRef = useRef(null)
  const rowRefs = useRef([])

  function handlePointerDown(index, e) {
    dragIndexRef.current = index
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e) {
    if (dragIndexRef.current === null) return
    const y = e.clientY
    let targetIndex = dragIndexRef.current
    for (let i = 0; i < rowRefs.current.length; i++) {
      const el = rowRefs.current[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (y >= rect.top && y <= rect.bottom) {
        targetIndex = i
        break
      }
    }
    if (targetIndex !== dragIndexRef.current) {
      const fromIndex = dragIndexRef.current
      setOrder((prev) => {
        const next = [...prev]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(targetIndex, 0, moved)
        return next
      })
      dragIndexRef.current = targetIndex
    }
  }

  function handlePointerEnd() {
    dragIndexRef.current = null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-[var(--text-primary)]">Organizar países</h3>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Segure o <GripVertical size={12} className="inline -mt-0.5" /> e arraste pra cima ou pra baixo pra escolher a
          ordem que cada país aparece no menu.
        </p>
        <div className="mt-4 space-y-1.5">
          {order.map((op, index) => (
            <div
              key={op.value}
              ref={(el) => (rowRefs.current[index] = el)}
              className="flex select-none items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2.5"
            >
              <button
                type="button"
                onPointerDown={(e) => handlePointerDown(index, e)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
                className="shrink-0 cursor-grab touch-none rounded p-1 text-[var(--text-faint)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
                aria-label={`Arrastar ${op.label} pra reordenar`}
              >
                <GripVertical size={16} />
              </button>
              <span className="text-lg">{op.icon}</span>
              <span className="text-sm text-[var(--text-secondary)]">{op.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Cancelar
          </button>
          <button onClick={() => onSave(order.map((op) => op.value))} className="btn-primary px-4 py-2 text-xs">
            Salvar ordem
          </button>
        </div>
      </div>
    </div>
  )
}
