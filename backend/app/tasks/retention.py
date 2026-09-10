"""Limpeza diária de histórico que ninguém mais lê (achado ao vivo, 2026-08-29:
disco do Postgres em ~50% de um teto de 5GB do plano Hobby, com só 10 dias de
app no ar — bem mais rápido do que o normal, sem essa limpeza o disco batia no
teto em poucas semanas e o banco pararia de aceitar gravação nova, derrubando
o app inteiro).

`product_scores` e `product_snapshots` guardam 1 linha por produto, POR DIA,
pra sempre — mas revisando todo o código que lê essas tabelas, NENHUM lugar
usa mais que os últimos 7 dias (ver dashboard.py:get_highlights) ou a linha
mais recente (score/snapshot "atual" de cada produto, usado em todo o resto
do app). Tudo além disso é peso morto: nunca aparece em tela nenhuma.

Mantém sempre a linha mais recente de cada produto (mesmo que mais velha que
o corte) — importante pra produto "dormente" (não escaneado há um tempo) não
ficar sem nenhum score/snapshot, o que quebraria as contagens de "produtos
quentes" e a comparação de mudança na próxima raspagem."""

import logging

from sqlalchemy import text

from app.database import SessionLocal
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

# 12 dias: folga em cima da janela de 7 dias que dashboard.py:get_highlights
# realmente usa, sem guardar histórico que nunca é lido. Era 14, baixado pra
# 12 a pedido do usuário (2026-08-31) pra liberar espaço um pouco mais cedo
# assim que a limpeza automática voltar a funcionar de verdade.
RETENTION_DAYS = 12

# Achado ao vivo (2026-09-08): a versão anterior comparava `id NOT IN
# (SELECT DISTINCT ON (product_id) id FROM product_scores ORDER BY
# product_id, date DESC)` — esse DISTINCT ON reordena a tabela INTEIRA (não
# só as linhas velhas) toda madrugada, e o resultado inteiro precisa ficar
# em memória pra o NOT IN comparar linha a linha. O pico de memória do
# Postgres vinha subindo noite após noite (3,6GB → 7,0GB → quase 7,8GB de um
# teto de 8GB) até quase estourar — bate exatamente com o horário dessa
# limpeza. Reescrita pra um JOIN contra `MAX(date) GROUP BY product_id`:
# mesmo resultado (mantém a linha mais recente de cada produto), mas usa o
# índice único (product_id, date) — já existe via UniqueConstraint em
# models/score.py — pra um agregado leve em vez de reordenar tudo.
_PURGE_PRODUCT_SCORES = text(
    """
    DELETE FROM product_scores ps
    USING (
        SELECT product_id, MAX(date) AS latest_date
        FROM product_scores
        GROUP BY product_id
    ) latest
    WHERE ps.product_id = latest.product_id
    AND ps.date < (CURRENT_DATE - make_interval(days => :retention_days))
    AND ps.date <> latest.latest_date
    """
)

# Mesma reescrita, com o índice composto novo (product_id, captured_at) —
# ver main.py:_run_startup_migrations e models/product.py:ProductSnapshot.
_PURGE_PRODUCT_SNAPSHOTS = text(
    """
    DELETE FROM product_snapshots ps
    USING (
        SELECT product_id, MAX(captured_at) AS latest_captured_at
        FROM product_snapshots
        GROUP BY product_id
    ) latest
    WHERE ps.product_id = latest.product_id
    AND ps.captured_at < (now() - make_interval(days => :retention_days))
    AND ps.captured_at <> latest.latest_captured_at
    """
)


def run_purge() -> dict:
    """Lógica pura, sem depender do Celery — usada tanto pela task agendada
    quanto pelo botão "Rodar limpeza agora" do admin (api/competitors.py),
    criado depois que a execução automática de madrugada não deixou rastro
    nenhum de ter rodado de verdade (nem sucesso nem erro nos logs, só o
    Beat mandando a task pra fila) — ter um jeito de disparar na hora,
    síncrono, tira a dúvida sem esperar até a próxima madrugada.

    Achado numa revisão em 2026-08-31 (ainda sem confirmar se é A causa do
    sumiço, mas era um bug real de qualquer jeito): `SessionLocal()` estava
    FORA do try/except — se abrir a conexão falhasse bem nesse instante, a
    exceção nunca passava pelo `except` logo abaixo, sumia sem log nenhum.
    Log logo na entrada também: se o worker travar/morrer em qualquer ponto
    daqui pra frente, pelo menos fica registrado que a task foi RECEBIDA."""
    logger.info("Limpeza de histórico: iniciando (corte de %d dias).", RETENTION_DAYS)
    try:
        db = SessionLocal()
        try:
            scores_deleted = db.execute(_PURGE_PRODUCT_SCORES, {"retention_days": RETENTION_DAYS}).rowcount
            snapshots_deleted = db.execute(_PURGE_PRODUCT_SNAPSHOTS, {"retention_days": RETENTION_DAYS}).rowcount
            db.commit()
            logger.info(
                "Limpeza de histórico: %d product_scores e %d product_snapshots removidos (mais de %d dias).",
                scores_deleted,
                snapshots_deleted,
                RETENTION_DAYS,
            )
            return {"scores_deleted": scores_deleted, "snapshots_deleted": snapshots_deleted}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
    except Exception:
        logger.exception("Falha na limpeza diária de histórico.")
        raise


@celery_app.task(name="app.tasks.retention.purge_old_history", acks_late=True, max_retries=2, default_retry_delay=60)
def purge_old_history() -> dict:
    return run_purge()
