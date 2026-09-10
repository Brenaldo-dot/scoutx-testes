// Alerta de mudança de preço vem com payload estruturado (old_price/new_price
// — ver backend/app/services/snapshot_service.py) além da mensagem em texto.
// Regra pedida pelo usuário: o valor MENOR sempre fica vermelho, o MAIOR
// sempre fica verde — não importa se é o antigo ou o novo (preço subiu: novo
// maior fica verde; preço caiu: o antigo que era maior fica verde).
//
// Todo alerta criado ANTES desse payload existir tem payload=null (era
// sempre null no banco até agora — nenhum call site preenchia) — sem esse
// fallback de regex em cima da própria mensagem ("era X, agora Y"), alerta
// antigo nunca ganharia a cor, só os novos gerados depois do deploy.
const MESSAGE_PATTERN = /era ([\d.,]+), agora ([\d.,]+)/

function parsePrice(raw) {
  const n = parseFloat(String(raw).replace(',', '.'))
  return Number.isNaN(n) ? null : n
}

export default function PriceChangeRow({ payload, message }) {
  let oldPrice = payload?.old_price ?? null
  let newPrice = payload?.new_price ?? null
  if (oldPrice == null || newPrice == null) {
    const match = message?.match(MESSAGE_PATTERN)
    if (match) {
      oldPrice = parsePrice(match[1])
      newPrice = parsePrice(match[2])
    }
  }
  if (oldPrice == null || newPrice == null) return null
  const old_price = oldPrice
  const new_price = newPrice
  if (old_price === new_price) return null

  const oldIsLower = old_price < new_price
  const oldClass = oldIsLower ? 'text-red-400' : 'text-emerald-400'
  const newClass = oldIsLower ? 'text-emerald-400' : 'text-red-400'

  return (
    <p className="mt-1 text-sm">
      <span className="text-[var(--text-muted)]">Antes: </span>
      <span className={`font-semibold ${oldClass}`}>{old_price}</span>
      <span className="text-[var(--text-muted)]"> → Agora: </span>
      <span className={`font-semibold ${newClass}`}>{new_price}</span>
    </p>
  )
}
