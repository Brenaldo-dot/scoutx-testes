"""
Módulo 3.1 — snapshot diário de produtos e detecção de eventos.

price_change, new_product, product_removed, variations_added, vendor_changed
e duplicate_detected também disparam alerta (services/alert_service).
title_change, image_change, stock_change (fora de queda forte) e
urgency_detected só ficam no log de eventos / contam pro score
(services/scoring_service.py) — mudar demais o volume de notificação por
sinais muito comuns tende a fazer o usuário ignorar o canal inteiro.
Testado ao vivo: quase todo produto de loja COD usa copy de
urgência/escassez, então "apareceu urgência" sozinho não diferencia quem tá
realmente escalando de quem não tá — vira ruído, não sinal.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import (
    AlertType,
    Competitor,
    Product,
    ProductEvent,
    ProductEventType,
    ProductSnapshot,
)
from app.scrapers.duplicate_detector import cluster_duplicate_listings
from app.scrapers.shopify import fetch_all_products, normalize_product
from app.scrapers.supplier_id import filter_junk_supplier_ids
from app.scrapers.urgency_detector import detect_urgency_copy
from app.services import alert_service

logger = logging.getLogger(__name__)


def _round(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


async def run_daily_snapshot(db: Session, competitor: Competitor) -> dict:
    """
    Snapshot diário: usa só o supplier_id que já vem de graça no SKU da
    listagem em massa (sem 1 request extra por produto) — o barcode real,
    mais caro de buscar, é enriquecido no raio-x semanal
    (services/competitor_service.py:run_full_xray), que roda com bem menos
    frequência.
    """
    raw_products = await fetch_all_products(competitor.domain, delay_seconds=1.0)
    normalized = [normalize_product(p) for p in raw_products]
    filter_junk_supplier_ids(normalized)
    dup_map = cluster_duplicate_listings(normalized)

    seen_shopify_ids: set[int] = set()

    for item in normalized:
        seen_shopify_ids.add(item["shopify_product_id"])
        product = (
            db.query(Product)
            .filter(
                Product.competitor_id == competitor.id,
                Product.shopify_product_id == item["shopify_product_id"],
            )
            .first()
        )
        dup_others = dup_map.get(item["shopify_product_id"], [])
        has_urgency = detect_urgency_copy(item["body_html"])

        if product is None:
            product = await _create_product(db, competitor, item, dup_others)
            had_urgency_before = False
        else:
            previous_snapshot = _latest_snapshot(db, product.id)
            had_urgency_before = previous_snapshot.has_urgency_copy if previous_snapshot else False
            await _diff_product(db, competitor, product, item, dup_others, previous_snapshot)
            product.last_seen_at = datetime.now(timezone.utc)
            product.is_active = True

        if has_urgency and not had_urgency_before:
            # Só evento (conta pro score em scoring_service.py) — não alerta:
            # copy de urgência é comum demais em loja COD pra ser sinal
            # individual de "esse produto tá escalando", ver docstring acima.
            _record_event(db, product, ProductEventType.URGENCY_DETECTED, {})

        _save_snapshot(db, product, item, has_urgency)

    await _mark_missing_products(db, competitor, seen_shopify_ids)

    competitor.last_checked_at = datetime.now(timezone.utc)
    db.commit()
    return {"products_seen": len(normalized)}


async def _create_product(db: Session, competitor: Competitor, item: dict, dup_others: list[dict]) -> Product:
    product = Product(
        competitor_id=competitor.id,
        shopify_product_id=item["shopify_product_id"],
        title=item["title"],
        handle=item["handle"],
        vendor=item["vendor"],
        supplier_id=item["supplier_id"],
        product_type=item["product_type"],
        tags=item["tags"],
        price_min=item["price_min"],
        price_max=item["price_max"],
        variant_count=item["variant_count"],
        image_count=item["image_count"],
        total_inventory=item["total_inventory"],
        main_image_url=item["main_image_url"],
        image_urls=item["image_urls"],
        description_text=item["description_text"],
        duplicated=len(dup_others) > 0,
        duplicate_count=len(dup_others),
        duplicate_of=dup_others,
    )
    db.add(product)
    db.flush()
    _record_event(db, product, ProductEventType.NEW_PRODUCT, {"title": item["title"]})
    # Score inicial só com o que já dá pra saber NESTE instante (duplicata):
    # o resto do score (score_product, em services/scoring_service.py) exige
    # histórico que um produto recém-visto ainda não tem.
    initial_score = 20 if product.duplicated else 0
    await alert_service.create_alert(
        db,
        competitor,
        AlertType.NEW_PRODUCT,
        f"Produto novo detectado em {competitor.name} → {item['title']} (score: {initial_score})",
        product=product,
    )
    if dup_others:
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.DUPLICATE_DETECTED,
            f"Produto duplicado detectado → {item['title']} em {competitor.name}, sinal de escala",
            product=product,
        )
    return product


async def _diff_product(
    db: Session,
    competitor: Competitor,
    product: Product,
    item: dict,
    dup_others: list[dict],
    previous_snapshot: ProductSnapshot | None,
) -> None:
    if item["price_min"] is not None and _round(item["price_min"]) != _round(product.price_min):
        old_price = product.price_min
        _record_event(db, product, ProductEventType.PRICE_CHANGE, {"from": old_price, "to": item["price_min"]})
        if old_price is not None:
            await alert_service.create_alert(
                db,
                competitor,
                AlertType.PRICE_CHANGE,
                f"Preço mudou → {product.title} em {competitor.name} era {old_price}, agora {item['price_min']}",
                product=product,
                # payload estruturado — frontend usa pra colorir o valor que
                # subiu/caiu (verde/vermelho) em vez de tentar extrair os 2
                # números de dentro do texto da mensagem.
                payload={"old_price": old_price, "new_price": item["price_min"]},
            )

    if (
        item["total_inventory"] is not None
        and product.total_inventory is not None
        and item["total_inventory"] != product.total_inventory
    ):
        old_stock = product.total_inventory
        _record_event(
            db,
            product,
            ProductEventType.STOCK_CHANGE,
            {"from": old_stock, "to": item["total_inventory"]},
        )
        # Só alerta em queda forte (20%+ desde a última captura, ~24h no
        # ritmo normal de 1x/dia) — variação pequena é ruído normal de
        # estoque, não sinal de escala; ver Módulo 7 (regra de qualidade).
        if old_stock > 0 and item["total_inventory"] < old_stock:
            drop_pct = (old_stock - item["total_inventory"]) / old_stock
            if drop_pct >= 0.20:
                await alert_service.create_alert(
                    db,
                    competitor,
                    AlertType.STOCK_CHANGE,
                    f"Estoque caiu {round(drop_pct * 100)}% → {product.title} em {competitor.name} "
                    f"({old_stock} → {item['total_inventory']})",
                    product=product,
                )

    if item["variant_count"] > product.variant_count:
        _record_event(
            db,
            product,
            ProductEventType.VARIATIONS_ADDED,
            {"from": product.variant_count, "to": item["variant_count"]},
        )
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.VARIATIONS_ADDED,
            f"Variações adicionadas → {product.title} em {competitor.name} passou de "
            f"{product.variant_count} para {item['variant_count']} variações",
            product=product,
        )

    was_duplicated = product.duplicated
    if len(dup_others) > 0 and not was_duplicated:
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.DUPLICATE_DETECTED,
            f"Produto duplicado detectado → {product.title} em {competitor.name}, sinal de escala",
            product=product,
        )

    if item["title"] and item["title"] != product.title:
        _record_event(db, product, ProductEventType.TITLE_CHANGE, {"from": product.title, "to": item["title"]})

    if item["main_image_url"] and item["main_image_url"] != product.main_image_url:
        _record_event(
            db,
            product,
            ProductEventType.IMAGE_CHANGE,
            {"from": product.main_image_url, "to": item["main_image_url"]},
        )

    if item["vendor"] and product.vendor and item["vendor"] != product.vendor:
        _record_event(db, product, ProductEventType.VENDOR_CHANGED, {"from": product.vendor, "to": item["vendor"]})
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.VENDOR_CHANGED,
            f"Concorrente trocou fornecedor → {product.title} em {competitor.name} "
            f"(era {product.vendor}, agora {item['vendor']})",
            product=product,
        )

    # Cód. fornecedor (barcode/SKU) mudou — sinal mais forte que vendor_changed
    # porque é bem mais difícil de mascarar (ver models/product.py). Compara
    # SEMPRE contra o supplier_id da captura ANTERIOR (mesma extração por SKU
    # da listagem em massa, todo santo dia — services/snapshot_service.py
    # roda isso, nunca o barcode do raio-x), nunca contra `product.supplier_id`
    # direto: esse campo pode estar guardando um barcode mais forte, confirmado
    # pelo raio-x semanal (scrapers/supplier_id.py:enrich_with_real_barcodes) —
    # comparar contra ele acusaria "mudança" só por diferença de fonte/qualidade
    # entre as duas capturas, não uma troca de fornecedor de verdade.
    previous_supplier_id = previous_snapshot.raw.get("supplier_id") if previous_snapshot and previous_snapshot.raw else None
    if item["supplier_id"] and previous_supplier_id and item["supplier_id"] != previous_supplier_id:
        _record_event(
            db,
            product,
            ProductEventType.SUPPLIER_ID_CHANGED,
            {"from": previous_supplier_id, "to": item["supplier_id"]},
        )
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.SUPPLIER_ID_CHANGED,
            f"Cód. fornecedor mudou → {product.title} em {competitor.name}: "
            f"{previous_supplier_id} alterou para {item['supplier_id']}",
            product=product,
        )
        # Aqui SIM pode sobrescrever: os dois lados da comparação já são a
        # mesma fonte (SKU do snapshot diário) — não existe risco de apagar
        # um barcode mais forte do raio-x com um mais fraco, como no guard
        # "só preenche se vazio" logo abaixo (esse continua intacto).
        product.supplier_id = item["supplier_id"]

    product.title = item["title"]
    product.vendor = item["vendor"]
    product.product_type = item["product_type"]
    product.tags = item["tags"]
    product.price_min = item["price_min"]
    product.price_max = item["price_max"]
    product.variant_count = item["variant_count"]
    product.image_count = item["image_count"]
    product.total_inventory = item["total_inventory"]
    product.main_image_url = item["main_image_url"]
    product.image_urls = item["image_urls"]
    product.description_text = item["description_text"]
    # Só preenche se ainda não tinha nada — o snapshot diário só tem o SKU
    # (mais fraco) da listagem em massa, e sobrescrever incondicionalmente
    # apagaria um barcode real que o raio-x semanal já tenha confirmado, já
    # que aqui não tem como saber qual dos dois é melhor.
    if item["supplier_id"] and not product.supplier_id:
        product.supplier_id = item["supplier_id"]
    product.duplicated = len(dup_others) > 0
    product.duplicate_count = len(dup_others)
    product.duplicate_of = dup_others


# Regra de qualidade: nunca marcar "morto" com base num único sumiço — espera
# confirmar em pelo menos 2 rodadas consecutivas antes de declarar removido.
# Sem coluna nova pra isso: como `last_seen_at` só é tocado quando o produto
# É visto, um produto ausente há só 1 rodada ainda tem `last_seen_at` de
# ~1 ciclo atrás (~24h no ritmo diário normal); só na 2ª rodada consecutiva
# ausente é que a idade passa a folga de MIN_HOURS abaixo.
MIN_HOURS_MISSING_TO_CONFIRM_REMOVED = 30


async def _mark_missing_products(db: Session, competitor: Competitor, seen_shopify_ids: set[int]) -> None:
    active_products = (
        db.query(Product).filter(Product.competitor_id == competitor.id, Product.is_active.is_(True)).all()
    )
    now = datetime.now(timezone.utc)
    for product in active_products:
        if product.shopify_product_id in seen_shopify_ids:
            continue
        last_seen = product.last_seen_at
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        hours_missing = (now - last_seen).total_seconds() / 3600
        if hours_missing < MIN_HOURS_MISSING_TO_CONFIRM_REMOVED:
            continue  # sumiu só nesta rodada — ainda não confirmado, espera a próxima

        first_seen = product.first_seen_at
        if first_seen.tzinfo is None:
            first_seen = first_seen.replace(tzinfo=timezone.utc)
        dias_no_ar = (now - first_seen).days

        product.is_active = False
        _record_event(db, product, ProductEventType.PRODUCT_REMOVED, {})
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.PRODUCT_REMOVED,
            f"Produto sumiu de {competitor.name} → {product.title} estava no ar há {dias_no_ar} dias",
            product=product,
        )


def _latest_snapshot(db: Session, product_id: int) -> ProductSnapshot | None:
    return (
        db.query(ProductSnapshot)
        .filter(ProductSnapshot.product_id == product_id)
        .order_by(ProductSnapshot.captured_at.desc())
        .first()
    )


def _record_event(db: Session, product: Product, event_type: ProductEventType, details: dict) -> None:
    db.add(ProductEvent(product_id=product.id, event_type=event_type, details=details))


def _save_snapshot(db: Session, product: Product, item: dict, has_urgency: bool) -> None:
    db.add(
        ProductSnapshot(
            product_id=product.id,
            title=item["title"],
            vendor=item["vendor"],
            price_min=item["price_min"],
            price_max=item["price_max"],
            variant_count=item["variant_count"],
            image_count=item["image_count"],
            total_inventory=item["total_inventory"],
            main_image_url=item["main_image_url"],
            has_urgency_copy=has_urgency,
            raw={k: v for k, v in item.items() if k != "body_html"},
        )
    )
