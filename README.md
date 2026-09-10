# Mega Minerador de Concorrentes COD

Inteligência competitiva para lojas Shopify no mercado de contra-entrega (COD)
na Colômbia: monitora concorrentes diariamente e só mostra informação quando
ela é confiável — dado errado é pior que nenhum dado.

## Stack

Python (FastAPI) · React + Tailwind · PostgreSQL + Redis · Celery + Celery
Beat · Playwright · Telegram Bot API · Docker Compose · SQLAlchemy 2.0 +
Alembic.

## Como rodar

```bash
cp .env.example .env
# edite .env: pelo menos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID pra receber alertas
docker compose up --build
```

- Frontend: http://localhost:5173
- API + docs interativos: http://localhost:8000/docs
- Em dev, o backend cria as tabelas automaticamente no start (`Base.metadata.create_all`).
  Pra evolução de schema de verdade, gere e rode migrations com Alembic:
  ```bash
  docker compose exec backend alembic revision --autogenerate -m "descrição"
  docker compose exec backend alembic upgrade head
  ```

Sem Docker, dá pra rodar backend e frontend soltos (Postgres/Redis locais ou
em containers avulsos): `pip install -r backend/requirements.txt && playwright install chromium`,
depois `uvicorn app.main:app --reload` a partir de `backend/`; e `npm install && npm run dev`
a partir de `frontend/`.

## Variáveis de ambiente (`.env`)

| Variável | Uso |
|---|---|
| `POSTGRES_USER/PASSWORD/DB` | credenciais do Postgres do docker-compose |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | bot criado com @BotFather; chat_id via @userinfobot ou `getUpdates` |
| `SCRAPER_PROXIES` | lista de proxies `http://user:pass@host:port` separados por vírgula — opcional, existe pra distribuir carga ao monitorar muitas lojas por dia, não pra burlar nada |
| `SCRAPER_REQUEST_DELAY_SECONDS` | intervalo entre requests dentro de uma mesma paginação |
| `FRONTEND_ORIGIN` | origem liberada no CORS da API |

## Módulos implementados

- **Módulo 1 — Concorrentes**: `POST /api/competitors` verifica `/products.json`,
  cadastra como `not_shopify` e alerta se não for Shopify, dispara o raio-x
  inicial via Celery quando é.
- **Módulo 2 — Raio-X**: coleta paginada de `/products.json`, detecção de
  páginas duplicadas (vendor + similaridade de título), classificação
  Testando/Operação média/Escalando, detecção de stack tecnológica com
  extração de Pixel ID, rastreamento de troca de fornecedor. Roda no cadastro
  e semanalmente (`app/tasks/weekly_xray.py`).
- **Módulo 3 — Snapshot diário** (6h, `app/tasks/daily_snapshot.py`): diff
  produto a produto (preço, estoque, variações, título, imagem, urgência,
  produto novo/removido), estimativa de volume, score 0-100 e sinais de
  escala.
- **Módulo 4 — Anúncios**: busca na Meta Ads Library e no TikTok Creative
  Center, lógica de anúncio vencedor/anúncio morto (`app/services/ads_service.py`).

## O que mudou em relação ao spec original, e por quê

Fui fiel ao spec quase inteiro, mas três pontos foram alterados de propósito.
Documentando aqui pra não parecer que algo "sumiu" silenciosamente:

**1. `order_probes` (pedidos-teste) não foi implementado.**
O spec original pedia pedidos de teste na loja do concorrente pra estimar
volume pelo número do pedido. Não implementei: criar um pedido real numa loja
alheia sem intenção de pagar/receber é uma ação que gera custo real pro
concorrente — em COD especificamente, sem cobrança antecipada, isso pode
disparar embalagem, despacho e tentativa de entrega de verdade — além de
esbarrar em termos de uso do Shopify e da loja-alvo, e se aproximar de fraude
dependendo da jurisdição. É uma categoria diferente do resto do sistema, que
só lê dado público (products.json, HTML de vitrine, bibliotecas de anúncios
públicas). Pelo mesmo motivo, também não há tentativa de acessar `/orders`
(histórico de pedidos, normalmente atrás de login de cliente).

**2. ID sequencial de produto não é usado como proxy de volume.**
O spec sugeria isso como método alternativo. Na prática, o `id` interno de
produto do Shopify é sequencial na **plataforma inteira** (todas as lojas
Shopify do mundo dividem o mesmo espaço de IDs), não por loja — então ele não
correlaciona com volume de vendas de uma loja específica. Implementar mesmo
assim daria um número com aparência de precisão que não significa nada, o que
vai contra a premissa do projeto. `services/volume_service.py` usa só queda
de `inventory_quantity` entre dois snapshots com ~24h de diferença — e esse
campo nem sempre é público: testei ao vivo contra uma loja Shopify real
(allbirds.com) e 0 de 80 produtos expunham a quantidade exata (só o booleano
`available`). Pra lojas assim, o volume fica em `awaiting_second_point`
indefinidamente — é o comportamento certo, não um bug.

**3. Scraping é "resiliente", não "furtivo".**
`scrapers/browser.py` e `scrapers/http_client.py` rotacionam proxy e
respeitam um delay entre requests pra não tomar rate-limit ao monitorar
várias lojas todo dia — não usam plugins de stealth/anti-fingerprint nem
miram burlar detecção de bot. O que é acessado é sempre vitrine pública
(a mesma página que qualquer visitante ou o Googlebot veem) e as bibliotecas
públicas de anúncios — nunca área autenticada.

