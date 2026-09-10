"""Módulo 5 — dispara o scan avulso do Minerador de Anúncios em background.

Mesma razão de sempre pra não fazer isso síncrono na request HTTP: Playwright
em 3 plataformas pode passar de 30s no total, tempo demais pra segurar uma
resposta atrás de proxy (Node → FastAPI) sem estourar timeout — ver o mesmo
padrão em tasks/onboarding.py."""

import logging
from datetime import datetime, timezone

from app.database import SessionLocal
from app.models import AdMinerScan, AdMinerScanStatus
from app.services.ad_miner_service import scan_store_domain
from app.tasks.celery_app import celery_app
from app.tasks.utils import run_async

logger = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.ad_miner.run_ad_miner_scan", bind=True, max_retries=0)
def run_ad_miner_scan(self, scan_id: int) -> dict:
    db = SessionLocal()
    try:
        scan = db.get(AdMinerScan, scan_id)
        if scan is None:
            return {"status": "not_found"}

        scan.status = AdMinerScanStatus.RUNNING
        db.commit()

        try:
            result = run_async(scan_store_domain(scan.domain, scan.operation))
            scan.result = result
            scan.status = AdMinerScanStatus.DONE
        except Exception:
            logger.exception("Falha no scan do Minerador de Anúncios pra %s", scan.domain)
            scan.status = AdMinerScanStatus.FAILED
            scan.error = "Não deu pra escanear agora, tenta de novo em instantes."

        scan.finished_at = datetime.now(timezone.utc)
        db.commit()
        return {"status": scan.status.value, "scan_id": scan_id}
    finally:
        db.close()
