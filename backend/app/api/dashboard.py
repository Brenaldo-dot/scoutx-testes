"""Resumo pro Dashboard do frontend."""

from collections import defaultdict
from datetime import date as date_, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from app.api.alerts import ALERT_CATEGORY_TYPES
from app.api.deps import CurrentUser, get_current_user, resolve_target_user
from app.database import get_db
from app.models import (
    Ad,
    AdStatus,
    Alert,
    AlertType,
    Competitor,
    CompetitorStatus,
    CompetitorTracker,
    Product,
    ProductEvent,
    ProductEventType,
    ProductScore,
)
from app.schemas.dashboard import (
    DashboardHighlights,
    DashboardSummary,
    TrendingProductOut,
    VendorChangeMiniOut,
    WinningAdMiniOut,
)
from app.services.scoring_service import score_label

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# Mesmo fuso usado em todo o resto do app pro usuário (utils/date.js no
# frontend) — bucket por dia tem que ser dia de Brasília, não dia UTC, senão
# um produto novo às 22h de Brasília (01h UTC do dia seguinte) contaria pro
# dia errado no gráfico.
BRASILIA_TZ = ZoneInfo("America/Sao_Paulo")


def _resolve_date_range(
    days: int, start_date: date_ | None, end_date: date_ | None
) -> tuple[date_, date_]:
    """Período custom (início+fim) tem prioridade sobre o preset `days` — a
    tela só manda os dois juntos quando a pessoa escolheu um range manual."""
    today_local = datetime.now(BRASILIA_TZ).date()
    if start_date and end_date:
        if start_date > end_date:
            raise HTTPException(400, "Data de início não pode ser depois da data de fim")
        return start_date, end_date
    return today_local - timedelta(days=days - 1), today_local


def _daterange(start: date_, end: date_):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


@router.get("/summary", response_model=DashboardSummary)
def get_summary(
    operation: str | None = None,
    as_user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    target_user = resolve_target_user(current_user, as_user_id)
    since = datetime.now(timezone.utc) - timedelta(hours=24)

    competitors_query = (
        db.query(Competitor)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user)
    )
    products_query = (
        db.query(Product)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user)
    )
    alerts_query = (
        db.query(Alert)
        .join(Competitor, Competitor.id == Alert.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user)
    )
    if operation:
        competitors_query = competitors_query.filter(Competitor.operation == operation)
        products_query = products_query.filter(Competitor.operation == operation)
        alerts_query = alerts_query.filter(Competitor.operation == operation)

    total_competitors = competitors_query.count()
    active_competitors = competitors_query.filter(Competitor.status == CompetitorStatus.ACTIVE).count()
    total_products = products_query.filter(Product.is_active.is_(True)).count()

    # "Produtos Quentes" (score 56+, Quente OU Escalando — MESMO critério de
    # /api/products/hot) — não só product.scaling (80+ estrito): esse card
    # ficava quase sempre em 0/1 mesmo com a aba Produtos Quentes cheia,
    # porque o sinal que fecha os 80 pontos sozinho (anúncios crescendo) é
    # raro; a maioria dos produtos quentes chega no 56-79 (ver
    # models/competitor.py:hot_products, mesmo fix aplicado lá).
    # Mesmo achado ao vivo de /score-distribution (2026-08-28, app lento
    # pra todo mundo): trazia TODO o histórico de ProductScore (uma linha
    # por produto, POR DIA, pra sempre) só pra achar a mais recente de cada
    # produto em Python — ficava mais lento a cada dia que passava. DISTINCT
    # ON deixa o Postgres escolher só a linha mais recente por produto,
    # O(produtos ativos) em vez de O(histórico acumulado).
    score_rows_query = (
        db.query(ProductScore.product_id, ProductScore.score)
        .join(Product, Product.id == ProductScore.product_id)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user, Product.is_active.is_(True))
    )
    if operation:
        score_rows_query = score_rows_query.filter(Competitor.operation == operation)
    latest_scores = (
        score_rows_query.distinct(ProductScore.product_id).order_by(ProductScore.product_id, ProductScore.date.desc()).all()
    )
    hot_products = sum(1 for _, score in latest_scores if score >= 56)

    alerts_last_24h = alerts_query.filter(Alert.created_at >= since).count()
    recent_alerts = (
        alerts_query.options(selectinload(Alert.ad), selectinload(Alert.competitor), selectinload(Alert.product))
        .order_by(Alert.created_at.desc())
        .limit(3)
        .all()
    )

    return DashboardSummary(
        total_competitors=total_competitors,
        active_competitors=active_competitors,
        total_products=total_products,
        hot_products=hot_products,
        alerts_last_24h=alerts_last_24h,
        recent_alerts=recent_alerts,
    )


