"""
Módulo 3.3 / Módulo 5 — score 0-100 por produto, por pontos ponderados.

Pesos definidos pelo usuário a partir de como ELE mesmo julga se um
concorrente tá escalando um produto (não é uma fórmula genérica de livro).

Recalibrado depois que a primeira versão (pesos baixos, quase tudo ficava
Frio/Morno) se mostrou rigorosa demais na prática — o usuário reportou que
nem um produto real escalando batia os 80 pontos. A ordem relativa dos
sinais é a mesma, só o peso de cada um mudou pra bater com a CONFIANÇA que o
usuário descreveu em cada um, lida ao pé da letra:

- Quantidade de anúncios ativos do produto CRESCENDO dia a dia (ex:
  7→9→12→23) é o sinal mais forte de todos — nas palavras dele, "MUITO
  forte" e "com certeza ela está escalando" (sem ressalva). Por isso pesa
  80 pontos SOZINHO: esse sinal por si só já basta pra cruzar a faixa
  "Escalando" (80+), igual ele descreveu.
- Tempo do ANÚNCIO no ar (não da página do produto — o usuário foi explícito
  nisso) é o segundo sinal mais forte, mas prova que o produto VENDE, não
  necessariamente que está ESCALANDO agora — por isso o teto (30+ dias) leva
  a "Quente", não direto a "Escalando": 7d é só indício (não tira de Frio
  sozinho), 14d já é Morno sozinho, 30d ele considera quase certeza de venda
  e chega em Quente sozinho.
- Página duplicada é sinal real mas raro mesmo em produto escalando de
  verdade — pouco peso de propósito, não por engano.
- Troca de cód. fornecedor é ambígua por natureza (fornecedor com estoque
  grande nunca força troca mesmo escalando muito; fornecedor pequeno força
  troca direto mesmo com pouco volume) — por isso pouco peso, só reforça.
- Urgência/escassez na copy: removido do score por instrução direta do
  usuário ("não tem nada a ver") — comum demais pra ser sinal de escala
  (ver docstring de snapshot_service.py). Continua só como evento/alerta
  quando muda, não como pontuação.

Faixa "escalando" (80-100) é o que já era o campo `product.scaling` — mantido
o mesmo nome/campo pra não quebrar quem já consome esse booleano.
"""

import logging
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import (
    Ad,
    AdStatus,
    AlertType,
    Competitor,
    Product,
    ProductEvent,
    ProductEventType,
    ProductScore,
    ProductSnapshot,
)
from app.services import alert_service

logger = logging.getLogger(__name__)

WINDOW_DAYS = 7
SUPPLIER_CHANGE_WINDOW_DAYS = 30
# Mínimo de pontos de histórico (ProductScore.active_ad_count) pra confiar
# numa tendência de crescimento — 2 pontos poderiam ser ruído de 1 dia só.
MIN_HISTORY_FOR_GROWTH = 3
MIN_AD_GROWTH = 3

SCORE_LABELS = [
    (80, "Escalando"),
    (56, "Quente"),
    (31, "Morno"),
    (0, "Frio"),
]


def score_label(score: int) -> str:
    for floor, label in SCORE_LABELS:
        if score >= floor:
            return label
    return "Frio"


async def score_product(
    db: Session, competitor: Competitor, product: Product, today: date | None = None
) -> ProductScore:
    today = today or date.today()
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)

    score = 0
    signals: list[str] = []

    # Sinal: tempo do ANÚNCIO no ar, não da página do produto (2º mais
    # forte). Teto (30d+) prova que VENDE, chega em "Quente" sozinho — não
    # em "Escalando", que fica reservado pro sinal de crescimento abaixo.
    # A PONTUAÇÃO não muda depois de 30 dias (mesmo raciocínio do docstring
    # do módulo: 30d já é "quase certeza de venda", mais dias não é mais
    # sinal de ESCALA) — só o RÓTULO fica mais fino pedido pelo usuário
    # (antes travava em "30D+" pra sempre, escondendo que um anúncio tá no
    # ar há 95 dias em vez de 31).
    dias_anuncio = _oldest_active_ad_days(db, product.id)
    if dias_anuncio is not None:
        if dias_anuncio >= 30:
            score += 60
            for floor in (95, 85, 75, 65, 55, 45, 30):
                if dias_anuncio >= floor:
                    signals.append(f"anuncio_ativo_{floor}d+")
                    break
        elif dias_anuncio >= 14:
            score += 35
            signals.append("anuncio_ativo_14d+")
        elif dias_anuncio >= 7:
            score += 20
            signals.append("anuncio_ativo_7d+")

    # Sinal: quantidade de anúncios ativos crescendo dia a dia — o MAIS
    # forte de todos, nas palavras do usuário: "com certeza ela está
    # escalando". 80 pontos sozinho já cruza a faixa "Escalando" (80+) sem
    # precisar de mais nada — igual ele descreveu. Precisa do histórico de
    # active_ad_count (calculado abaixo, ANTES de checar) — olha os
    # registros já salvos em dias anteriores, não o de hoje ainda.
    active_ad_count = db.query(Ad).filter(Ad.product_id == product.id, Ad.status == AdStatus.ACTIVE).count()
    if _ad_count_growing(db, product.id, active_ad_count, today):
        score += 80
        signals.append("anuncios_crescendo")

    if product.duplicated:
        score += 10
        signals.append("paginas_duplicadas")

    if _has_event(db, product.id, ProductEventType.SUPPLIER_ID_CHANGED, now - timedelta(days=SUPPLIER_CHANGE_WINDOW_DAYS)):
        score += 10
        signals.append("fornecedor_mudou")

    quedas_consecutivas = _consecutive_stock_drops(db, product.id)
    if quedas_consecutivas >= 3:
        score += 10
        signals.append("estoque_caindo_3x+")
    elif quedas_consecutivas >= 1:
        score += 5
        signals.append("estoque_caindo")

    if _has_event(db, product.id, ProductEventType.VARIATIONS_ADDED, since):
        score += 10
        signals.append("variacoes_aumentaram")

    score_value = min(score, 100)
    was_scaling = product.scaling
    is_scaling = score_value >= 80

    existing = (
        db.query(ProductScore).filter(ProductScore.product_id == product.id, ProductScore.date == today).first()
    )
    if existing:
        existing.score = score_value
        existing.signals = signals
        existing.active_ad_count = active_ad_count
        record = existing
    else:
        record = ProductScore(
            product_id=product.id, date=today, score=score_value, signals=signals, active_ad_count=active_ad_count
        )
        db.add(record)

    product.scaling = is_scaling
    db.flush()

    if is_scaling and not was_scaling:
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.SCALING_DETECTED,
            f"{product.title} em {competitor.name} entrou em modo escalando "
            f"(score {score_value}/100: {', '.join(signals)})",
            product=product,
        )

    db.commit()
    return record


