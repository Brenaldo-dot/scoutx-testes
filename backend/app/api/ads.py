"""Módulo 4 — anúncios encontrados nas bibliotecas públicas."""

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from app.api.deps import CurrentUser, get_current_user, resolve_target_user
from app.database import get_db
from app.models import Ad, AdPlatform, Competitor, CompetitorTracker
from app.schemas.ad import AdListOut

router = APIRouter(prefix="/api/ads", tags=["ads"])

# `days_active` é uma @property em Python (models/ad.py), calculada em cima
# de started_at/killed_at — não dá pra ordenar por ela direto, precisa
# recalcular a mesma conta em SQL. Usuário reportou "todo anúncio aparece com
# 0-1 dia ativo": não era bug de data (isso já foi corrigido antes, ver
# scrapers/meta_ads.py) — era só o sort padrão (started_at desc = mais
# recente primeiro), que sempre bota anúncio novo no topo e enterra o
# antigo/de longa duração nas últimas páginas.
_DAYS_ACTIVE_EXPR = func.extract("epoch", func.coalesce(Ad.killed_at, func.now()) - Ad.started_at) / 86400.0


@router.get("", response_model=AdListOut)
def list_ads(
    competitor_id: int | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    product_id: int | None = None,
    platform: AdPlatform | None = None,
    winning_only: bool = False,
    sort: Literal["recent", "days_active"] = "recent",
    page: int = Query(1, ge=1),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    target_user = resolve_target_user(current_user, as_user_id)
    query = (
        db.query(Ad)
        .join(Competitor, Competitor.id == Ad.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user)
        # product_image_url/product_title (AdOut) leem ad.product — sem isso
        # vira 1 query extra POR anúncio da página (até `limit`=500).
        .options(selectinload(Ad.product))
    )
    if competitor_id:
        query = query.filter(Ad.competitor_id == competitor_id)
    elif operation:
        query = query.filter(Competitor.operation == operation)
    if product_id:
        query = query.filter(Ad.product_id == product_id)
    if platform:
        query = query.filter(Ad.platform == platform)
    if winning_only:
        query = query.filter(Ad.is_winning.is_(True))

    # `total` conta ANTES do limit/offset — mesma razão de sempre (Produtos,
    # Alertas): usuário pediu pra dar pra ver TODOS os anúncios, não só os
    # que couberem no limite de uma página.
    total = query.order_by(None).count()

    if sort == "days_active":
        # nullslast: anúncio sem started_at confirmado (raríssimo, mas
        # possível) não pode ir pro TOPO só por a expressão dar NULL — Postgres
        # bota NULL primeiro em DESC por padrão, sem isso o filtro ficaria
        # com lixo nas primeiras posições em vez do que o usuário pediu.
        order = _DAYS_ACTIVE_EXPR.desc().nullslast()
    else:
        order = Ad.started_at.desc()

    items = query.order_by(order).limit(limit).offset((page - 1) * limit).all()
    return AdListOut(items=items, total=total)
