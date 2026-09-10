"""Produtos descobertos por loja + histórico de eventos e score."""

import html
from datetime import datetime, timezone
from typing import Literal

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased, selectinload

from app.api.deps import CurrentUser, get_current_user, resolve_target_user
from app.database import get_db
from app.models import Ad, AdStatus, Competitor, CompetitorTracker, Product, ProductScore
from app.scrapers.http_client import SSRFBlockedError, build_async_client
from app.schemas.product import (
    HotProductListOut,
    HotProductOut,
    ProductDetailOut,
    ProductListOut,
    ProductOut,
    ProductWithAdCountOut,
)
from app.services.scoring_service import score_label

router = APIRouter(prefix="/api/products", tags=["products"])

# Mesmo corte de "Quente ou Escalando" usado em /api/products/hot (Produtos
# Quentes) e em scoring_service.py (rótulo "Quente" a partir daqui) — usado
# também pelo filtro "Só produtos quentes" de list_products logo abaixo, pra
# não ter dois números diferentes de "quente" no app.
HOT_MIN_SCORE = 56

# Subquery correlacionada (1 por linha, sem GROUP BY) — mesmo padrão de
# api/ads.py:_DAYS_ACTIVE_EXPR pra ordenar por algo que não é coluna direta.
_ACTIVE_ADS_SUBQ = (
    select(func.count(Ad.id))
    .where(Ad.product_id == Product.id, Ad.status == AdStatus.ACTIVE)
    .correlate(Product)
    .scalar_subquery()
)

# Score mais recente do produto (1 linha por dia em ProductScore, ver
# models/score.py) — pega só a última data, não soma nem agrupa. Mesmo
# padrão de _ACTIVE_ADS_SUBQ acima, usado pelo filtro "Só produtos quentes".
_LATEST_SCORE_SUBQ = (
    select(ProductScore.score)
    .where(ProductScore.product_id == Product.id)
    .order_by(ProductScore.date.desc())
    .limit(1)
    .correlate(Product)
    .scalar_subquery()
)


@router.get("", response_model=ProductListOut)
def list_products(
    competitor_id: int | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    q: str | None = None,
    hot_only: bool = False,
    active_only: bool = True,
    sort: Literal["recent", "duplicates", "active_ads"] = "recent",
    page: int = Query(1, ge=1),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    # Sempre junta com o rastreador desse usuário (multi-tenant, dado
    # compartilhado — ver models/competitor.py:CompetitorTracker) — não é
    # mais opcional como o filtro de `operation`, então entra incondicional.
    target_user = resolve_target_user(current_user, as_user_id)
    query = (
        db.query(Product)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == target_user)
    )
    if competitor_id:
        query = query.filter(Product.competitor_id == competitor_id)
    if operation:
        query = query.filter(Competitor.operation == operation)
    if q and q.strip():
        query = query.filter(Product.title.ilike(f"%{q.strip()}%"))
    if hot_only:
        # Antes filtrava por Product.scaling (score 80+, só a faixa
        # "Escalando" pura) — trocado pra bater com a MESMA população da aba
        # Produtos Quentes (score 56+, Quente OU Escalando, ver HOT_MIN_SCORE
        # acima), senão essa lista mostrava só uma fração de "quente" de
        # verdade (pedido do usuário: renomear o filtro pra "Só produtos
        # quentes" e mostrar TODOS os produtos quentes, não só os 80+).
        query = query.filter(_LATEST_SCORE_SUBQ >= HOT_MIN_SCORE)
    if active_only:
        query = query.filter(Product.is_active.is_(True))

    if sort == "duplicates":
        # Só quem tem duplicata de verdade — sem isso a lista ficaria cheia
        # de produto com 0 duplicatas lá embaixo, o que não é o que se quer
        # ao pedir "os mais duplicados primeiro".
        query = query.filter(Product.duplicate_count > 0).order_by(
            Product.duplicate_count.desc(), Product.last_seen_at.desc()
        )
    elif sort == "active_ads":
        # Mesma lógica de "duplicates": só quem tem pelo menos 1 anúncio
        # ativo — senão a lista fica cheia de produto com 0 anúncio lá
        # embaixo, sem sentido pra quem pediu "mais anúncio ativo primeiro".
        query = query.filter(_ACTIVE_ADS_SUBQ > 0).order_by(_ACTIVE_ADS_SUBQ.desc(), Product.last_seen_at.desc())
    else:
        query = query.order_by(Product.last_seen_at.desc())

    # `total` conta ANTES do limit/offset — sem isso a tela não tem como
    # saber quantas páginas existem pra montar "Próxima" (o app tem milhares
    # de produto hoje, 500 por página não dava pra ver o resto de jeito nenhum).
    total = query.order_by(None).count()
    items = query.limit(limit).offset((page - 1) * limit).all()

    # Contagem de anúncios ativos por produto da PÁGINA, numa query só (não
    # uma por produto) — mesmo padrão de list_hot_products logo abaixo.
    # `latest_ad_library_url` (o link pro "Ver anúncios") vem junto — sem
    # isso o botão nunca aparecia nessa tela (bug relatado pelo usuário: só
    # tinha no card de Produtos Quentes, que busca esse dado à parte).
    product_ids = [p.id for p in items]
    active_counts: dict[int, int] = {}
    latest_library_url: dict[int, str | None] = {}
    if product_ids:
        ad_rows = (
            db.query(Ad)
            .filter(Ad.product_id.in_(product_ids), Ad.status == AdStatus.ACTIVE)
            .order_by(Ad.product_id, Ad.started_at.desc())
            .all()
        )
        for ad in ad_rows:
            active_counts[ad.product_id] = active_counts.get(ad.product_id, 0) + 1
            latest_library_url.setdefault(ad.product_id, ad.library_url)

    results = [
        ProductWithAdCountOut(
            **ProductOut.model_validate(p).model_dump(),
            active_ad_count=active_counts.get(p.id, 0),
            latest_ad_library_url=latest_library_url.get(p.id),
        )
        for p in items
    ]
    return ProductListOut(items=results, total=total)


