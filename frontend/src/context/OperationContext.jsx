import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { rawApi } from '../api/rawClient.js'
import { useAuth } from './AuthContext.jsx'

const STORAGE_KEY = 'mega-minerador-operation'
const CUSTOM_STORAGE_KEY = 'mega-minerador-custom-operations'
const LABEL_OVERRIDES_KEY = 'mega-minerador-operation-label-overrides'
const TOUCHED_HISTORY_KEY = 'mega-minerador-operation-touched'
const CUSTOM_ORDER_KEY = 'mega-minerador-operation-order'

// Escada de planos por VAGA de país — não é só "próximo plano geral": quem
// tá no Standard (1 vaga) vê o 2º e o 3º país cabendo no Pro, mas o 4º só
// cabe no Enterprise. Rotular todo mundo travado como "Requer plano Pro"
// seria mentira pro 4º em diante (upar pra Pro não destravaria ele). Espelha
// PLAN_LIMITS do backend Node (db.js) — são só 3 planos fixos, duplicar essa
// escada pequena aqui é mais simples que expor plano/label por uma rota nova.
const PLAN_TIERS = [
  { label: 'Pro', maxOperations: 3 },
  { label: 'Enterprise', maxOperations: Infinity },
]

export function requiredPlanForSlot(slot) {
  const tier = PLAN_TIERS.find((t) => slot <= t.maxOperations)
  return tier ? tier.label : null
}

// Países com suporte "de verdade" (rotina de busca de anúncio por país em
// services/competitor_service.py:country_for_operation) — adicionar um novo
// é só acrescentar aqui E lá no backend. "Outro" não é uma operação de
// verdade, é a ação de cadastrar uma nova (ver addCustomOperation) — quem
// escolhe um país fora dessa lista fixa cai no CUSTOM_STORAGE_KEY abaixo.
export const OPERATIONS = [
  { value: 'colombia', label: 'Colômbia', flag: '🇨🇴' },
  { value: 'mexico', label: 'México', flag: '🇲🇽' },
  { value: 'equador', label: 'Equador', flag: '🇪🇨' },
  { value: 'guatemala', label: 'Guatemala', flag: '🇬🇹' },
  { value: 'espanha', label: 'Espanha', flag: '🇪🇸' },
]

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function loadCustomOperations() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function loadLabelOverrides() {
  try {
    return JSON.parse(localStorage.getItem(LABEL_OVERRIDES_KEY) || '{}')
  } catch {
    return {}
  }
}

const OperationContext = createContext(null)

// BUG corrigido (achado ao vivo, 2026-08-25): a chave de storage era global
// pro NAVEGADOR, não por CONTA — quem testasse uma conta nova no mesmo
// navegador que já tinha usado o ScoutX antes (como admin ou outra conta)
// herdava o país que já estava salvo ali, e o país "certo" da conta nova
// nunca virava a seleção ativa (o checkmark ficava preso no valor antigo,
// consumindo vaga de plano à toa). Escopar por email da conta logada
// resolve: cada conta tem sua própria chave, sem depender do navegador
// estar "limpo".
function operationKeyFor(email) {
  return email ? `${STORAGE_KEY}:${email}` : STORAGE_KEY
}

function touchedHistoryKeyFor(email) {
  return `${TOUCHED_HISTORY_KEY}:${email}`
}

function loadTouchedHistory(email) {
  try {
    return JSON.parse(localStorage.getItem(touchedHistoryKeyFor(email)) || '[]')
  } catch {
    return []
  }
}

// Ordem que a PESSOA escolheu à mão (arrastando, ver reorderOperations
// abaixo) — quando existe, tem prioridade sobre a ordem automática por
// "primeiro toque" (touchedHistory). Por conta, igual o resto: cada uma
// organiza o menu do jeito que quiser sem mexer na de ninguém.
function operationOrderKeyFor(email) {
  return `${CUSTOM_ORDER_KEY}:${email}`
}

function loadCustomOrder(email) {
  try {
    return JSON.parse(localStorage.getItem(operationOrderKeyFor(email)) || '[]')
  } catch {
    return []
  }
}

