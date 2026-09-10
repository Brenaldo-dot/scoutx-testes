"""Disparada logo após POST /api/competitors.

Verifica se o domínio é Shopify de verdade e, se for, roda o raio-x inicial
(Módulo 1 + 2) + o primeiro scan de anúncios. Tudo em background — o
concorrente já é criado com status CHECKING e devolvido na hora
(services/competitor_service.py:register_competitor); antes disso o
`await verify_is_shopify` rodava DENTRO da request HTTP e podia travar o
formulário por até ~85s sob rate limit da Shopify (scrapers/shopify.py),
impedindo cadastrar a próxima loja enquanto isso não terminava — usuário
pediu explicitamente pra poder emendar um cadastro no outro.
"""

import logging
from datetime import datetime, timedelta, timezone

import redis

from app.config import get_settings
from app.database import SessionLocal
from app.models import AlertType, Competitor, CompetitorStatus, ProtectedStore
from app.scrapers.shopify import verify_is_shopify
from app.services import alert_service
from app.services.competitor_service import run_full_xray
from app.tasks.ads_monitor import run_ads_monitor_one
from app.tasks.celery_app import celery_app
from app.tasks.utils import run_async

logger = logging.getLogger(__name__)

_redis_client = redis.from_url(get_settings().redis_url, decode_responses=True)

# Achado ao vivo (2026-09-07): verify_is_shopify só rodava 1x, no cadastro —
# loja Shopify nova nasce com a tela de senha ativa por padrão, então
# cadastrar bem nesse momento marcava NOT_SHOPIFY pra sempre, mesmo depois do
# dono tirar a senha minutos/horas depois (2 casos reais: trend-mx-4 e
# mx.pideenunclick.com). A única saída era excluir e recadastrar do zero,
# perdendo o histórico já coletado. Intervalos crescentes (10min, 1h, 6h) dão
# tempo real pra loja ficar pública sem martelar o domínio nem exigir ação do
# usuário — tudo silencioso, sem alerta nem botão na tela.
AUTO_RECHECK_DELAYS_SECONDS = [600, 3600, 6 * 3600]


@celery_app.task(name="app.tasks.onboarding.run_onboarding_xray", bind=True, max_retries=2)
def run_onboarding_xray(self, competitor_id: int) -> dict:
    db = SessionLocal()
    try:
        competitor = db.get(Competitor, competitor_id)
        if competitor is None:
            return {"status": "not_found"}
        if competitor.status != CompetitorStatus.CHECKING:
            # Já foi verificado antes (retry tardio, ou task duplicada) —
            # não reprocessa do zero.
            return {"status": "skipped", "reason": competitor.status.value}

        is_shopify = run_async(verify_is_shopify(competitor.domain))
        if not is_shopify:
            competitor.status = CompetitorStatus.NOT_SHOPIFY
            db.commit()
            run_async(
                alert_service.create_alert(
                    db,
                    competitor,
                    AlertType.NOT_SHOPIFY,
                    f"{competitor.domain} não parece ser uma loja Shopify (/products.json não respondeu "
                    "como esperado). Nenhum monitoramento foi agendado.",
                )
            )
            db.commit()
            auto_recheck_shopify.apply_async(args=[competitor_id, 0], countdown=AUTO_RECHECK_DELAYS_SECONDS[0])
            return {"status": "not_shopify", "competitor_id": competitor_id}

        competitor.status = CompetitorStatus.ACTIVE
        db.commit()

        run_async(run_full_xray(db, competitor))

        try:
            run_ads_monitor_one.delay(competitor.id)
        except Exception:
            logger.warning(
                "Não consegui enfileirar o scan inicial de anúncios de %s (fila/Redis indisponível?)",
                competitor.domain,
            )

        return {"status": "ok", "competitor_id": competitor_id}
    except Exception as exc:
        logger.exception("Falha no raio-x inicial do concorrente %s", competitor_id)
        db.rollback()
        # Achado ao vivo (2026-09-06, app lento pra todo mundo): quando as
        # tentativas se esgotam (max_retries=2), o status ficava "checking"
        # pra sempre — nada aqui marcava um estado final. reconcile_stuck_
        # onboarding (roda a cada 3min) pegava esse MESMO concorrente de
        # novo e disparava outra tentativa do zero, sem parar nunca — 12
        # lojas ficaram presas nesse loop por mais de 1h seguida, cada
        # tentativa fazendo scraping de verdade (rede/SSL), competindo por
        # CPU/conexão com pedido de gente de verdade. Na última tentativa,
        # marca como NOT_SHOPIFY (mesmo selo de "não deu pra confirmar") em
        # vez de retentar de novo — tira do loop, admin pode reativar
        # manualmente se quiser tentar de novo depois.
        if self.request.retries >= self.max_retries:
            db2 = SessionLocal()
            try:
                competitor = db2.get(Competitor, competitor_id)
                if competitor and competitor.status == CompetitorStatus.CHECKING:
                    competitor.status = CompetitorStatus.NOT_SHOPIFY
                    db2.commit()
                    run_async(
                        alert_service.create_alert(
                            db2,
                            competitor,
                            AlertType.NOT_SHOPIFY,
                            f"Não deu pra verificar {competitor.domain} depois de {self.max_retries + 1} "
                            f"tentativas (erro: {exc}). Nenhum monitoramento foi agendado — se a loja "
                            "realmente for Shopify, tente cadastrar de novo mais tarde.",
                        )
                    )
                    db2.commit()
            finally:
                db2.close()
            return {"status": "failed_permanently", "competitor_id": competitor_id, "error": str(exc)}
        raise self.retry(exc=exc, countdown=60)
    finally:
        db.close()