@router.get("/highlights", response_model=DashboardHighlights)
def get_highlights(
    operation: str | None = None,
    as_user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Três listas curtas pro Dashboard bater o olho sem precisar entrar em
    cada aba: quem tá subindo de score rápido, anúncio vencedor ainda no ar,
    e troca de fornecedor recente (o alerta mais "acionável" que existe —
    concorrente trocando de fornecedor é sinal de novo produto chegando).
    """
    target_user = resolve_target_user(current_user, as_user_id)

    # --- Quem está bombando agora: maior salto de score nos últimos 7 dias ---
    since = datetime.now(BRASILIA_TZ).date() - timedelta(days=7)
    score_query = (
        db.query(ProductScore.product_id, ProductScore.date, ProductScore.score)
        .join(Product, Product.id == ProductScore.product_id)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user, Product.is_active.is_(True), ProductScore.date >= since)
    )
    if operation:
        score_query = score_query.filter(Competitor.operation == operation)
    window: dict[int, list[tuple[date_, int]]] = defaultdict(list)
    for product_id, score_date, score in score_query.all():
        window[product_id].append((score_date, score))

    # Delta = score mais recente - score mais antigo dentro da janela; produto
    # com só 1 leitura na semana (raio-x novo) não tem base de comparação, fica
    # de fora em vez de aparecer com salto falso de "0 pra X".
    deltas: list[tuple[int, int, int]] = []
    for product_id, rows in window.items():
        if len(rows) < 2:
            continue
        rows.sort()
        delta = rows[-1][1] - rows[0][1]
        if delta > 0:
            deltas.append((product_id, rows[-1][1], delta))
    deltas.sort(key=lambda row: row[2], reverse=True)
    top = deltas[:5]
    products_by_id: dict[int, Product] = {}
    if top:
        rows = (
            db.query(Product)
            .options(selectinload(Product.competitor))
            .filter(Product.id.in_([pid for pid, _, _ in top]))
            .all()
        )
        products_by_id = {p.id: p for p in rows}
    trending_products = [
        TrendingProductOut(
            product_id=pid,
            title=products_by_id[pid].title,
            competitor_name=products_by_id[pid].competitor.name,
            image_url=products_by_id[pid].main_image_url,
            score=score,
            delta=delta,
        )
        for pid, score, delta in top
        if pid in products_by_id
    ]

    # --- Anúncios vencedores (7+ dias ativos, Ad.is_winning) ainda no ar ---
    ads_query = (
        db.query(Ad)
        .join(Competitor, Competitor.id == Ad.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .options(selectinload(Ad.product), selectinload(Ad.competitor))
        .filter(CompetitorTracker.user_id == target_user, Ad.is_winning.is_(True), Ad.status == AdStatus.ACTIVE)
    )
    if operation:
        ads_query = ads_query.filter(Competitor.operation == operation)
    winning_ads = [
        WinningAdMiniOut(
            id=ad.id,
            product_title=ad.product_title,
            product_image_url=ad.product_image_url,
            competitor_name=ad.competitor.name,
            days_active=ad.days_active,
            library_url=ad.library_url,
        )
        for ad in ads_query.order_by(Ad.started_at.asc()).limit(5).all()
    ]

    # --- Troca de fornecedor recente ---
    vendor_query = (
        db.query(Alert)
        .join(Competitor, Competitor.id == Alert.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .options(selectinload(Alert.product), selectinload(Alert.competitor))
        .filter(
            CompetitorTracker.user_id == target_user,
            Alert.alert_type.in_([AlertType.VENDOR_CHANGED, AlertType.SUPPLIER_ID_CHANGED]),
        )
    )
    if operation:
        vendor_query = vendor_query.filter(Competitor.operation == operation)
    vendor_changes = [
        VendorChangeMiniOut(
            id=a.id,
            competitor_name=a.competitor_name,
            message=a.message,
            product_title=a.product_title,
            created_at=a.created_at,
        )
        for a in vendor_query.order_by(Alert.created_at.desc()).limit(5).all()
    ]

    return DashboardHighlights(
        trending_products=trending_products,
        winning_ads=winning_ads,
        vendor_changes=vendor_changes,
    )


@router.get("/activity-heatmap")
def activity_heatmap(
    operation: str | None = None,
    as_user_id: int | None = None,
    weeks: int = Query(12, ge=1, le=53),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Quantos alertas por dia nas últimas N semanas — heatmap tipo GitHub, pra
    bater o olho e ver se teve semana parada sem entrar em Alertas."""
    target_user = resolve_target_user(current_user, as_user_id)
    range_end = datetime.now(BRASILIA_TZ).date()
    range_start = range_end - timedelta(weeks=weeks) + timedelta(days=1)
    since = datetime.combine(range_start, datetime.min.time(), tzinfo=BRASILIA_TZ).astimezone(timezone.utc)

    query = (
        db.query(Alert.created_at)
        .join(Competitor, Competitor.id == Alert.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(Alert.created_at >= since, CompetitorTracker.user_id == target_user)
    )
    if operation:
        query = query.filter(Competitor.operation == operation)

    counts: dict[date_, int] = defaultdict(int)
    for (created_at,) in query.all():
        aware = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        counts[aware.astimezone(BRASILIA_TZ).date()] += 1

    return [{"date": d.isoformat(), "count": counts.get(d, 0)} for d in _daterange(range_start, range_end)]


@router.get("/alerts-by-competitor")
def alerts_by_competitor(
    operation: str | None = None,
    as_user_id: int | None = None,
    days: int = Query(30, ge=1, le=180),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Ranking de quem mais gerou alerta nos últimos N dias — explica o QUE
    tá puxando o heatmap de atividade pra cima, sem precisar abrir Alertas e
    filtrar loja por loja."""
    target_user = resolve_target_user(current_user, as_user_id)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    query = (
        db.query(Competitor.id, Competitor.name, func.count(Alert.id))
        .join(Alert, Alert.competitor_id == Competitor.id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user, Alert.created_at >= since)
        .group_by(Competitor.id, Competitor.name)
    )
    if operation:
        query = query.filter(Competitor.operation == operation)
    rows = query.order_by(func.count(Alert.id).desc()).limit(5).all()
    return [{"competitor_id": cid, "competitor_name": name, "count": count} for cid, name, count in rows]


@router.get("/alerts-by-category")
def alerts_by_category(
    operation: str | None = None,
    as_user_id: int | None = None,
    days: int = Query(30, ge=1, le=180),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Quantos alertas de cada categoria nos últimos N dias — mesmo
    agrupamento da aba Alertas (ALERT_CATEGORY_TYPES, importado de lá pra não
    duplicar a lista), só com corte de tempo pra mostrar o que tá quente
    AGORA em vez do histórico todo."""
    target_user = resolve_target_user(current_user, as_user_id)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    base = (
        db.query(Alert)
        .join(Competitor, Competitor.id == Alert.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user, Alert.created_at >= since)
    )
    if operation:
        base = base.filter(Competitor.operation == operation)
    return {key: base.filter(Alert.alert_type.in_(types)).count() for key, types in ALERT_CATEGORY_TYPES.items()}


@router.get("/new-products-timeline")
def new_products_timeline(
    competitor_id: int | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    days: int = Query(30, ge=1, le=360),
    start_date: date_ | None = None,
    end_date: date_ | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Quantos produtos novos cada dia. Preenche TODO dia do intervalo (inclusive
    os com 0) pra linha mostrar queda de verdade, não um buraco.
    """
    target_user = resolve_target_user(current_user, as_user_id)
    range_start, range_end = _resolve_date_range(days, start_date, end_date)
    since = datetime.combine(range_start, datetime.min.time(), tzinfo=BRASILIA_TZ).astimezone(timezone.utc)

    query = (
        db.query(ProductEvent.created_at)
        .join(Product, Product.id == ProductEvent.product_id)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(
            ProductEvent.event_type == ProductEventType.NEW_PRODUCT,
            ProductEvent.created_at >= since,
            CompetitorTracker.user_id == target_user,
        )
    )
    if competitor_id:
        query = query.filter(Product.competitor_id == competitor_id)
    elif operation:
        query = query.filter(Competitor.operation == operation)

    counts: dict[date_, int] = defaultdict(int)
    for (created_at,) in query.all():
        aware = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        counts[aware.astimezone(BRASILIA_TZ).date()] += 1

    return [{"date": d.isoformat(), "count": counts.get(d, 0)} for d in _daterange(range_start, range_end)]


@router.get("/ads-timeline")
def ads_timeline(
    competitor_id: int | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    days: int = Query(30, ge=1, le=360),
    start_date: date_ | None = None,
    end_date: date_ | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Anúncios por dia, quebrado por plataforma — usa `started_at` (data real
    da biblioteca quando dá pra parsear, senão hora que a gente viu pela
    primeira vez — mesmo campo/critério já usado em toda parte do app, ver
    scrapers/meta_ads.py). Ajuda a ver se o concorrente tá subindo criativo
    com mais frequência.
    """
    target_user = resolve_target_user(current_user, as_user_id)
    range_start, range_end = _resolve_date_range(days, start_date, end_date)
    since = datetime.combine(range_start, datetime.min.time(), tzinfo=BRASILIA_TZ).astimezone(timezone.utc)

    query = (
        db.query(Ad.started_at, Ad.platform)
        .join(Competitor, Competitor.id == Ad.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(Ad.started_at >= since, CompetitorTracker.user_id == target_user)
    )
    if competitor_id:
        query = query.filter(Ad.competitor_id == competitor_id)
    elif operation:
        query = query.filter(Competitor.operation == operation)

    counts: dict[date_, dict[str, int]] = defaultdict(lambda: {"meta": 0, "google": 0, "tiktok": 0})
    for started_at, platform in query.all():
        aware = started_at if started_at.tzinfo else started_at.replace(tzinfo=timezone.utc)
        d = aware.astimezone(BRASILIA_TZ).date()
        if range_start <= d <= range_end:
            counts[d][platform.value] += 1

    return [
        {"date": d.isoformat(), **counts.get(d, {"meta": 0, "google": 0, "tiktok": 0})}
        for d in _daterange(range_start, range_end)
    ]


@router.get("/score-distribution")
def score_distribution(
    competitor_id: int | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Quantos produtos ativos em cada faixa de score (Frio/Morno/Quente/
    Escalando) AGORA — não é série temporal, é raio-x do momento. Usa o
    score mais recente de cada produto (mesma lógica de /api/products/hot).
    """
    target_user = resolve_target_user(current_user, as_user_id)
    # Achado ao vivo (2026-08-28, app lento pra todo mundo): antes essa
    # query trazia TODAS as linhas de ProductScore de todo o histórico
    # (uma por produto, POR DIA, pra sempre — a tabela só cresce, sem
    # limpeza nenhuma ainda, ver HANDOFF.md) e reduzia pra "só a mais
    # recente por produto" em Python. Isso ficava mais lento a cada dia
    # que passava, sem ninguém perceber até o histórico acumular o
    # suficiente pra doer (medido ao vivo: 1.3s numa conta com alguns
    # meses de dado, contra <100ms do resto do Dashboard). DISTINCT ON já
    # é o padrão usado noutro lugar do código pra esse mesmo problema (ver
    # main.py) — deixa o PRÓPRIO Postgres escolher só a linha mais recente
    # de cada produto, sem trazer o histórico inteiro pela rede: O(produtos
    # ativos), não O(linhas de histórico já acumuladas).
    query = (
        db.query(ProductScore.product_id, ProductScore.score)
        .join(Product, Product.id == ProductScore.product_id)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(Product.is_active.is_(True), CompetitorTracker.user_id == target_user)
    )
    if competitor_id:
        query = query.filter(Product.competitor_id == competitor_id)
    elif operation:
        query = query.filter(Competitor.operation == operation)

    rows = query.distinct(ProductScore.product_id).order_by(ProductScore.product_id, ProductScore.date.desc()).all()

    buckets = {"Frio": 0, "Morno": 0, "Quente": 0, "Escalando": 0}
    for _product_id, score in rows:
        buckets[score_label(score)] += 1

    return [{"label": label, "count": count} for label, count in buckets.items()]