export function OperationProvider({ children }) {
  const { me, refreshMe } = useAuth()
  const email = me?.email || null
  const defaultOperation = me?.defaultOperation || null

  // `operation` continua com um valor válido desde o primeiro render (nunca
  // fica null) — o resto do app (dashboard, concorrentes, etc.) não precisa
  // saber que ninguém escolheu nada ainda, continua funcionando igual. No
  // instante inicial ainda não sabemos o email da conta (useAuth carrega
  // /api/me de forma assíncrona), então parte do valor "solto" antigo só
  // como placeholder — o efeito abaixo corrige pro valor DA CONTA assim
  // que o email chega, antes de qualquer interação real ser possível.
  // `needsCountryPick` é só um aviso pra UI: true quando ESSA CONTA nunca
  // escolheu um país de verdade — o Layout usa isso pra mostrar o seletor
  // inicial de país, em vez de deixar a conta presa em "Colômbia" sem
  // avisar (era o comportamento antigo).
  const [operation, setOperationRaw] = useState(() => localStorage.getItem(STORAGE_KEY) || 'colombia')
  const [needsCountryPick, setNeedsCountryPick] = useState(() => localStorage.getItem(STORAGE_KEY) === null)
  // BUG corrigido (achado ao vivo, 2026-08-25): só guardávamos o país ATUAL,
  // então trocar de país pra só dar uma olhada "esquecia" o anterior — ele
  // caía pro fim da lista (perdia o lugar reservado) e podia até aparecer
  // travado, mesmo já tendo sido escolhido antes. Esse histórico guarda TODO
  // país que a conta já selecionou alguma vez (não só o que está na tela
  // agora), pra nenhum deles perder a vaga só por não ser o que está sendo
  // visto no momento.
  const [touchedHistory, setTouchedHistory] = useState(() => loadTouchedHistory(null))
  // Ordem manual (ver reorderOperations) — vazio = ainda ninguém arrastou
  // nada nessa conta, usa a ordem automática por "primeiro toque" de sempre.
  const [customOrder, setCustomOrder] = useState(() => loadCustomOrder(null))
  const initializedForEmail = useRef(null)

  useEffect(() => {
    if (!email || initializedForEmail.current === email) return
    initializedForEmail.current = email
    setTouchedHistory(loadTouchedHistory(email))
    setCustomOrder(loadCustomOrder(email))

    // BUG corrigido (achado ao vivo, 2026-08-25): até aqui essa decisão só
    // vivia no localStorage do NAVEGADOR — trocar de dispositivo, abrir
    // numa aba anônima nova, ou só limpar os dados do site fazia perguntar
    // de novo pra sempre, mesmo a conta já tendo escolhido antes. Agora o
    // servidor é a fonte de verdade (organizations.default_operation, ver
    // db.js e GET /api/me) só pra decidir SE pergunta de novo (nunca, uma
    // vez setado) — não pra decidir QUAL país mostrar, ver bug corrigido
    // logo abaixo.
    if (defaultOperation) {
      // BUG corrigido (achado ao vivo, 2026-08-26): todo refresh voltava
      // pro país ORIGINAL (defaultOperation, a primeiríssima escolha da
      // conta, gravada uma vez só e nunca mais mexida) em vez de continuar
      // no que a pessoa estava DE FATO vendo antes de atualizar a página —
      // trocar pra "México" no seletor, dar F5, e cair de volta em
      // "Colômbia" só porque foi o primeiro país escolhido meses atrás.
      // A chave escopada (operationKeyFor) já é mantida em dia com o país
      // sendo VISTO agora (ver efeito de persistência abaixo, roda a cada
      // troca) — ela é a fonte certa pra "onde eu estava", o servidor só
      // entra como valor inicial pra quando essa chave ainda nem existe
      // (primeiro acesso desse navegador/dispositivo).
      const lastViewed = localStorage.getItem(operationKeyFor(email))
      setOperationRaw(lastViewed || defaultOperation)
      setNeedsCountryPick(false)
      if (!lastViewed) localStorage.setItem(operationKeyFor(email), defaultOperation)
      return
    }

    const scoped = localStorage.getItem(operationKeyFor(email))
    if (scoped) {
      setOperationRaw(scoped)
      setNeedsCountryPick(false)
      rawApi.setDefaultOperation(scoped).catch(() => {})
      return
    }
    // REMOVIDO (2026-08-25, mesmo dia que essa trava por conta foi criada):
    // existia aqui uma migração que aproveitava a chave antiga (global do
    // navegador, sem dono) achando que era de um cliente de antes dessa
    // trava existir. Só que essa trava foi feita HOJE — não existe cliente
    // real "de antes" pra migrar — e essa chave antiga, na prática, é só
    // resíduo de teste (ex: o admin testando no mesmo navegador). Resultado:
    // toda conta NOVA criada nesse navegador herdava esse resíduo e nunca
    // via o seletor de país (bug relatado: "criei conta nova e não
    // perguntou"). Sem essa migração, servidor e chave escopada por conta
    // continuam funcionando normal — só o atalho problemático saiu.
    // Nem servidor, nem chave escopada: essa conta é tratada como se fosse
    // realmente a primeira vez, ponto final.
    setNeedsCountryPick(true)
  }, [email, defaultOperation])

  function setOperation(value) {
    // A primeira escolha de verdade (needsCountryPick ainda true nesse
    // instante) é a que vale pra sempre pro servidor — próximas trocas só
    // mudam o que está sendo VISTO agora, não mexem no default salvo (ver
    // setOrgDefaultOperationIfUnset no backend, que também já ignora
    // chamadas repetidas por segurança, essa checagem aqui é só pra não
    // fazer requisição à toa).
    if (needsCountryPick) {
      rawApi.setDefaultOperation(value).catch(() => {})
    }
    setNeedsCountryPick(false)
    setOperationRaw(value)
    // touchedHistory é atualizado num useEffect (ver abaixo), não aqui —
    // cobre TODOS os jeitos de `operation` mudar (essa função, migração de
    // conta antiga, valor vindo do servidor), não só clique explícito.
  }

  // BUG corrigido (achado ao vivo, 2026-08-25 — afetava principalmente
  // conta ADMIN, que nunca passa pela tela de escolher país): o país
  // ATUAL só entrava no `touchedHistory` quando alguém chamava
  // setOperation() de propósito. Enquanto isso não acontecia (ex: admin
  // só navegando, sem nunca clicar no seletor), `operation` continuava
  // valendo 'colombia' (o placeholder inicial) MAS sem estar no
  // `touchedHistory` — e como `touchedOperations` (Set usado pra montar a
  // lista, ver abaixo) sempre incluía o `operation` atual, Colômbia ficava
  // de fora tanto do "já tocado" quanto do "ainda não tocado":
  // desaparecia da lista inteira. No primeiro clique em qualquer outro
  // país, a MESMA coisa acontecia com ele até o próximo clique — dava a
  // impressão de itens "sambando" (sumindo/reaparecendo) a cada clique.
  // Esse efeito garante que `operation` SEMPRE está em `touchedHistory`
  // assim que deixa de ser só o placeholder (needsCountryPick false),
  // não importa por qual caminho ele mudou.
  useEffect(() => {
    if (needsCountryPick) return
    setTouchedHistory((prev) => (prev.includes(operation) ? prev : [...prev, operation]))
  }, [operation, needsCountryPick])
  const [customOperations, setCustomOperations] = useState(loadCustomOperations)

  // BUG corrigido (achado ao vivo, 2026-08-26): país customizado (via "Meu
  // país não está na lista") é validado e gravado no SERVIDOR sem
  // restrição nenhuma (organizations.default_operation aceita qualquer
  // string, ver PATCH /api/me/default-operation em server.js) — mas o
  // NOME/ícone de exibição dele só existe no localStorage do navegador que
  // criou (customOperations, ver addCustomOperation). Resultado: abrir a
  // conta num navegador/dispositivo diferente (ou só limpar dados do site)
  // trazia o valor certo do servidor, mas o Select não achava nenhuma
  // opção com esse `value` na lista local — caía no placeholder
  // "Selecione…" em vez de mostrar o país de verdade, mesmo a escolha
  // estando salva e correta por baixo. Corrigido reconstruindo a entrada
  // que falta a partir do próprio valor (rótulo = o valor mesmo, editável
  // depois pelo lápis de renomear) assim que ela aparece sem estar em
  // nenhuma lista conhecida — auto-corrige e já fica salvo pras próximas
  // vezes nesse navegador.
  useEffect(() => {
    if (needsCountryPick || !operation) return
    const known = OPERATIONS.some((op) => op.value === operation) || customOperations.some((op) => op.value === operation)
    if (known) return
    setCustomOperations((prev) =>
      prev.some((op) => op.value === operation) ? prev : [...prev, { value: operation, label: operation, flag: '🌎' }]
    )
  }, [operation, needsCountryPick, customOperations])

  const [labelOverrides, setLabelOverrides] = useState(loadLabelOverrides)
  // null = ainda carregando/sem organização (admin) — não trava nada até
  // saber de verdade, pra não piscar país bloqueado por engano.
  const [planLimit, setPlanLimit] = useState(null)

  useEffect(() => {
    api.getMyOperationsLimit().then(setPlanLimit).catch(() => {})
  }, [])

  // Auto-cura (2026-08-27, mesmo bug do comentão em touchedOrdered mais
  // abaixo): assim que o servidor confirma que um país tem concorrente de
  // verdade cadastrado, grava ele em touchedHistory (se ainda não
  // estiver) — persistido no localStorage escopado por conta pelo efeito
  // de sempre, então da próxima vez esse navegador já sabe sozinho, sem
  // depender de esperar esse merge de novo a cada carregamento.
  useEffect(() => {
    if (!planLimit?.usedOperations?.length) return
    setTouchedHistory((prev) => {
      const missing = planLimit.usedOperations.filter((v) => !prev.includes(v))
      return missing.length ? [...prev, ...missing] : prev
    })
  }, [planLimit])

  // Revisão: achado ao vivo — conta Standard (1 país) conseguia trocar
  // LIVREMENTE entre os 4 países fixos no seletor, mesmo sem nunca ter
  // cadastrado concorrente em nenhum, porque `usedOperations` (vindo do
  // backend) só conta país que já tem CONCORRENTE DE VERDADE — um Standard
  // recém-criado, com 0 concorrentes, tinha `usedOperations = []`,
  // `0 >= 1` é falso, então nada travava ainda. O cadastro em si sempre foi
  // protegido (_assert_operation_allowed no backend), mas o SELETOR ficava
  // livre até a primeira loja — dava pra "passear" pelos 4 países vendo a
  // tela (vazia) de cada um, o que não bate com "Standard = 1 país" prometido
  // na venda. Corrigido contando TODO país já visto (touchedHistory) como
  // "usado" também, mesmo sem concorrente nenhum ainda — trava a partir do
  // primeiro país visto, não só do primeiro cadastro, e sem esquecer os
  // países vistos antes só porque não é o que está na tela agora.
  // `operation` só entra aqui se needsCountryPick já for false (escolha de
  // verdade feita) — incluir o placeholder inicial ('colombia') antes
  // disso é o bug corrigido acima: ele sumia da lista sem nunca ter sido
  // escolhido de verdade. Redundante com touchedHistory na maioria dos
  // casos (o efeito acima já garante isso), mas evita 1 render de
  // atraso logo depois de escolher, antes do efeito rodar.
  const touchedOperations = new Set([
    ...(planLimit?.usedOperations || []),
    ...touchedHistory,
    ...(needsCountryPick ? [] : [operation]),
  ])

  function isOperationLocked(value) {
    if (!planLimit || planLimit.maxOperations === null) return false
    if (touchedOperations.has(value)) return false
    return touchedOperations.size >= planLimit.maxOperations
  }

  // Criar um país NOVO (fora dos que a org já usa) também consome vaga —
  // mesma trava, só que antes de tentar (evita cadastrar um nome que nunca
  // vai conseguir usar).
  const atOperationCap =
    !!planLimit && planLimit.maxOperations !== null && touchedOperations.size >= planLimit.maxOperations

  // Mesma ideia, pro teto de concorrentes cadastrados do plano (Standard até
  // 50, Pro até 250, Enterprise ilimitado) — sem a escada de "qual plano libera a
  // Nª vaga" dos países porque aqui não tem opção fixa pra travar uma por
  // uma, é só "cheio ou não".
  const atCompetitorCap =
    !!planLimit && planLimit.maxCompetitors !== null && planLimit.usedCompetitors >= planLimit.maxCompetitors

  useEffect(() => {
    // Enquanto needsCountryPick for true, esse valor ainda é só o default
    // interno ('colombia'), não uma escolha de verdade — gravar ele agora
    // faria o aviso de "escolher país" sumir sozinho no próximo carregamento,
    // sem a pessoa ter escolhido nada. Só grava depois que setOperation()
    // (via clique num país ou "adicionar país") passar por aqui de propósito.
    // Sem email ainda (carregando /api/me) também não grava — evitaria
    // gravar na chave global antiga por engano antes de saber de quem é.
    if (needsCountryPick || !email) return
    localStorage.setItem(operationKeyFor(email), operation)
  }, [operation, needsCountryPick, email])

  useEffect(() => {
    if (!email) return
    localStorage.setItem(touchedHistoryKeyFor(email), JSON.stringify(touchedHistory))
  }, [touchedHistory, email])

  useEffect(() => {
    if (!email) return
    localStorage.setItem(operationOrderKeyFor(email), JSON.stringify(customOrder))
  }, [customOrder, email])

  useEffect(() => {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customOperations))
  }, [customOperations])

  useEffect(() => {
    localStorage.setItem(LABEL_OVERRIDES_KEY, JSON.stringify(labelOverrides))
  }, [labelOverrides])

  // Renomear vale pra qualquer país (fixo ou customizado) — usuário que só
  // opera no México não devia ficar vendo "Colômbia" na lista só porque é o
  // primeiro item padrão. Fica salvo por navegador (mesmo esquema de
  // customOperations), não por organização — cada admin/colaborador pode
  // ver um nome diferente pro mesmo `value`, o que é aceitável já que é só
  // rótulo de exibição, o valor real (`operation`) continua igual pra todo
  // mundo por baixo.
  function renameOperation(value, newLabel) {
    const label = newLabel.trim()
    if (!label) return
    setLabelOverrides((prev) => ({ ...prev, [value]: label }))
  }

  // Tira um país da lista da conta (libera a vaga do plano). Devolve uma
  // mensagem de erro (string) se não puder, ou null se removeu com
  // sucesso — quem chama decide como mostrar o erro (ver Layout.jsx).
  // Bloqueia se ainda tem concorrente de VERDADE cadastrado nesse país
  // (planLimit.usedOperations vem do backend, contando concorrente real —
  // ver getMyOperationsLimit) — sem essa trava, "excluir" um país que
  // ainda tem dado dava a falsa impressão de ter liberado a vaga, mas ela
  // seria recontada na hora (o backend confere de novo a cada carregamento),
  // só reaparecendo do nada. Tem que remover os concorrentes daquele país
  // primeiro (aba Concorrentes), igual a mesma trava usada pra excluir uma
  // organização inteira.
  function removeOperation(value) {
    if (planLimit?.usedOperations?.includes(value)) {
      return "Essa organização ainda tem concorrente cadastrado nesse país — remova-os primeiro na aba Concorrentes antes de excluir o país.";
    }
    setTouchedHistory((prev) => prev.filter((v) => v !== value))
    setCustomOperations((prev) => prev.filter((op) => op.value !== value))
    setCustomOrder((prev) => prev.filter((v) => v !== value))
    setLabelOverrides((prev) => {
      if (!(value in prev)) return prev
      const next = { ...prev }
      delete next[value]
      return next
    })
    const remaining = touchedHistory.filter((v) => v !== value)

    if (operation === value) {
      if (remaining.length > 0) {
        setOperation(remaining[0])
      } else {
        // Última operação da conta foi embora — trata igual conta que
        // nunca escolheu nada (mesmo estado de needsCountryPick), mostra o
        // seletor inicial de novo em vez de deixar `operation` apontando
        // pra um valor que não existe mais em lugar nenhum.
        setNeedsCountryPick(true)
        // BUG corrigido (achado ao vivo, 2026-08-26): needsCountryPick=true
        // sozinho não bastava — a chave escopada (operationKeyFor) ainda
        // tinha o valor excluído gravado de uma sessão anterior (o efeito
        // que grava ali só roda enquanto needsCountryPick é false, nunca
        // LIMPA quando vira true). Resultado: um refresh logo em seguida
        // reencontrava esse valor "fantasma" no localStorage ANTES mesmo
        // de checar o servidor, e a conta via o país excluído de volta,
        // com needsCountryPick=false, como se nada tivesse acontecido.
        if (email) localStorage.removeItem(operationKeyFor(email))
      }
    }

    // BUG corrigido (achado ao vivo, 2026-08-26): excluir justo o país que
    // era o "padrão pra sempre" gravado no SERVIDOR (organizations.
    // default_operation) não bastava só limpar o estado local — no
    // próximo refresh (ou outro dispositivo), GET /api/me continuava
    // devolvendo o valor antigo e ele "ressuscitava" sozinho na tela.
    // force=true sobrescreve mesmo já tendo um valor salvo (ver
    // PATCH /api/me/default-operation) — algo que só faz sentido nesse
    // fluxo de exclusão, nunca no primeiro-acesso normal.
    if (value === defaultOperation) {
      rawApi
        .setDefaultOperation(remaining[0] || null, { force: true })
        .then(() => refreshMe())
        .catch(() => {})
    }

    return null
  }

  // Sem mapeamento de país fixo no backend, um país "outro" cai no default
  // (CO) só pra rotina de busca de anúncio — o resto do app (dashboard,
  // concorrentes, produtos) funciona normal, filtrando por esse valor igual
  // aos países fixos.
  function addCustomOperation(countryName) {
    const label = countryName.trim()
    if (!label) return null
    const value = slugify(label) || `outro-${Date.now()}`
    const existing = [...OPERATIONS, ...customOperations].find((o) => o.value === value)
    if (existing) {
      setOperation(existing.value)
      return existing.value
    }
    const next = { value, label, flag: '🌎' }
    setCustomOperations((prev) => [...prev, next])
    setOperation(value)
    return value
  }

  // Ordem exibida no menu lateral (Layout.jsx): por padrão, cada país ganha
  // posição fixa na ordem em que foi TOCADO pela primeira vez (ver o efeito
  // de touchedHistory acima) — o que já resolvia o país "sambando" de lugar.
  // Mas quem quer organizar do jeito próprio (ex: país que mais usa primeiro,
  // não o que só experimentou primeiro) arrasta a lista (ver
  // ReorderOperationsModal) — isso vira `customOrder` e passa a mandar.
  // Reordenar é só um detalhe de EXIBIÇÃO: não muda quem está travado (isso
  // continua vindo de touchedOperations, não da posição), então dá pra
  // arrastar livremente sem risco de travar/destravar nada sem querer.
  const allOperations = [...OPERATIONS, ...customOperations]
  // BUG CRÍTICO corrigido (achado ao vivo, 2026-08-27 — relatado numa
  // conta Enterprise real, com concorrente de verdade cadastrado em 2
  // países que simplesmente SUMIRAM do seletor): país "usado" de verdade
  // no servidor (planLimit.usedOperations, vem de concorrente REAL
  // cadastrado — ver touchedOperations acima) mas que ESSE navegador
  // nunca marcou como tocado (touchedHistory é só local, por navegador —
  // outro dispositivo, cache limpo, ou qualquer dessincronia) ficava
  // INVISÍVEL na lista inteira: não entrava em touchedOrdered (só olha
  // touchedHistory) e também não entrava em untouchedOperations (é
  // excluído de lá por já estar em touchedOperations). Resultado: o país
  // não aparecia em lugar NENHUM do seletor, mesmo com concorrente
  // cadastrado e funcionando por baixo — só um bug de EXIBIÇÃO, o dado
  // real nunca foi tocado, mas escondido assim ninguém conseguia nem
  // ver/trocar pra ele. touchedWithoutHistory garante que todo país
  // realmente usado sempre aparece em algum lugar da lista, nunca some.
  const touchedHistoryOrdered = touchedHistory.map((v) => allOperations.find((op) => op.value === v)).filter(Boolean)
  const touchedWithoutHistory = allOperations.filter(
    (op) => touchedOperations.has(op.value) && !touchedHistory.includes(op.value)
  )
  const touchedOrdered = [...touchedHistoryOrdered, ...touchedWithoutHistory]
  const untouchedOperations = allOperations.filter((op) => !touchedOperations.has(op.value))
  const autoOrder = [...touchedOrdered, ...untouchedOperations]
  const orderedOperations = customOrder.length
    ? [
        ...customOrder.map((v) => autoOrder.find((op) => op.value === v)).filter(Boolean),
        // País que não estava na ordem salva (ex: adicionado depois de já ter
        // arrastado) entra no fim, na ordem automática normal — nunca some.
        ...autoOrder.filter((op) => !customOrder.includes(op.value)),
      ]
    : autoOrder

  // Recebe a lista JÁ na ordem nova (arrastada) e salva só os `value`, na
  // sequência — persistido por conta (ver operationOrderKeyFor).
  function reorderOperations(newOrderValues) {
    setCustomOrder(newOrderValues)
  }

  return (
    <OperationContext.Provider
      value={{
        operation,
        setOperation,
        needsCountryPick,
        customOperations,
        addCustomOperation,
        labelOverrides,
        renameOperation,
        removeOperation,
        planLimit,
        isOperationLocked,
        atOperationCap,
        atCompetitorCap,
        touchedOperations,
        touchedHistory,
        orderedOperations,
        reorderOperations,
      }}
    >
      {children}
    </OperationContext.Provider>
  )
}

export function useOperation() {
  const ctx = useContext(OperationContext)
  if (!ctx) throw new Error('useOperation precisa estar dentro de <OperationProvider>')
  return ctx
}

export function operationLabel(value) {
  const overrides = loadLabelOverrides()
  if (overrides[value]) return overrides[value]
  return [...OPERATIONS, ...loadCustomOperations()].find((o) => o.value === value)?.label || value
}