@celery_app.task(name="app.tasks.onboarding.auto_recheck_shopify")
def auto_recheck_shopify(competitor_id: int, attempt: int = 0) -> dict:
    """Reverificação automática e silenciosa pra loja marcada NOT_SHOPIFY —
    ver comentário em AUTO_RECHECK_DELAYS_SECONDS. Fica FORA do fluxo de
    CHECKING/reconcile_stuck_onboarding de propósito: se usasse status
    CHECKING igual ao cadastro normal, a rede de segurança que reprocessa
    tudo travado há >3min ia reenfileirar essa MESMA loja a cada 3 minutos
    durante as horas de espera entre tentativas — voltando pro loop infinito
    que já corrigimos uma vez (ver run_onboarding_xray). Por isso o status
    continua NOT_SHOPIFY o tempo todo; só troca pra ACTIVE se a reverificação
    realmente confirmar Shopify dessa vez."""
    db = SessionLocal()
    try:
        competitor = db.get(Competitor, competitor_id)
        if competitor is None or competitor.status != CompetitorStatus.NOT_SHOPIFY:
            return {"status": "skipped"}
        if db.query(ProtectedStore).filter(ProtectedStore.domain == competitor.domain).first():
            return {"status": "skipped", "reason": "protected"}

        is_shopify = run_async(verify_is_shopify(competitor.domain))
        if is_shopify:
            competitor.status = CompetitorStatus.ACTIVE
            db.commit()
            run_async(run_full_xray(db, competitor))
            try:
                run_ads_monitor_one.delay(competitor.id)
            except Exception:
                logger.warning(
                    "Não consegui enfileirar o scan inicial de anúncios de %s (fila/Redis indisponível?)",
                    competitor.domain,
                )
            return {"status": "recovered", "competitor_id": competitor_id}

        if attempt < len(AUTO_RECHECK_DELAYS_SECONDS) - 1:
            next_attempt = attempt + 1
            auto_recheck_shopify.apply_async(
                args=[competitor_id, next_attempt], countdown=AUTO_RECHECK_DELAYS_SECONDS[next_attempt]
            )
        return {"status": "still_not_shopify", "competitor_id": competitor_id}
    finally:
        db.close()


@celery_app.task(name="app.tasks.onboarding.reconcile_stuck_onboarding")
def reconcile_stuck_onboarding() -> dict:
    """Roda a cada poucos minutos (Celery Beat) — rede de segurança pro
    cadastro assíncrono (api/competitors.py:_enqueue). O .delay() que
    dispara run_onboarding_xray roda numa thread solta pra não travar a
    resposta HTTP (ver comentário em _enqueue); visto ao vivo: se o
    container reiniciar (outro deploy, crash) ANTES dessa thread terminar
    de publicar no Redis, o enfileiramento se perde de vez e o concorrente
    fica em 'checking' pra sempre, sem nada reprocessando — 23 lojas do
    México ficaram presas assim no mesmo dia em que essa rede de segurança
    foi escrita. re-enfileirar é seguro mesmo se a task original só estava
    demorando (run_onboarding_xray confere `status != CHECKING` e sai sem
    fazer nada de novo)."""
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=3)
        stuck = (
            db.query(Competitor)
            .filter(Competitor.status == CompetitorStatus.CHECKING, Competitor.created_at < cutoff)
            .all()
        )
        for competitor in stuck:
            logger.warning("Reprocessando cadastro travado: %s (id=%s)", competitor.domain, competitor.id)
            run_onboarding_xray.delay(competitor.id)
        _maybe_run_daily_retention()
        return {"requeued": len(stuck)}
    finally:
        db.close()


def _maybe_run_daily_retention() -> None:
    """Achado ao vivo (2026-08-29 até hoje, nunca explicado): o job
    `purge-old-history-daily-3am` do Celery Beat (app/tasks/celery_app.py)
    está registrado certinho no worker (confirmado via `/celery-diagnostics`
    em 2026-09-03) e o Beat manda "Sending due task" toda madrugada — mas o
    worker nunca de fato executa, sem erro nenhum, sem log nenhum, mesmo com
    reforços (acks_late, log logo na entrada). Em vez de continuar caçando a
    causa, pendura a limpeza numa task que JÁ SABEMOS que roda de forma
    confiável (essa aqui, a cada 3 minutos) — usa uma trava no Redis (SET NX
    com 20h de validade) pra rodar no máximo 1x por dia, contornando o
    agendamento problemático de vez."""
    from app.tasks.retention import run_purge

    lock_key = "daily-retention-purge-lock"
    acquired = _redis_client.set(lock_key, "1", nx=True, ex=20 * 3600)
    if not acquired:
        return
    try:
        run_purge()
    except Exception:
        logger.exception("Falha ao rodar a limpeza diária de histórico via reconcile_stuck_onboarding.")
