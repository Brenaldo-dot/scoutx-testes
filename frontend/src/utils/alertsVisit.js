// Marca de "última vez vista" POR OPERAÇÃO (país) E POR CATEGORIA de alerta
// — tipo WhatsApp por conversa: só zera a bolinha da categoria quando a
// pessoa clica nela de verdade, e só aquela categoria (naquele país) some,
// não todas de uma vez. Sem o país na chave, marcar "Sinais de Escala" como
// visto na Colômbia também zeraria, sem a pessoa nunca ter visto, os
// alertas dessa mesma categoria no México/Equador/Guatemala — pior que só
// um número errado no menu, é alerta de verdade sumindo sem ninguém ler.
// "Todos" nunca escreve aqui, é só uma visão geral.
const VISITS_KEY = 'scoutx_alerts_category_visits'

function readAllVisits() {
  try {
    return JSON.parse(localStorage.getItem(VISITS_KEY) || '{}')
  } catch {
    return {}
  }
}

// Cortes só da operação pedida, com a chave já sem o prefixo de país —
// pronto pra virar `since_map` na chamada à API (que só entende categoria,
// filtra operação separadamente pelo parâmetro `operation`).
export function readCategoryVisits(operation) {
  const prefix = `${operation}:`
  const out = {}
  for (const [key, value] of Object.entries(readAllVisits())) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value
  }
  return out
}

// Dispara um evento próprio pra quem só LÊ a contagem (menu lateral, banner
// do Dashboard) atualizar na hora — clicar numa categoria dentro de
// /alertas só muda o ?categoria= da URL, não a rota, então um efeito
// baseado em location.pathname sozinho não pegaria a mudança.
export function markCategoryVisited(operation, categoryKey) {
  if (!categoryKey) return
  const all = readAllVisits()
  all[`${operation}:${categoryKey}`] = new Date().toISOString()
  localStorage.setItem(VISITS_KEY, JSON.stringify(all))
  window.dispatchEvent(new Event('scoutx:alerts-visited'))
}
