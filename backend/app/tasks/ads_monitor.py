"""Módulo 4 — busca anúncios nas bibliotecas públicas para cada concorrente ativo."""

import logging

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import AdPlatform, Competitor, CompetitorStatus
from app.scrapers import google_ads, meta_ads, tiktok_ads
from app.services.ads_service import ingest_search_results
from app.services.competitor_service import country_for_operation
from app.tasks.celery_app import celery_app
from app.tasks.utils import run_async

logger = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.ads_monitor.run_ads_monitor_all")
def run_ads_monitor_all() -> dict:
    db = SessionLocal()
    results = {"ok": 0, "failed": 0}
    try:
        competitors = db.query(Competitor).filter(Competitor.status == CompetitorStatus.ACTIVE).all()
        for competitor in competitors:
            try:
                run_async(_monitor_competitor_ads(db, competitor))
                results["ok"] += 1
            except Exception:
                logger.exception("Falha ao monitorar anúncios de %s", competitor.domain)
                db.rollback()
                results["failed"] += 1
        return results
    finally:
        db.close()


@celery_app.task(name="app.tasks.ads_monitor.run_ads_monitor_one", bind=True, max_retries=2)
def run_ads_monitor_one(self, competitor_id: int) -> dict:
    # Disparada logo após POST /api/competitors (ver api/competitors.py), do
    # mesmo jeito que run_onboarding_xray já faz pro raio-x de catálogo — sem
    # isso, um concorrente cadastrado hoje só teria o primeiro scan de
    # anúncios amanhã de manhã (cron diário abaixo em celery_app.py), o que
    # aparecia pro usuário como "Nenhum anúncio encontrado ainda" mesmo em
    # loja com anúncio ativo (confirmado ao vivo pra velmoratienda.shop).
    db = SessionLocal()
    try:
        competitor = db.get(Competitor, competitor_id)
        if competitor is None:
            return {"status": "not_found"}
        if competitor.status != CompetitorStatus.ACTIVE:
            return {"status": "skipped", "reason": competitor.status.value}
        run_async(_monitor_competitor_ads(db, competitor))
        return {"status": "ok", "competitor_id": competitor_id}
    except Exception as exc:
        logger.exception("Falha no scan inicial de anúncios do concorrente %s", competitor_id)
        db.rollback()
        raise self.retry(exc=exc, countdown=60)
    finally:
        db.close()


async def _monitor_competitor_ads(db: Session, competitor: Competitor) -> None:
    # Busca pelo DOMÍNIO, não pelo nome cadastrado: testado ao vivo, o
    # domínio acha os anúncios mesmo quando o nome da página anunciante no
    # Facebook é diferente do nome da loja (ex: loja "Velmora" anunciando
    # como página "Havan Tienda") — ver scrapers/meta_ads.py. verify_domain
    # descarta anunciante que a busca solta da Meta trouxe sem relação
    # nenhuma com a loja (confirmado ao vivo — ver docstring do filtro) E
    # habilita a extração do handle do produto (URL de destino real de cada
    # anúncio) — é assim que ingest_search_results sabe a qual produto cada
    # anúncio pertence, sem precisar de uma busca separada por produto (essa
    # abordagem foi testada ao vivo e descartada: buscar pelo TÍTULO do
    # produto na Ads Library sempre retornava 0 resultados, porque o texto
    # do anúncio é copy de venda, não repete o título da página).
    country = country_for_operation(competitor.operation)

    meta_result = await meta_ads.search_ads(competitor.domain, country=country, verify_domain=competitor.domain)
    await ingest_search_results(db, competitor, AdPlatform.META, meta_result.ads)

    tiktok_result = await tiktok_ads.search_ads(competitor.domain, region=country)
    await ingest_search_results(db, competitor, AdPlatform.TIKTOK, tiktok_result.ads)

    # Só por domínio, nunca por nome do produto/loja — testado ao vivo, a
    # busca "por nome do anunciante" da ferramenta do Google não bate com o
    # nome da loja (o anunciante real costuma ser uma agência/CNPJ terceiro,
    # ex: confirmado ao vivo pra Velmora), só a busca por domínio funciona.
    google_result = await google_ads.search_ads(competitor.domain, region=country)
    await ingest_search_results(db, competitor, AdPlatform.GOOGLE, google_result.ads)
