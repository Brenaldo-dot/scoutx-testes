"""Módulo 1 e Módulo 2 — cadastro do concorrente e raio-x completo da loja."""

import logging
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Competitor,
    CompetitorStatus,
    CompetitorTracker,
    Product,
    ProtectedStore,
    StoreStructureSnapshot,
    TechStack,
)
from app.scrapers.duplicate_detector import cluster_duplicate_listings
from app.scrapers.shopify import fetch_all_products, fetch_homepage_html, normalize_product
from app.scrapers.structure_analyzer import analyze_structure
from app.scrapers.supplier_id import enrich_with_real_barcodes, filter_junk_supplier_ids
from app.scrapers.tech_detector import detect_tech_stack
from app.services import ecosystem_service

logger = logging.getLogger(__name__)


def normalize_domain(raw_domain: str) -> str:
    domain = raw_domain.strip().lower()
    domain = domain.removeprefix("https://").removeprefix("http://")
    domain = domain.split("/")[0].split("?")[0]
    # "www.lojaexemplo.com" e "lojaexemplo.com" são a mesma loja — sem isso
    # a deduplicação por domínio (linha abaixo, em register_competitor)
    # deixava cadastrar a mesma loja duas vezes só por causa do "www.".
    return domain.removeprefix("www.")


# País da biblioteca de anúncios pra cada operação (Módulo 1.2) — Meta/Google/
# TikTok pedem um código de país ISO por busca (ver scrapers/meta_ads.py,
# scrapers/google_ads.py, scrapers/tiktok_ads.py, todos com default "CO").
# Sem isso, um concorrente cadastrado na operação México tinha os anúncios
# dele buscados na biblioteca da COLÔMBIA — 0 resultado sempre, não porque a
# loja não anuncia, mas porque a busca inteira rodava no país errado.
_OPERATION_COUNTRY = {
    "colombia": "CO",
    "mexico": "MX",
    "equador": "EC",
    "guatemala": "GT",
    "espanha": "ES",
}


def country_for_operation(operation: str) -> str:
    return _OPERATION_COUNTRY.get(operation, "CO")


async def register_competitor(
    db: Session,
    domain: str,
    name: str | None,
    niche: str | None,
    tags: list[str] | None,
    user_id: int,
    operation: str = "colombia",
) -> tuple[Competitor, bool, bool]:
    """Devolve (competitor, is_new_competitor, is_new_tracker).

    `is_new_competitor` diz pra quem chama (api/competitors.py) se precisa
    disparar o raio-x em background — só quando o DOMÍNIO em si é inédito no
    sistema. Se outro usuário já rastreia esse domínio, reaproveita a MESMA
    linha (produtos/anúncios/histórico já raspados) e só cria uma linha nova
    em CompetitorTracker pra esse usuário — sem raspar de novo, sem duplicar
    trabalho de background. `is_new_tracker` é False só no reenvio idempotente
    do MESMO usuário cadastrando de novo um domínio que ele mesmo já tinha."""
    domain = normalize_domain(domain)
    # Loja protegida (pedido do admin, 2026-08-29, ver models/competitor.py:
    # ProtectedStore) — nunca chega a ser raspada nem uma vez: pula direto
    # pro status NOT_SHOPIFY (mesmo selo "Não é Shopify" que já existe pra
    # loja que de fato não é Shopify) em vez de CHECKING, então
    # run_onboarding_xray nunca tenta verificar/raspar de verdade.
    is_protected = db.query(ProtectedStore).filter(ProtectedStore.domain == domain).first() is not None

    competitor = db.query(Competitor).filter(Competitor.domain == domain).first()
    is_new_competitor = competitor is None
    if competitor is None:
        # Cria com status CHECKING e devolve JÁ — a verificação real (é
        # Shopify mesmo?) e o raio-x completo rodam em background
        # (tasks/onboarding.py:run_onboarding_xray). Antes disso era tudo
        # síncrono aqui dentro (`await verify_is_shopify`) e travava a
        # resposta HTTP por até ~85s num rate limit da Shopify — usuário
        # pediu explicitamente pra poder cadastrar a próxima loja sem esperar.
        competitor = Competitor(
            domain=domain,
            name=name or domain,
            niche=niche,
            tags=tags or [],
            operation=operation,
            status=CompetitorStatus.NOT_SHOPIFY if is_protected else CompetitorStatus.CHECKING,
        )
        db.add(competitor)
        try:
            db.commit()
            db.refresh(competitor)
        except IntegrityError:
            # Achado em auditoria de segurança (2026-08-26): domain é
            # unique — duas pessoas clicando "cadastrar" quase ao mesmo
            # tempo pro MESMO domínio inédito (ninguém rastreava ainda)
            # corriam pra criar a mesma linha, a segunda esbarrava nessa
            # constraint sem try/except nenhum e virava um 500 cru pro
            # cliente. Não é bug de dado (a constraint fez o trabalho
            # dela) — só falta tratar como "ok, já existe, reaproveita",
            # que é exatamente o comportamento normal pra domínio repetido.
            db.rollback()
            competitor = db.query(Competitor).filter(Competitor.domain == domain).first()
            if competitor is None:
                # Nunca deveria acontecer (a IntegrityError só dispara
                # porque a OUTRA transação já commitou essa linha antes da
                # nossa falhar) — mantido só como rede de segurança.
                raise
            is_new_competitor = False

    existing_tracker = (
        db.query(CompetitorTracker)
        .filter(CompetitorTracker.competitor_id == competitor.id, CompetitorTracker.user_id == user_id)
        .first()
    )
    is_new_tracker = existing_tracker is None
    if existing_tracker is None:
        db.add(CompetitorTracker(competitor_id=competitor.id, user_id=user_id))
        db.commit()

    return competitor, is_new_competitor, is_new_tracker


