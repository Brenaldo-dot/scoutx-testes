# Handoff — ScoutX (leia isto primeiro)

Atualizado em: 2026-08-24, pelo Claude que trabalhou neste projeto até aqui.
Motivo deste arquivo: o Samuel (dono do projeto) ficará sem crédito da Claude
até quarta-feira e pode continuar com outra sessão/instância nesse meio
tempo. Este documento existe pra essa próxima sessão se situar rápido, sem
precisar re-descobrir tudo do zero.

## O que é o ScoutX

Plataforma de inteligência competitiva pra lojistas de dropshipping COD
(cash-on-delivery) na Colômbia, México, Equador e Guatemala. Monitora lojas
concorrentes Shopify: catálogo, anúncios (Meta/Google/TikTok), alertas de
mudança de preço/fornecedor/produto novo, "raio-x" da loja, etc.

## Arquitetura — 3 partes, 2 serviços Railway

1. **`web/`** — Node/Express. Login, sessão, admin de usuários/organizações/
   planos, e um proxy (`/api/minerador/*`) que repassa pro FastAPI com
   headers de identidade confiáveis (`X-User-Id`, `X-Org-Plan`, etc.,
   protegidos por `X-Internal-Secret`). Serve o build do React também
   (`public-minerador/`, gerado por `npm run build` do frontend, NÃO
   versionado — ver `.gitignore`). Deploy Railway: serviço **vigilant-curiosity**.
2. **`backend/`** — FastAPI (Python). Toda a lógica de concorrentes,
   produtos, anúncios, alertas, score. Nunca fala direto com o banco do Node
   — só confia nos headers que o proxy manda (ver `app/api/deps.py`). Deploy
   Railway: serviço **mega-minerador** (roda uvicorn + 2 workers Celery +
   beat, tudo no mesmo container, ver `backend/start_all.sh`).
3. **`frontend/`** — React (Vite). App inteiro (ScoutX + Buscar
   Fornecedor + Espionar Loja) servido pelo Node na raiz do domínio.

Multi-tenant: `Competitor` é uma linha ÚNICA por domínio, compartilhada por
quem rastreia (tabela `CompetitorTracker` faz a ligação usuário↔concorrente).
Planos (Standard/Pro/Enterprise) vivem em `web/db.js` (`PLAN_LIMITS`) — a
chave interna nunca muda (`solo`/`pro`/`agencia`), só o `label` mudou num
rebrand recente.

## Onde isso roda (Railway)

- Workspace: "Brenaldo's Projects"
- Project ID: `9179bca6-c921-4547-a82f-5b6983eee154`
- Serviços: `vigilant-curiosity` (Node, domínio público **app.scoutx.com.br**
  + um subdomínio `*.up.railway.app` auto-gerado), `mega-minerador` (FastAPI,
  **sem domínio público de propósito** — só acessível via rede interna
  Railway pelo Node), `PgBouncer`, `Postgres`, `Postgres-icuX` (parece
  órfão/legado, nunca confirmado se pode remover), `Redis`.
- `railway whoami` / login: a sessão Claude anterior sempre passou
  `RAILWAY_TOKEN=<token>` explícito em CADA comando (`npx @railway/cli ...`),
  não havia login persistente configurado. **O Samuel tem esse token** — ele
  precisa passar pra você diretamente no chat (não está e não deve estar
  neste arquivo, é segredo).

## Como fazer deploy (o fluxo usado o tempo todo)

Repita pra cada serviço que você mexeu:

```bash
# 1. Se mexeu no frontend, builda e copia pro Node servir:
cd frontend && npm run build
cd .. && rm -rf web/public-minerador && cp -r frontend/dist web/public-minerador

# 2. Deploy do Node:
cd web && RAILWAY_TOKEN="<pedir pro Samuel>" npx @railway/cli up --service vigilant-curiosity --detach

# 3. Deploy do FastAPI (só se mexeu em backend/):
cd ../backend && RAILWAY_TOKEN="<pedir pro Samuel>" npx @railway/cli up --service mega-minerador --detach

# 4. Confirmar start limpo (esperar ~30-90s antes de checar):
RAILWAY_TOKEN="<...>" npx @railway/cli logs --service vigilant-curiosity --latest --since 10m
# procurar "ScoutX (web) rodando" sem traceback/erro depois

RAILWAY_TOKEN="<...>" npx @railway/cli logs --service mega-minerador --latest --since 15m
# procurar "Application startup complete" sem traceback/erro depois
```