@router.get("/hot", response_model=HotProductListOut)
def list_hot_products(
    min_score: int = Query(HOT_MIN_SCORE, ge=0, le=100),
    operation: str | None = None,
    as_user_id: int | None = None,
    q: str | None = None,
    sort: Literal["score", "active_ads", "ad_duration"] = "score",
    has_supplier: bool = False,
    growing_only: bool = False,
    page: int = Query(1, ge=1),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """
    Módulo 8.2 — "Produtos Quentes": score >= 56 (Quente ou Escalando),
    ordenado decrescente por padrão (score = "mais escalados"). Precisa
    ficar ANTES de /{product_id} no arquivo — senão o FastAPI tenta
    converter "hot" pra int e devolve 422 em vez de cair aqui.

    Usa o score mais recente já calculado por produto (não exige que seja
    "hoje"): no setup local sem Celery Beat, o score só é recalculado quando
    alguém roda o snapshot diário manualmente, então travar em `date==hoje`
    faria essa tela voltar vazia sempre que o último cálculo foi ontem.

    `q` (busca por nome), `has_supplier`/`growing_only` e
    `sort=active_ads`/`ad_duration` (pedido do usuário: filtros de mais
    anúncios ativos, fornecedor conectado, mais tempo de anúncio ativo,
    anúncios crescendo) precisam ser aplicados ANTES de paginar, senão a
    página 2 não bate com o que a página 1 já mostrou.
    """
    target_user = resolve_target_user(current_user, as_user_id)
    # Achado ao vivo (2026-08-28, "próximo" na paginação travando 2-4s):
    # mesmo padrão já corrigido em dashboard.py — buscava TODO o histórico de
    # ProductScore (uma linha por produto, por dia, pra sempre) só pra achar
    # a mais recente de cada produto em Python. DISTINCT ON deixa o Postgres
    # escolher só a linha mais recente por produto, sem trazer o histórico
    # inteiro pela rede.
    #
    # Achado ao vivo de novo (2026-09-05, essa tela voltou a ficar lenta —
    # 0,6 a 1,5s): o DISTINCT ON acima trazia a pontuação mais recente de
    # TODO produto ativo rastreado (quente ou não), pra só DEPOIS filtrar
    # `score >= min_score` em Python — conforme o catálogo cresce, isso
    # transfere cada vez mais linha frio pela rede à toa. Envolve o DISTINCT
    # ON numa subquery e filtra o score já no banco, então só o que realmente
    # qualifica como "quente" volta pra cá.
    rows_query = (
        db.query(ProductScore)
        .join(Product, Product.id == ProductScore.product_id)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(Product.is_active.is_(True), CompetitorTracker.user_id == target_user)
    )
    if operation:
        rows_query = rows_query.filter(Competitor.operation == operation)
    latest_per_product = (
        rows_query.distinct(ProductScore.product_id).order_by(ProductScore.product_id, ProductScore.date.desc())
    ).subquery()
    LatestScore = aliased(ProductScore, latest_per_product)
    qualifying_all = sorted(
        db.query(LatestScore).filter(LatestScore.score >= min_score).all(),
        key=lambda row: row.score,
        reverse=True,
    )

    product_ids_all = [row.product_id for row in qualifying_all]
    products = {p.id: p for p in db.query(Product).filter(Product.id.in_(product_ids_all))} if product_ids_all else {}

    if q and q.strip():
        term = q.strip().lower()
        qualifying_all = [
            row
            for row in qualifying_all
            if products.get(row.product_id) and term in products[row.product_id].title.lower()
        ]
    if has_supplier:
        qualifying_all = [
            row for row in qualifying_all if products.get(row.product_id) and products[row.product_id].supplier_id
        ]
    if growing_only:
        qualifying_all = [row for row in qualifying_all if "anuncios_crescendo" in (row.signals or [])]

    # Anúncios ativos de TODO o conjunto que qualifica (não só a página) —
    # precisa saber isso ANTES de paginar pra poder ordenar por "mais
    # anúncios ativos"/"mais tempo de anúncio ativo", e também pra mostrar
    # no card de cada item da página (1 query só, não uma por produto).
    qualifying_ids = [row.product_id for row in qualifying_all]
    ads_by_product: dict[int, list[Ad]] = {}
    if qualifying_ids:
        ad_rows = (
            db.query(Ad)
            .filter(Ad.product_id.in_(qualifying_ids), Ad.status == AdStatus.ACTIVE)
            .order_by(Ad.product_id, Ad.started_at.desc())
            .all()
        )
        for ad in ad_rows:
            ads_by_product.setdefault(ad.product_id, []).append(ad)

    def _longest_active_days(product_id: int) -> int:
        started_ats = [a.started_at for a in ads_by_product.get(product_id, []) if a.started_at]
        if not started_ats:
            return 0
        oldest = min(started_ats)
        if oldest.tzinfo is None:
            oldest = oldest.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - oldest).days

    if sort == "active_ads":
        qualifying_all.sort(key=lambda row: len(ads_by_product.get(row.product_id, [])), reverse=True)
    elif sort == "ad_duration":
        qualifying_all.sort(key=lambda row: _longest_active_days(row.product_id), reverse=True)
    # sort == "score" (padrão) já está ordenado por score desc, não precisa reordenar.

    total = len(qualifying_all)
    qualifying = qualifying_all[(page - 1) * limit : (page - 1) * limit + limit]

    results = []
    for row in qualifying:
        product = products.get(row.product_id)
        if not product:
            continue
        product_ads = ads_by_product.get(product.id, [])
        results.append(
            HotProductOut(
                **ProductOut.model_validate(product).model_dump(),
                score=row.score,
                score_label=score_label(row.score),
                signals=row.signals,
                score_date=row.date,
                active_ad_count=len(product_ads),
                latest_ad_library_url=product_ads[0].library_url if product_ads else None,
            )
        )
    return HotProductListOut(items=results, total=total)