async def run_full_xray(db: Session, competitor: Competitor) -> StoreStructureSnapshot:
    """Módulo 2 completo — roda no cadastro e depois semanalmente."""
    raw_products = await fetch_all_products(competitor.domain)
    normalized = [normalize_product(p) for p in raw_products]

    # Só o raio-x (não o snapshot diário) paga o custo de 1 request extra por
    # produto pra confirmar o barcode real — ver scrapers/supplier_id.py.
    try:
        await enrich_with_real_barcodes(competitor.domain, normalized)
    except Exception:
        logger.exception("Falha ao enriquecer supplier_id de %s; seguindo só com o SKU da listagem em massa", competitor.domain)
    filter_junk_supplier_ids(normalized)

    dup_map = cluster_duplicate_listings(normalized)

    _upsert_products(db, competitor, normalized, dup_map)

    structure = analyze_structure(normalized)
    snapshot = StoreStructureSnapshot(competitor_id=competitor.id, **structure)
    db.add(snapshot)

    competitor.total_products = structure["total_products"]
    competitor.vendor_count = structure["vendor_count"]
    competitor.price_min = structure["price_min"]
    competitor.price_max = structure["price_max"]
    competitor.price_avg = structure["price_avg"]
    competitor.classification = structure["classification"]

    try:
        homepage_html = await fetch_homepage_html(competitor.domain)
        await _sync_tech_stack(db, competitor, homepage_html)
    except Exception:
        logger.exception("Falha ao coletar stack tecnológica de %s", competitor.domain)

    ecosystem_service.sync_ecosystem_map(db, competitor)

    competitor.last_checked_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def _upsert_products(db: Session, competitor: Competitor, normalized: list[dict], dup_map: dict[int, list[dict]]) -> None:
    for item in normalized:
        product = (
            db.query(Product)
            .filter(
                Product.competitor_id == competitor.id,
                Product.shopify_product_id == item["shopify_product_id"],
            )
            .first()
        )
        dup_others = dup_map.get(item["shopify_product_id"], [])
        if product is None:
            db.add(
                Product(
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
            )
        else:
            product.title = item["title"]
            # NÃO sobrescreve incondicional (era um bug real: apagava o
            # vendor antigo sem passar pelo diff/alerta de VENDOR_CHANGED em
            # services/snapshot_service.py:_diff_product, que É quem detecta
            # troca de fornecedor de verdade — isso silenciosamente resetava
            # a baseline toda semana no raio-x, antes do snapshot diário
            # seguinte conseguir comparar contra o valor antigo). Só
            # preenche se ainda tava vazio, mesmo padrão do supplier_id logo
            # abaixo.
            if item["vendor"] and not product.vendor:
                product.vendor = item["vendor"]
            if item["supplier_id"]:
                product.supplier_id = item["supplier_id"]
            product.image_urls = item["image_urls"]
            product.description_text = item["description_text"]
            product.duplicated = len(dup_others) > 0
            product.duplicate_count = len(dup_others)
            product.duplicate_of = dup_others
            product.is_active = True
    db.flush()


async def _sync_tech_stack(db: Session, competitor: Competitor, html: str) -> None:
    findings = detect_tech_stack(html)
    now = datetime.now(timezone.utc)
    found_names = set()

    for finding in findings:
        found_names.add(finding["name"])
        record = (
            db.query(TechStack)
            .filter(TechStack.competitor_id == competitor.id, TechStack.name == finding["name"])
            .first()
        )
        if record:
            record.last_detected_at = now
            record.active = True
            if finding["external_id"]:
                record.external_id = finding["external_id"]
        else:
            db.add(
                TechStack(
                    competitor_id=competitor.id,
                    name=finding["name"],
                    external_id=finding["external_id"],
                    active=True,
                )
            )

    stale = db.query(TechStack).filter(TechStack.competitor_id == competitor.id, TechStack.active.is_(True)).all()
    for record in stale:
        if record.name not in found_names:
            record.active = False
