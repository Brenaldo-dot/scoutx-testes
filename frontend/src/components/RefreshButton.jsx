import { useEffect, useRef, useState } from 'react'
import { Check, RotateCw } from 'lucide-react'

// Quanto tempo o botão fica verde "Atualizado!" antes de voltar a virar
// "Atualizar" de novo — pedido explícito do usuário (2026-08-27): 1.5s
// sumia rápido demais, difícil de perceber. 3 minutos dá tempo de sobra
// pra ver e confiar que funcionou, sem morrer verde pra sempre (extremo
// oposto, não dava mais pra saber SE uma atualização nova é que era o
// motivo do verde ou se só nunca voltou ao normal).
const DONE_DURATION_MS = 3 * 60 * 1000

// Botão pequeno "Atualizar" pra recarregar os dados da tela sem precisar
// dar F5 na página inteira — pedido explícito do usuário (2026-08-27).
// `onRefresh` pode devolver uma Promise (aguarda pra parar de girar o
// ícone) ou nada (girada rápida e fixa, cobre chamadas síncronas/estado).
//
// Revisão (achado ao vivo, 2026-08-27): só o ícone girando não bastava —
// numa tela que já estava com o dado certo (nada mudou de verdade), a
// pessoa não tinha como saber se o clique realmente disparou algo ou não.
// Duas provas concretas agora: (1) um "✓ Atualizado!" verde por alguns
// minutos logo depois do giro, (2) a hora exata da última atualização
// bem-sucedida, sempre visível ao lado do botão — a prova definitiva,
// porque muda a cada clique de verdade, mesmo quando os dados em si não
// mudam nada. Continua clicável durante o verde, pra quem quiser forçar
// outra atualização antes dos 3 minutos passarem.
export default function RefreshButton({ onRefresh, className = '' }) {
  const [status, setStatus] = useState('idle') // idle | spinning | done
  const [lastUpdated, setLastUpdated] = useState(null)
  const doneTimeoutRef = useRef(null)

  useEffect(() => () => clearTimeout(doneTimeoutRef.current), [])

  async function handleClick() {
    clearTimeout(doneTimeoutRef.current)
    setStatus('spinning')
    try {
      await onRefresh()
    } finally {
      // Giro mínimo de meio-segundo mesmo se a resposta vier instantânea —
      // sem isso, numa rede rápida o ícone só "pisca", sem dar a sensação
      // de que algo realmente aconteceu.
      setTimeout(() => {
        setLastUpdated(new Date())
        setStatus('done')
        doneTimeoutRef.current = setTimeout(() => setStatus('idle'), DONE_DURATION_MS)
      }, 500)
    }
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={status === 'spinning'}
        title="Atualizar"
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
          status === 'done'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
            : 'border-[var(--border)] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)] hover:border-brand-500/50 hover:text-brand-500'
        }`}
      >
        {status === 'done' ? <Check size={13} /> : <RotateCw size={13} className={status === 'spinning' ? 'animate-spin' : ''} />}
        {status === 'done' ? 'Atualizado!' : 'Atualizar'}
      </button>
      {lastUpdated && status !== 'spinning' && (
        <span className="whitespace-nowrap text-[10.5px] text-[var(--text-faint)]">
          às {lastUpdated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      )}
    </div>
  )
}