def _product_owned_query(db: Session, user_id: int):
    return (
        db.query(Product)
        .join(Competitor, Competitor.id == Product.competitor_id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id == user_id)
    )


@router.get("/{product_id}", response_model=ProductDetailOut)
def get_product(
    product_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    product = (
        _product_owned_query(db, current_user.id)
        .options(selectinload(Product.events), selectinload(Product.scores))
        .filter(Product.id == product_id)
        .first()
    )
    if not product:
        raise HTTPException(404, "Produto não encontrado")
    return product


@router.get("/{product_id}/preview")
async def preview_product_page(
    product_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    """
    Devolve a página REAL do produto, buscada no servidor e reservida a
    partir do NOSSO domínio — pra poder entrar num iframe.

    O Shopify bloqueia ser embutido por padrão (header
    `Content-Security-Policy: frame-ancestors 'none'`, confirmado ao vivo
    contra várias lojas), mas esse header só existe na RESPOSTA DELES; ao
    buscar o HTML aqui no back e servir de novo a partir da nossa própria
    origem, o header deles nunca chega no navegador do usuário — quem está
    sendo carregado no iframe é a nossa resposta, não a deles.

    <script> é removido inteiro: essa prévia é só visual (ler a página real,
    com o CSS e as imagens de verdade, sem precisar abrir aba nova), não uma
    réplica funcional — rodar JS de terceiro dentro do nosso domínio abriria
    risco real de XSS contra o próprio app.
    """
    product = _product_owned_query(db, current_user.id).filter(Product.id == product_id).first()
    if not product:
        raise HTTPException(404, "Produto não encontrado")

    domain = product.competitor.domain
    target_url = f"https://{domain}/products/{product.handle}"

    try:
        async with await build_async_client(domain) as client:
            response = await client.get(target_url)
            response.raise_for_status()
            # Redirect não é seguido automaticamente (ver build_async_client)
            # — pra onde ele apontaria já não passou pela validação de IP,
            # então tratamos igual erro em vez de servir uma página vazia.
            if response.is_redirect:
                return HTMLResponse(_preview_error_page(target_url))
            html = response.text
    except (httpx.HTTPError, SSRFBlockedError):
        return HTMLResponse(_preview_error_page(target_url))

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all("script"):
        tag.decompose()
    for tag in soup.find_all("meta", attrs={"http-equiv": lambda v: bool(v) and v.lower() == "content-security-policy"}):
        tag.decompose()

    head = soup.head
    if head is None:
        head = soup.new_tag("head")
        (soup.html or soup).insert(0, head)
    head.insert(0, soup.new_tag("base", href=f"https://{domain}/"))

    return HTMLResponse(str(soup))


def _preview_error_page(target_url: str) -> str:
    # html.escape aqui é defesa em profundidade (achado em auditoria):
    # target_url vem de domain + product.handle (slug gerado pela própria
    # Shopify, não é texto livre digitado por alguém), risco baixo, mas
    # escapar não custa nada e fecha a brecha por completo.
    return f"""<!doctype html>
<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font-family:sans-serif;color:#64748b;text-align:center;padding:16px;">
<p>Não foi possível carregar a página agora.<br>
<a href="{html.escape(target_url)}" target="_blank" style="color:#2563eb;">Abrir direto na loja ↗</a></p>
</body></html>"""