**ARMADILHA CRÍTICA (causou uma queda real em produção em 2026-08-25):** o
`railway up` respeita o `.gitignore` do repositório quando roda dentro de
uma pasta que é (ou está dentro de) um clone git — e `web/public-minerador/`
está no `.gitignore` (é gerado, não versionado). Ou seja, mesmo fazendo o
build do frontend e copiando certinho pra lá ANTES de rodar `railway up`,
o deploy sobe **sem** essa pasta, silenciosamente, sem erro nenhum no
comando. O app inteiro quebra (`GET /` cai no fallback `res.status(503)`
"ScoutX ainda não está disponível neste ambiente") e não tem nada nos logs
de build/deploy que avise disso. Sempre use `--no-gitignore` no `railway up`
do serviço `vigilant-curiosity` quando estiver rodando de dentro de um
clone git (não precisa dessa flag pra `mega-minerador`, que não tem pasta
gerada nenhuma). Exemplo do fluxo completo, com a flag:

```bash
cd frontend && npm run build
cd .. && rm -rf web/public-minerador && cp -r frontend/dist web/public-minerador
cd web && RAILWAY_TOKEN="<pedir pro Samuel>" npx @railway/cli up --service vigilant-curiosity --no-gitignore --detach
```

**OUTRA ARMADILHA (derrubou o `mega-minerador` em 2026-08-25, mesma sessão):**
`git config core.autocrlf` está `true` nesse ambiente Windows — todo
checkout converte `\n` pra `\r\n` sozinho nos arquivos de texto, inclusive
`backend/start_all.sh` e `backend/run_local.sh`. O conteúdo no GIT sempre
esteve certo (LF), o problema é só o arquivo NO DISCO depois do checkout —
e `railway up` sobe o disco, não o git. Resultado: o container sobe e o
`start_all.sh` falha com erros tipo `set: -: invalid option` e
`$'\r': command not found`, o serviço nunca fica saudável. Já existe um
`.gitattributes` na raiz do repo forçando `*.sh text eol=lf` — isso deveria
bastar num clone novo, mas se algum dia esse erro voltar a aparecer nos logs
do `mega-minerador` depois de um deploy, confira com `file backend/*.sh`
(tem que dizer só "UTF-8 text executable", sem "with CRLF line
terminators") antes de gastar tempo procurando o bug no código Python.

**TERCEIRA ARMADILHA (derrubou o app INTEIRO pra todo mundo, 2026-08-27):**
uma trava de banco (`pg_advisory_lock`, adicionada numa auditoria de
segurança pra impedir corrida no limite de concorrentes do plano) bloqueia
INDEFINIDAMENTE se quem pegou a trava nunca soltar. Como o FastAPI roda
handler síncrono numa threadpool de tamanho fixo, poucas requisições presas
nessa trava pra sempre já bastam pra esgotar TODAS as threads disponíveis —
travando até pedido que nem passa perto dessa trava (foi assim que um bug
de trava-por-organização virou "o app inteiro não carrega nada pra
ninguém"). Sintoma: Node reportando `erro no proxy do minerador` com
`HeadersTimeoutError`/`UND_ERR_HEADERS_TIMEOUT` repetido, CPU do
`mega-minerador` em ~0% (parado esperando, não sobrecarregado — se tivesse
CPU alta seria outro problema, tipo o job serial de snapshot descrito na
seção de escala abaixo). Corrigido (ver `web/api/competitors.py`
`_org_limit_lock`, trocado por `pg_try_advisory_lock` com teto de espera de
8s) — mas se QUALQUER trava de banco nova for adicionada no futuro, sempre
com teto de espera, nunca bloqueio puro. Remediação imediata pra esse tipo
de sintoma: `railway redeploy --service mega-minerador --yes` (reinicia o
container, Postgres solta trava de sessão sozinho quando a conexão cai).

Importante: **não existe interpretador Python neste ambiente de dev** — toda
mudança no `backend/` (Python) é verificada só por revisão de código
cuidadosa + deploy real + log limpo, nunca rodada localmente. O Node
(JavaScript) dá pra checar com `node --check arquivo.js` antes de subir.

Nunca digite senha nenhuma (nem de teste) em nenhum formulário do próprio
app — restrição permanente deste projeto. Verificação de tela autenticada é
sempre por revisão de código, não por login ao vivo.

## Git

Este repositório (`github.com/Brenaldo-dot/APP_SCOUTX`, branch `main`) é o
espelho do código-fonte. **O deploy real NÃO passa por aqui** — é sempre
`railway up` direto do diretório local pro Railway (fluxo acima). Ou seja:
depois de deployar, lembre de sincronizar as mudanças de volta pra cá e dar
commit/push, senão o repo fica defasado (isso já aconteceu antes: o repo
ficou ~2 dias sem sync até alguém pedir explicitamente "sobe pro GitHub").

Se você estiver numa sessão nova sem os arquivos locais (`web/`, `backend/`,
`frontend/` fora deste repo clonado), **clone este repo** — ele é a fonte
mais atual disponível (assumindo que o commit que acompanha este HANDOFF.md
foi enviado com sucesso; se não, pergunte ao Samuel se ele conseguiu rodar o
`git push` manualmente).

## Automação Cakto (25/08, implementada e testada com compra real)

Webhook em `web/cakto.js` (rota `POST /api/webhooks/cakto`, registrada em
`server.js`), autenticado pelo campo `secret` no corpo do payload (não é
HMAC/header — é assim mesmo que a Cakto funciona, confirmado na doc oficial
`docs.cakto.com.br/conceitos/webhooks.md`), comparado com
`CAKTO_WEBHOOK_SECRET` (variável de ambiente no Railway, pedir pro Samuel —
nunca gravar em arquivo nenhum).

- **`purchase_approved`**: mapeia `data.offer.id` → plano/ciclo via
  `CAKTO_OFFER_PLAN_MAP` (9 links, 3 planos × 3 ciclos — se um link novo for
  criado na Cakto, precisa adicionar a chave aqui manualmente, ver comentário
  no arquivo). Cria organização + usuário com o email da compra, mas **sem
  senha entregável** — o usuário nasce com `needs_password_setup = true` e
  uma senha placeholder aleatória que ninguém nunca vê.
- **`refund` / `chargeback` / `subscription_canceled`**: suspende a
  organização (`expires_at` pro passado).
- **`subscription_renewed`**: estende a validade.
- Resto dos eventos (boleto/pix gerado, etc.): só loga, não faz nada.

**Entrega de acesso — `GET`/`POST /registrar`** (troca de rota feita
25/08, depois de uma tentativa anterior com `/bem-vindo?ref={refId}` FALHAR
num teste de compra real — o `{refId}` que a Cakto substitui no redirect
não bateu com o `data.refId` do webhook, a pessoa ficou presa numa tela de
"estamos finalizando" pra sempre). O fluxo atual não depende de correlacionar
nada: a Cakto redireciona pra uma URL **fixa**
(`https://app.scoutx.com.br/registrar`, configurada na oferta, aba
Upsell/Downsell → campo de página de obrigado — **confirme que está exatamente
essa URL, com `app.` e o caminho `/registrar`**, um teste anterior tinha só
`https://scoutx.com.br/` errado e a Cakto reportava "200 OK" mesmo assim,
porque bateu numa página qualquer nossa, não no webhook). Na página, a
pessoa digita o mesmo email da compra + escolhe a própria senha — só
funciona se existir conta com esse email e `needs_password_setup = true`.

**Pendente / não confirmado ainda**:
- Os 3 eventos de cancelamento (`refund`/`chargeback`/`subscription_canceled`)
  nunca foram testados contra um disparo real da Cakto, só existem porque a
  doc oficial confirma esses nomes — dispare um teste de cada um no painel
  antes de confiar 100%.
- `subscription_renewal_refused` (pagamento de renovação recusado) não tem
  tratamento nenhum ainda — decidir com o Samuel se deve suspender ou só
  avisar.
- Contas criadas ANTES dessa mudança de 25/08 (via o mecanismo antigo do
  refId) ficaram com uma senha aleatória que foi gerada mas nunca entregue
  (`needs_password_setup` fica `false` nelas, então `/registrar` não
  funciona) — precisam de reset manual de senha pela aba Usuários (🔑) se
  alguém reclamar de não conseguir entrar.

## Contexto de segurança já resolvido (não precisa re-investigar do zero)

Uma auditoria de segurança completa já rodou nesta sessão (24/08) e os
achados foram corrigidos: rate limiting adicionado nas rotas que fazem o
servidor buscar URL externa (`/api/buscar`, `/api/spy`, `/api/spy-preview`,
scans do Minerador de Anúncios), um vazamento de feature paga (alerta no
Discord continuava funcionando depois de rebaixar de Pro pra Standard, agora
é limpo automaticamente na hora do downgrade), escaping defensivo extra em
duas páginas de erro de prévia, e confirmado que `INTERNAL_API_SECRET` está
configurado (e igual) nos dois serviços em produção — não é um segredo vazio
por acidente. SSRF, IDOR, vazamento cross-tenant e rate-limit de login já
tinham sido corrigidos em auditorias anteriores (ver histórico de commits).

## Convenção de texto do app (pedido explícito do usuário)

Textos visíveis pro usuário (títulos, subtítulos, mensagens de erro,
tooltips) **não usam "—" (travessão) como separador dentro da frase** — o
Samuel pediu explicitamente pra tirar esse estilo. Use vírgula, dois-pontos,
ou quebre em duas frases. O "—" continua OK como marcador de "sem valor"
numa célula/estatística (ex: `{value ?? '—'}`) e é normal em comentários de
código (não é texto de usuário).