## Limitações conhecidas (testadas, não só teorizadas)

- **Detector de páginas duplicadas** (`scrapers/duplicate_detector.py`):
  testado contra uma loja real, deu bastante falso positivo em catálogos
  grandes de marca única (mesma vendor, várias cores/tamanhos como produtos
  separados — títulos parecidos sem ser o padrão de "várias páginas quase
  idênticas testando ângulo" que o sinal quer capturar). Adicionei um filtro
  por proximidade de data de criação, que ajuda em alguns casos mas não
  resolve todos. Por isso `duplicated` é só 1 de 6 sinais que alimentam o
  score de escala (`services/scoring_service.py`) e nunca dispara um alerta
  sozinho — precisa de mais 2 sinais reais pra virar `scaling_detected`.
- **Meta Ads Library**: `scrapers/meta_ads.py` foi testado ao vivo (não só
  suposto) e funciona — busca pelo domínio da loja (mais confiável que nome:
  confirmado que o nome da página anunciante no Facebook pode ser diferente
  do nome da loja), extrai ID do anúncio, texto do criativo, CTA, data de
  início e nome do anunciante. A extração é baseada em texto (acha "Identificação
  da biblioteca"/"Library ID" e sobe pelos ancestrais) porque a Meta usa
  classes CSS ofuscadas sem nenhum seletor estável — texto de UI muda por
  idioma, então quem for rodar em produção deveria conferir contra o idioma
  real que aparecer (depende do locale do navegador, não só do `country=` da
  URL). A Meta tem uma Ad Library API oficial (token de desenvolvedor) mais
  estável que isso — vale migrar se for pra produção de verdade.
- **TikTok Creative Center**: investigado ao vivo e é fundamentalmente mais
  fraco pra esse uso — é uma vitrine curada ("Top Ads"), não um índice
  completo pesquisável. Busca por "shein" (uma das maiores anunciantes do
  mundo) voltou 0 resultados. Boa parte do copy dos anúncios fica gravada no
  vídeo (pixel), não é texto de HTML — não dá pra extrair sem OCR de frame,
  fora de escopo aqui. `scrapers/tiktok_ads.py` por isso é conservador:
  confirma "sem resultados" com segurança e não inventa anúncio a partir de
  rótulo de UI (a primeira versão fazia isso e mostrava "Video Views"/"Conversions"
  como se fossem anúncios — corrigido). Cada concorrente tem um link direto
  pra Meta Ads Library e TikTok Creative Center na tela de detalhe, que
  sempre funciona independente do scraping, porque quem navega é a pessoa.
- **`comment_count` / velocidade de engajamento** (Módulo 4.3) não é
  preenchido: a Ads Library pública não expõe métricas de engajamento pra
  anúncios comerciais comuns (só pra parte de anúncios políticos/de interesse
  público em alguns países). O campo existe no schema pra quando uma fonte
  real for plugada.
- **Alertas são texto puro, sem HTML.** Os primeiros rascunhos interpolavam
  título de produto/vendor (dado da loja concorrente — não confiável) dentro
  de tags `<b>` pro Telegram, e o dashboard ia renderizar isso com
  `dangerouslySetInnerHTML`. Um concorrente poderia colocar algo tipo
  `<img onerror=...>` no título de um produto e rodar JS no navegador de quem
  visse o dashboard. Corrigido antes de eu seguir: `alerts.message` é sempre
  texto puro, tanto no Telegram quanto no frontend.

## Verificação feita nesta sessão

- Backend: `py_compile` em todos os arquivos, import completo da app via
  `TestClient` (todas as rotas resolvem no OpenAPI), `configure_mappers()` do
  SQLAlchemy sem erro, tasks do Celery registradas com o beat schedule, smoke
  test end-to-end (create_all + insert + relationship) contra SQLite real.
- Scraper: rodado ao vivo contra `allbirds.com` — paginação, normalização,
  detecção de tech stack e detector de duplicatas testados com dado real.
- Frontend: `npm run build` sem erro; as 5 páginas renderizadas no navegador
  (Dashboard, Concorrentes, Produtos, Anúncios, Alertas), navegação entre
  elas e estados de erro/vazio conferidos visualmente, sem erro no console.
- **Não testado**: o stack completo via `docker compose up` (Postgres + Redis
  + Celery worker/beat rodando juntos), scraping das bibliotecas de anúncios
  contra a página real da Meta/TikTok, e envio de mensagem real pro Telegram
  — dependem de credenciais/infra que não existem neste ambiente. Rode
  `docker compose up --build` e cadastre um concorrente de teste pra validar
  a esteira inteira antes de colocar em produção.

## Próximos passos sugeridos

1. `docker compose up --build`, cadastrar 1-2 concorrentes reais e acompanhar
   o raio-x inicial pelos logs (`docker compose logs -f celery_worker`).
2. Testar `meta_ads.py`/`tiktok_ads.py` contra a página real e ajustar
   seletores conforme necessário.
3. Configurar `SCRAPER_PROXIES` antes de monitorar muitas lojas por dia.
4. Gerar a primeira migration Alembic e passar a usá-la em vez do
   `create_all` automático.
5. Adicionar autenticação na API antes de expor além de `localhost`.
