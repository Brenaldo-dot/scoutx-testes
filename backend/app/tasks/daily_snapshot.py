"""Módulo 3 — snapshot diário, roda todo dia às 6h via Celery Beat."""

import logging

from app.database import SessionLocal
from app.models import Competitor, CompetitorStatus, Product, ScaleClassification
from app.services.scoring_service import score_product
from app.services.snapshot_service import run_daily_snapshot
from app.services.volume_service import estimate_daily_volume
from app.tasks.celery_app import celery_app
from app.tasks.utils import run_async

logger = logging.getLogger(__name__)


def _snapshot_and_score(db, competitor: Competitor) -> None:
    run_async(run_daily_snapshot(db, competitor))
    estimate_daily_volume(db, competitor)
    active_products = (
        db.query(Product).filter(Product.competitor_id == competitor.id, Product.is_active.is_(True)).all()
    )
    # Classificação da LOJA sai do MAIOR score de produto do dia (mesmos
    # sinais reais de scoring_service.py — anúncio no ar, anúncio crescendo
    # etc.), não mais de "tem mais de 15 produtos no catálogo" — isso
    # classificava qualquer loja normal como "Escalando" sempre, sinal nenhum
    # de verdade por trás. Ver structure_analyzer.py pro valor inicial (no
    # cadastro, antes de existir qualquer score).
    max_score = 0
    # Mesmo corte (56+) de /api/products/hot — não é só product.scaling
    # (score 80+ estrito), ver models/competitor.py:hot_products.
    hot_count = 0
    for product in active_products:
        record = run_async(score_product(db, competitor, product))
        max_score = max(max_score, record.score)
        if record.score >= 56:
            hot_count += 1
    competitor.hot_products = hot_count

    if max_score >= 80:
        competitor.classification = ScaleClassification.SCALING
    elif max_score >= 56:
        competitor.classification = ScaleClassification.MEDIUM
    else:
        competitor.classification = ScaleClassification.TESTING
    db.commit()


@celery_app.task(name="app.tasks.daily_snapshot.run_daily_snapshot_all")
def run_daily_snapshot_all() -> dict:
    db = SessionLocal()
    results = {"ok": 0, "failed": 0}
    try:
        competitors = db.query(Competitor).filter(Competitor.status == CompetitorStatus.ACTIVE).all()
        for competitor in competitors:
            try:
                _snapshot_and_score(db, competitor)
                results["ok"] += 1
            except Exception:
                logger.exception("Falha no snapshot diário de %s", competitor.domain)
                db.rollback()
                results["failed"] += 1
        return results
    finally:
        db.close()


@celery_app.task(name="app.tasks.daily_snapshot.run_daily_snapshot_one")
def run_daily_snapshot_one(competitor_id: int) -> dict:
    db = SessionLocal()
    try:
        competitor = db.get(Competitor, competitor_id)
        if competitor is None:
            return {"status": "not_found"}
        _snapshot_and_score(db, competitor)
        return {"status": "ok"}
    finally:
        db.close()