def _has_event(db: Session, product_id: int, event_type: ProductEventType, since: datetime) -> bool:
    return (
        db.query(ProductEvent)
        .filter(
            ProductEvent.product_id == product_id,
            ProductEvent.event_type == event_type,
            ProductEvent.created_at >= since,
        )
        .first()
        is not None
    )


def _consecutive_stock_drops(db: Session, product_id: int) -> int:
    """Conta quedas consecutivas terminando na captura mais recente (olhando
    pra trás) — uma única reposição já zera a contagem, é sinal de queda
    sustentada, não de ruído."""
    snapshots = (
        db.query(ProductSnapshot)
        .filter(ProductSnapshot.product_id == product_id, ProductSnapshot.total_inventory.isnot(None))
        .order_by(ProductSnapshot.captured_at.desc())
        .limit(30)
        .all()
    )
    count = 0
    for newer, older in zip(snapshots, snapshots[1:]):
        if newer.total_inventory is None or older.total_inventory is None:
            break
        if newer.total_inventory < older.total_inventory:
            count += 1
        else:
            break
    return count


def _oldest_active_ad_days(db: Session, product_id: int) -> int | None:
    ads = db.query(Ad).filter(Ad.product_id == product_id, Ad.status == AdStatus.ACTIVE).all()
    days = [a.days_active for a in ads if a.days_active is not None]
    return max(days) if days else None


def _ad_count_growing(db: Session, product_id: int, today_count: int, today: date) -> bool:
    """
    Sinal "MUITO forte" do usuário: quantidade de anúncios ativos do produto
    crescendo dia a dia (ex: 7 → 9 → 12 → 23). Usa o histórico já salvo em
    ProductScore.active_ad_count de dias ANTERIORES (`date < today`, nunca
    hoje) + a contagem de HOJE calculada agora.

    O filtro `date < today` é essencial, não cosmético: sem ele, rodar o
    scoring mais de uma vez no mesmo dia (comum em teste/debug, ou um retry)
    faz a própria linha de HOJE já salva contar como "ponto de histórico" —
    bug real encontrado ao vivo: depois de corrigir o vínculo anúncio-
    produto, 6 produtos apareceram como "Escalando" porque a query pegou o
    active_ad_count=0 salvo mais cedo hoje (antes do fix, quando nenhum
    anúncio tinha produto vinculado) como se fosse um dia de histórico
    legítimo, e comparou com o valor correto de agora — lendo uma correção
    de bug pontual como se fosse crescimento orgânico de anúncio. Com o
    filtro, esse sinal só pode disparar depois que dias de calendário de
    verdade passarem (ver MIN_HISTORY_FOR_GROWTH).

    Exige pelo menos MIN_HISTORY_FOR_GROWTH pontos no total pra não
    confundir "1 anúncio novo isolado" com tendência real, tolera no máximo
    -1 de ruído em cada passo (não uma queda de verdade no meio do
    crescimento), e exige crescimento total mínimo de MIN_AD_GROWTH
    anúncios do primeiro ponto pro último.
    """
    previous = (
        db.query(ProductScore)
        .filter(
            ProductScore.product_id == product_id,
            ProductScore.active_ad_count.isnot(None),
            ProductScore.date < today,
        )
        .order_by(ProductScore.date.desc())
        .limit(MIN_HISTORY_FOR_GROWTH - 1)
        .all()
    )
    counts = [s.active_ad_count for s in reversed(previous)] + [today_count]
    if len(counts) < MIN_HISTORY_FOR_GROWTH:
        return False
    if counts[-1] - counts[0] < MIN_AD_GROWTH:
        return False
    return all(b >= a - 1 for a, b in zip(counts, counts[1:]))
