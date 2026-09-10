"""Módulo 5 — Minerador de Anúncios: consulta avulsa por URL, sem cadastro."""

import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, get_current_user
from app.database import get_db
from app.models import AdMinerScan, AdMinerScanStatus, ProtectedStore
from app.schemas.ad_miner import AdMinerScanCreate, AdMinerScanOut
from app.services.competitor_service import normalize_domain
from app.tasks.ad_miner import run_ad_miner_scan

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ad-miner", tags=["ad-miner"])

# Revisão de segurança (achado em auditoria): cada scan sobe um Chromium via
# Playwright pra Meta, Google E TikTok (scrapers/browser.py) — bem mais
# pesado que uma busca HTTP simples. Sem limite nenhum, uma conta (não
# precisa ser admin) conseguia enfileirar scans em sequência sem parar,
# monopolizando o worker `browser_heavy` (concurrency=3, ver start_all.sh) e
# deixando todo mundo esperando. Em memória, por usuário — mesma ideia do
# limite por IP do login no Node (server.js), só que aqui é por VOLUME de
# uso, não por senha errada.
_SCAN_WINDOW_SECONDS = 60
_SCAN_LIMIT = 5
_scan_usage: dict[int, tuple[float, int]] = {}


def _check_scan_rate_limit(user_id: int) -> None:
    now = time.time()
    window_start, count = _scan_usage.get(user_id, (now, 0))
    if now - window_start > _SCAN_WINDOW_SECONDS:
        window_start, count = now, 0
    count += 1
    _scan_usage[user_id] = (window_start, count)
    if count > _SCAN_LIMIT:
        retry_after = int(window_start + _SCAN_WINDOW_SECONDS - now) + 1
        raise HTTPException(429, f"Muitos scans em pouco tempo, tenta de novo em {retry_after}s.")


@router.post("/scans", response_model=AdMinerScanOut, status_code=201)
def create_scan(
    payload: AdMinerScanCreate, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    _check_scan_rate_limit(current_user.id)
    domain = normalize_domain(payload.url)
    if not domain or "." not in domain:
        raise HTTPException(400, "URL inválida, cola o link da loja (ex: lojaexemplo.com)")
    # Mesma proteção de api/competitors.py:check_protected_store (achado ao
    # vivo, 2026-08-31) — esse scan busca a loja direto por domínio, sem
    # passar por register_competitor, então também precisa dessa checagem.
    if db.query(ProtectedStore).filter(ProtectedStore.domain == domain).first() is not None:
        raise HTTPException(400, "URL inválida, cola o link da loja (ex: lojaexemplo.com)")

    scan = AdMinerScan(
        domain=domain, operation=payload.operation, status=AdMinerScanStatus.PENDING, user_id=current_user.id
    )
    db.add(scan)
    db.commit()
    db.refresh(scan)

    try:
        run_ad_miner_scan.delay(scan.id)
    except Exception:
        # Mesma lição de api/competitors.py: fila fora do ar não pode virar
        # 500 depois que o registro já foi salvo — só marca falho, front avisa.
        logger.warning(
            "Não consegui enfileirar o scan do Minerador de Anúncios pra %s (fila/Redis indisponível?)", domain
        )
        scan.status = AdMinerScanStatus.FAILED
        scan.error = "Fila de processamento indisponível, tenta de novo em instantes."
        db.commit()
        db.refresh(scan)

    return scan


@router.get("/scans/{scan_id}", response_model=AdMinerScanOut)
def get_scan(scan_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    # Revisão de segurança: antes lia qualquer scan_id sem checar dono — ver
    # comentário em models/ad_miner.py:user_id.
    query = db.query(AdMinerScan).filter(AdMinerScan.id == scan_id)
    if not current_user.is_admin:
        query = query.filter(AdMinerScan.user_id == current_user.id)
    scan = query.first()
    if not scan:
        raise HTTPException(404, "Scan não encontrado")
    return scan
