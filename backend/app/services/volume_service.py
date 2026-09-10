"""
Módulo 3.2 — estimativa de volume diário.

Implementa só o sinal de queda de estoque (inventory_delta). O outro método
do spec original — ID sequencial de produto — foi deixado de fora de
propósito: o `id` interno de produto do Shopify é sequencial na PLATAFORMA
INTEIRA (todas as lojas dividem o mesmo espaço de IDs), não por loja, então
ele não serve como proxy do volume de uma loja específica. Implementar
mesmo assim daria um número com aparência de precisão que não significa
nada — o que vai contra a premissa do próprio projeto ("dado errado é pior
que nenhum dado").

Também não há tentativa de acessar /orders nem qualquer pedido-teste
(order_probes do spec original): ver README para o racional.

Regra de ouro: nunca é publicado um número calculado a partir de um único
ponto de dado. Sem dois snapshots com ~24h de diferença expondo
`inventory_quantity`, o status fica AWAITING_SECOND_POINT.
"""

import logging
from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models import Competitor, DailyVolume, Product, ProductSnapshot, VolumeMethod, VolumeStatus

logger = logging.getLogger(__name__)


def estimate_daily_volume(db: Session, competitor: Competitor, today: date | None = None) -> DailyVolume:
    today = today or date.today()
    yesterday = today - timedelta(days=1)

    existing = (
        db.query(DailyVolume)
        .filter(DailyVolume.competitor_id == competitor.id, DailyVolume.date == today)
        .first()
    )
    if existing:
        return existing

    result = _estimate_from_inventory_delta(db, competitor, today, yesterday)

    if result is None:
        volume = DailyVolume(competitor_id=competitor.id, date=today, status=VolumeStatus.AWAITING_SECOND_POINT)
    else:
        estimated_orders, confidence = result
        volume = DailyVolume(
            competitor_id=competitor.id,
            date=today,
            estimated_orders=estimated_orders,
            method=VolumeMethod.INVENTORY_DELTA,
            confidence=confidence,
            status=VolumeStatus.READY,
        )

    db.add(volume)
    db.flush()

    if volume.status == VolumeStatus.READY:
        _update_rolling_average(db, competitor)

    db.commit()
    return volume


def _snapshot_on(db: Session, product_id: int, day: date) -> ProductSnapshot | None:
    return (
        db.query(ProductSnapshot)
        .filter(
            ProductSnapshot.product_id == product_id,
            ProductSnapshot.captured_at >= day,
            ProductSnapshot.captured_at < day + timedelta(days=1),
        )
        .order_by(ProductSnapshot.captured_at.desc())
        .first()
    )


def _estimate_from_inventory_delta(
    db: Session, competitor: Competitor, today: date, yesterday: date
) -> tuple[int, float] | None:
    products = db.query(Product).filter(Product.competitor_id == competitor.id).all()
    if not products:
        return None

    total_drop = 0
    products_with_data = 0

    for product in products:
        today_snap = _snapshot_on(db, product.id, today)
        yesterday_snap = _snapshot_on(db, product.id, yesterday)
        if not today_snap or not yesterday_snap:
            continue
        if today_snap.total_inventory is None or yesterday_snap.total_inventory is None:
            continue
        products_with_data += 1
        drop = yesterday_snap.total_inventory - today_snap.total_inventory
        if drop > 0:  # ignora reposições de estoque (delta negativo) na soma de "vendidos"
            total_drop += drop

    if products_with_data == 0:
        return None  # a loja não expõe inventory_quantity publicamente

    coverage = products_with_data / len(products)
    confidence = round(min(0.9, 0.4 + coverage * 0.5), 2)
    return total_drop, confidence


def _update_rolling_average(db: Session, competitor: Competitor, window_days: int = 7) -> None:
    cutoff = date.today() - timedelta(days=window_days)
    rows = (
        db.query(DailyVolume)
        .filter(
            DailyVolume.competitor_id == competitor.id,
            DailyVolume.status == VolumeStatus.READY,
            DailyVolume.date >= cutoff,
        )
        .all()
    )
    if not rows:
        return
    competitor.avg_daily_volume = round(sum(r.estimated_orders for r in rows) / len(rows), 1)
