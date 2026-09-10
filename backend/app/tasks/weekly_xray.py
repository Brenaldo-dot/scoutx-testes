"""Módulo 2 — raio-x completo, roda toda semana (segunda 7h) via Celery Beat."""

import logging

from app.database import SessionLocal
from app.models import Competitor, CompetitorStatus
from app.services.competitor_service import run_full_xray
from app.tasks.celery_app import celery_app
from app.tasks.utils import run_async

logger = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.weekly_xray.run_weekly_xray_all")
def run_weekly_xray_all() -> dict:
    db = SessionLocal()
    results = {"ok": 0, "failed": 0}
    try:
        competitors = db.query(Competitor).filter(Competitor.status == CompetitorStatus.ACTIVE).all()
        for competitor in competitors:
            try:
                run_async(run_full_xray(db, competitor))
                results["ok"] += 1
            except Exception:
                logger.exception("Falha no raio-x semanal de %s", competitor.domain)
                db.rollback()
                results["failed"] += 1
        return results
    finally:
        db.close()
