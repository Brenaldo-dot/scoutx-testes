"""Ponto de entrada da API."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sqlalchemy import text

from app import models  # noqa: F401  garante que todo modelo é registrado no Base.metadata
from app.api import ad_miner, ads, alerts, competitors, dashboard, ecosystem, products, settings as settings_api
from app.config import get_settings
from app.database import Base, engine

logging.basicConfig(level=logging.INFO)
settings = get_settings()


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Achado ao vivo (2026-08-27, derrubou o app INTEIRO pra todo mundo):
    # esse bloco inteiro de ALTER TABLE roda de novo em TODO restart/deploy
    # — idempotente (IF NOT EXISTS / DROP+ADD), mas cada ALTER ainda
    # precisa de uma trava exclusiva na tabela por um instante. Se alguma
    # outra transação (Celery com uma tabela dessas aberta, por exemplo)
    # estivesse seguran do essa trava no momento exato do restart, o
    # ALTER ficava esperando a trava liberar SEM NENHUM TETO — e como isso
    # roda dentro do lifespan de startup, o processo nunca chegava a abrir
    # a porta 8000 pra escutar: uvicorn preso pra sempre em "Waiting for
    # application startup", nunca loga "Application startup complete",
    # e o proxy do Node só via ECONNREFUSED (nada escutando ali) até
    # alguém perceber e reiniciar manualmente. lock_timeout bounded: se
    # não conseguir a trava em 5s, falha rápido e loga, em vez de travar
    # pra sempre — melhor um restart automático do Railway (crashloop
    # detectável) do que um processo morto-vivo que parece "online" mas
    # nunca escuta porta nenhuma.
    try:
        with engine.begin() as conn:
            conn.execute(text("SET lock_timeout = '5s'"))
            _run_startup_migrations(conn)
    except Exception:
        logger.exception(
            "Falha ao rodar as migracoes de startup (provavel disputa de trava com outra transacao) — "
            "seguindo com a API mesmo assim, já que o schema quase certamente já está em dia de deploys anteriores."
        )

    yield


def _run_startup_migrations(conn):
    # Conveniência para dev/scaffold: cria tabelas que ainda não existem.
    # Para evolução de schema em produção, use `alembic upgrade head` (ver README).
    Base.metadata.create_all(bind=engine)

    # create_all não altera coluna de tabela já existente. Corrige aqui uma
    # vez: shopify_product_id era INTEGER (visto ao vivo estourando com IDs
    # reais de 17 dígitos do Shopify — 0 de 233 produtos gravados na primeira
    # tentativa contra uma loja real). Idempotente, não falha se já for BIGINT.
    if True:  # noqa: mantém a indentação original do bloco (era um "with", ver lifespan acima) sem precisar reindentar tudo à mão
        conn.execute(text("ALTER TABLE products ALTER COLUMN shopify_product_id TYPE BIGINT"))
        # Coluna nova (Módulo 1.2 — separação por operação/país) numa tabela
        # que já existia com dado real: create_all não adiciona coluna em
        # tabela existente. IF NOT EXISTS + DEFAULT faz o Postgres já
        # preencher 'colombia' em toda linha antiga, então nada que já
        # estava cadastrado muda de operação sozinho.
        conn.execute(
            text("ALTER TABLE competitors ADD COLUMN IF NOT EXISTS operation VARCHAR(50) NOT NULL DEFAULT 'colombia'")
        )
        # Canal de alerta trocado de Telegram pra Discord — coluna nova pra
        # não perder o rastro de "esse alerta específico já saiu ou não"
        # (sent_to_telegram fica intacto no dado antigo, só não é mais escrito).
        conn.execute(text("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS sent_to_discord BOOLEAN NOT NULL DEFAULT false"))

        # ecosystem_map referencia products/competitors sem ON DELETE CASCADE
        # desde sempre — visto ao vivo: excluir um concorrente com produto
        # com `vendor` preenchido (a maioria) quebrava com
        # "ForeignKeyViolation: ecosystem_map_product_id_fkey" e devolvia 500
        # pro usuário no meio do clique de excluir. DROP+ADD é idempotente
        # (constraint recriada do zero toda subida, sem custo real numa
        # tabela desse tamanho).
        conn.execute(text("ALTER TABLE ecosystem_map DROP CONSTRAINT IF EXISTS ecosystem_map_product_id_fkey"))
        conn.execute(
            text(
                "ALTER TABLE ecosystem_map ADD CONSTRAINT ecosystem_map_product_id_fkey "
                "FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE"
            )
        )
        conn.execute(text("ALTER TABLE ecosystem_map DROP CONSTRAINT IF EXISTS ecosystem_map_competitor_id_fkey"))
        conn.execute(
            text(
                "ALTER TABLE ecosystem_map ADD CONSTRAINT ecosystem_map_competitor_id_fkey "
                "FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE"
            )
        )

        # Minerador de Anúncios (scan avulso) rodava sempre biblioteca "CO",
        # mesmo pra loja mexicana — ver country_for_operation em
        # services/competitor_service.py.
        conn.execute(
            text("ALTER TABLE ad_miner_scans ADD COLUMN IF NOT EXISTS operation VARCHAR(50) NOT NULL DEFAULT 'colombia'")
        )

        # Revisão de segurança: scan avulso do Minerador de Anúncios não
        # tinha dono nenhum — qualquer usuário logado lia o resultado de
        # scan de OUTRA organização só incrementando o id (ver
        # api/ad_miner.py:get_scan). Nullable porque scans já existentes não
        # têm como saber quem criou; esses ficam visíveis só pra admin dali
        # em diante (ver a própria checagem no endpoint).
        conn.execute(text("ALTER TABLE ad_miner_scans ADD COLUMN IF NOT EXISTS user_id INTEGER"))

        # Multi-tenant, v2 — v1 (owner_id direto em competitors, coluna já
        # removida abaixo) dava cada usuário sua PRÓPRIA cópia do dado raspado;
        # veio feedback ao vivo: melhor um dado só por domínio (mais leve,
        # menos raspagem duplicada) com uma tabela à parte dizendo QUEM
        # rastreia CADA concorrente — dois usuários cadastrando a MESMA loja
        # passam a compartilhar produtos/anúncios/histórico, sem duplicar
        # trabalho de scraping, mas nunca um "herda" o cadastro do outro sem
        # ter cadastrado ele mesmo (competitor_trackers, criada via create_all
        # acima por ser tabela nova).
        #
        # Backfill: quem já tinha reivindicado via owner_id (POST
        # /api/competitors/claim-unowned, usado uma vez em produção) vira uma
        # linha de tracker antes da coluna sumir — sem isso a reivindicação
        # que a pessoa já tinha feito se perderia.
        has_owner_id = conn.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'competitors' AND column_name = 'owner_id'"
            )
        ).first()
        if has_owner_id:
            conn.execute(
                text(
                    "INSERT INTO competitor_trackers (competitor_id, user_id, created_at) "
                    "SELECT id, owner_id, now() FROM competitors WHERE owner_id IS NOT NULL "
                    "ON CONFLICT (competitor_id, user_id) DO NOTHING"
                )
            )
            conn.execute(text("ALTER TABLE competitors DROP COLUMN owner_id"))

        # Domínio volta a ser único GLOBAL (era por dono na v1) — nome que a
        # v1 deu à constraint composta, e o nome padrão que unique=True de
        # coluna ganha no Postgres, cobrindo quem nunca chegou a rodar a v1.
        conn.execute(text("ALTER TABLE competitors DROP CONSTRAINT IF EXISTS uq_competitors_domain_owner"))
        conn.execute(text("ALTER TABLE competitors DROP CONSTRAINT IF EXISTS competitors_domain_key"))
        conn.execute(text("ALTER TABLE competitors ADD CONSTRAINT competitors_domain_key UNIQUE (domain)"))

        # Contagem de produtos QUENTES por loja (pedido explícito: mostrar
        # isso no card de cada concorrente). Rodada 1 usava scaling_products
        # a partir de products.scaling (score 80+ estrito) e o número ficava
        # quase sempre 0/1 mesmo com a aba Produtos Quentes cheia — o sinal
        # que fecha os 80 pontos sozinho (anúncios crescendo) é raro, a
        # maioria dos produtos quentes chega no 56-79 (ver
        # models/competitor.py:hot_products). Renomeada pra hot_products e
        # recalculada a partir do MESMO critério que /api/products/hot usa:
        # último ProductScore de cada produto ativo, score >= 56.
        conn.execute(text("ALTER TABLE competitors ADD COLUMN IF NOT EXISTS hot_products INTEGER NOT NULL DEFAULT 0"))
        conn.execute(
            text(
                "UPDATE competitors c SET hot_products = COALESCE(("
                "SELECT COUNT(*) FROM ("
                "SELECT DISTINCT ON (ps.product_id) ps.product_id, ps.score "
                "FROM product_scores ps "
                "JOIN products p ON p.id = ps.product_id "
                "WHERE p.competitor_id = c.id AND p.is_active = true "
                "ORDER BY ps.product_id, ps.date DESC"
                ") latest WHERE latest.score >= 56"
                "), 0)"
            )
        )
        conn.execute(text("ALTER TABLE competitors DROP COLUMN IF EXISTS scaling_products"))

        # Revisão: anúncio da Meta sendo marcado "morto" só por não aparecer
        # numa única rodada de scan (busca por keyword + scroll, não é 100%
        # determinística) — contribuía pro undercount de "anúncios ativos"
        # relatado pelo usuário. Ver services/ads_service.py:_mark_killed_ads.
        conn.execute(text("ALTER TABLE ads ADD COLUMN IF NOT EXISTS missed_scans INTEGER NOT NULL DEFAULT 0"))

        # Link de anúncio da Meta gravado sem `country=` — quem abrisse via
        # é geo-inferido pela localização de QUEM CLICA, não pelo país da
        # loja (bug relatado: produto do México abrindo a Ads Library com
        # "Brasil" selecionado e "nenhum anúncio encontrado"). Backfill dos
        # links já salvos usando o país de cada concorrente; idempotente
        # (NOT LIKE '%country=%' já não bate depois da 1ª rodada).
        conn.execute(
            text(
                """
                UPDATE ads a
                SET library_url = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country='
                    || CASE c.operation
                        WHEN 'mexico' THEN 'MX'
                        WHEN 'equador' THEN 'EC'
                        WHEN 'guatemala' THEN 'GT'
                        ELSE 'CO'
                    END
                    || '&id=' || a.external_ad_id
                FROM competitors c
                WHERE c.id = a.competitor_id
                  AND UPPER(a.platform) = 'META'
                  AND a.library_url IS NOT NULL
                  AND a.library_url NOT LIKE '%country=%'
                """
            )
        )

        # Achado ao vivo (2026-09-08): a limpeza noturna de histórico
        # (tasks/retention.py) calculava "a linha mais recente de cada
        # produto" varrendo product_snapshots inteira sem um índice que
        # cobrisse (product_id, captured_at) junto — só existiam índices
        # separados em cada coluna. Isso obrigava um sort pesado em memória
        # toda madrugada; o pico de memória do Postgres vinha subindo noite
        # após noite (3,6GB → 7,0GB → quase 7,8GB de um teto de 8GB) até
        # bater perto do limite. CONCURRENTLY não dá pra usar dentro de uma
        # transação (create_all já abriu uma) — tabela pequena o suficiente
        # pra um create normal não travar nada perceptível na subida.
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_product_snapshots_product_captured "
                "ON product_snapshots (product_id, captured_at)"
            )
        )


app = FastAPI(title="ScoutX", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(competitors.router)
app.include_router(products.router)
app.include_router(ads.router)
app.include_router(alerts.router)
app.include_router(dashboard.router)
app.include_router(ecosystem.router)
app.include_router(ad_miner.router)
app.include_router(settings_api.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
