"""
Módulo 4.3 — lógica de anúncio vencedor / anúncio morto.

`comment_count` fica sempre None: a Ads Library pública não expõe métricas de
engajamento (curtidas/comentários) para anúncios comerciais comuns — isso só
existe para a parte de anúncios políticos/de interesse público em alguns
países. O campo continua no schema (AdSnapshot.comment_count) pra o dia que
uma fonte real de engajamento for plugada, mas por ora "velocidade de
engajamento" não é calculada com número inventado.

`started_at`: usa a data real da biblioteca quando dá pra parsear (formato
"D de MÊS de AAAA" — ver scrapers/meta_ads.py). Só cai pra "hora que NÓS
vimos o anúncio pela primeira vez" quando o texto não bate com esse formato
(ex: inglês). `started_at_raw` sempre guarda o texto original da Meta, pra
quem quiser conferir a fonte.

Sobre "várias versões": testado ao vivo, é comum a Meta listar a MESMA
campanha como vários IDs de biblioteca distintos (cada versão/variação de
teste vira uma entrada própria) com o texto do criativo idêntico ou quase
idêntico. Cada um é salvo como Ad separado (é dado real, não duplicata) mas
só o primeiro de cada "família" dispara alerta de novo anúncio — sem isso o
feed de alertas fica poluído com o mesmo texto longo repetido 5-6 vezes.
"""

import logging
import re
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Ad, AdPlatform, AdSnapshot, AdStatus, AlertType, Competitor, Product
from app.services import alert_service

logger = logging.getLogger(__name__)

WINNING_AD_DAYS = 7
_FINGERPRINT_LEN = 80

_STOPWORDS_ES = {
    "de", "la", "el", "en", "con", "para", "por", "un", "una", "y", "o", "los", "las",
    "del", "al", "su", "sus", "que", "es", "mas", "más", "the", "and", "for", "with",
}


def _significant_words(text: str) -> set[str]:
    words = re.findall(r"[a-záéíóúñ0-9]+", text.lower())
    return {w for w in words if len(w) >= 4 and w not in _STOPWORDS_ES}


def _match_product_by_text(creative_text: str | None, candidates: list[Product]) -> Product | None:
    """Reserva pra quando a URL de destino do anúncio não dá pra casar com
    nenhum handle específico via scrapers/meta_ads.py:_extract_product_handle
    (funil, redirect, link só pra home/coleção — nem todo anúncio de COD
    linka direto pra /products/... ou /pages/...) — tenta achar o produto
    pelo TEXTO do criativo em vez da URL de destino.

    Achado ao vivo revisando o undercount de "anúncios ativos": um produto
    tinha 5 anúncios reais na biblioteca, só 2 contavam aqui — vários dos
    outros linkavam pra fora do padrão que a URL sozinha reconhece. Só
    decide quando a confiança é ALTA e o vencedor é ÚNICO — errar aqui é
    pior que não vincular nada, porque contaria o anúncio no produto
    ERRADO."""
    if not creative_text:
        return None
    text_words = _significant_words(creative_text)
    if not text_words:
        return None

    best: Product | None = None
    best_score = 0.0
    runner_up_score = 0.0
    for product in candidates:
        title_words = _significant_words(product.title or "")
        if len(title_words) < 2:
            continue  # título curto demais pra confiar (bateria com qualquer copy)
        score = len(title_words & text_words) / len(title_words)
        if score > best_score:
            runner_up_score = best_score
            best_score = score
            best = product
        elif score > runner_up_score:
            runner_up_score = score

    # Exige pelo menos 70% das palavras significativas do título presentes no
    # texto do anúncio, E uma margem clara sobre o 2º colocado — evita
    # decidir em cima de um empate ambíguo entre produtos parecidos da mesma
    # loja (ex: duas variações de cor do mesmo item).
    if best_score >= 0.7 and (best_score - runner_up_score) >= 0.2:
        return best
    return None


def _json_safe(raw: dict) -> dict:
    """AdSnapshot.raw é uma coluna JSON; datetime (ex: `started_at` parseado
    em scrapers/meta_ads.py) não serializa direto — vira string ISO aqui só
    pra essa cópia de auditoria, sem afetar o dict original usado acima."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in raw.items()}


def _fingerprint(creative_text: str | None) -> str | None:
    if not creative_text:
        return None
    normalized = creative_text.strip().lower()[:_FINGERPRINT_LEN]
    return normalized or None


def _has_similar_active_ad(db: Session, competitor_id: int, platform: AdPlatform, creative_text: str | None) -> bool:
    fingerprint = _fingerprint(creative_text)
    if not fingerprint:
        return False
    candidates = (
        db.query(Ad)
        .filter(Ad.competitor_id == competitor_id, Ad.platform == platform, Ad.status == AdStatus.ACTIVE)
        .all()
    )
    return any(_fingerprint(other.creative_text) == fingerprint for other in candidates)


async def ingest_search_results(
    db: Session,
    competitor: Competitor,
    platform: AdPlatform,
    raw_results: list[dict],
) -> None:
    # Handle → Product da loja, carregado uma vez por chamada (não por
    # anúncio) — usado abaixo pra resolver a QUAL produto cada anúncio
    # pertence a partir da URL de destino real que scrapers/meta_ads.py
    # extrai (`product_handle`, match exato contra Product.handle). TikTok/
    # Google não preenchem esse campo hoje, então isso vira sempre None ali
    # e o comportamento é o mesmo de antes (anúncio sem produto vinculado).
    # .strip().lower() nos dois lados — `_extract_product_handle` já devolve
    # minúsculo, mas comparar sem normalizar os dois lados do mesmo jeito é
    # um jeito fácil de deixar passar por engano (achado revisando o bug do
    # undercount de anúncios ativos).
    products_by_handle = {
        p.handle.strip().lower(): p for p in db.query(Product).filter(Product.competitor_id == competitor.id).all()
    }

    seen_external_ids: set[str] = set()

    for raw in raw_results:
        external_id = raw.get("external_ad_id")
        if not external_id:
            continue
        seen_external_ids.add(external_id)

        handle = (raw.get("product_handle") or "").strip().lower()
        product = products_by_handle.get(handle) if handle else None
        if product is None:
            product = _match_product_by_text(raw.get("creative_text"), list(products_by_handle.values()))

        ad = db.query(Ad).filter(Ad.platform == platform, Ad.external_ad_id == external_id).first()

        if ad is None:
            # Checa ANTES de inserir o novo Ad — se checasse depois, o
            # anúncio que a gente mesmo acabou de criar já contaria como
            # "similar existente" e nunca alertaria nada.
            already_known_campaign = _has_similar_active_ad(db, competitor.id, platform, raw.get("creative_text"))

            ad = Ad(
                competitor_id=competitor.id,
                product_id=product.id if product else None,
                platform=platform,
                external_ad_id=external_id,
                library_url=raw.get("library_url"),
                advertiser_name=raw.get("advertiser_name"),
                creative_text=raw.get("creative_text"),
                cta=raw.get("cta"),
                started_at=raw.get("started_at") or datetime.now(timezone.utc),
                started_at_raw=raw.get("started_at_raw"),
                status=AdStatus.ACTIVE,
            )
            db.add(ad)
            db.flush()

            if not already_known_campaign:
                await alert_service.create_alert(
                    db,
                    competitor,
                    AlertType.NEW_AD,
                    f"Novo anúncio detectado ({platform.value}) em {competitor.name}: "
                    f"{ad.creative_text or ad.library_url}",
                    product=product,
                    ad=ad,
                )
        else:
            was_inactive = ad.status == AdStatus.INACTIVE
            ad.creative_text = raw.get("creative_text") or ad.creative_text
            ad.cta = raw.get("cta") or ad.cta
            ad.advertiser_name = raw.get("advertiser_name") or ad.advertiser_name
            ad.status = AdStatus.ACTIVE
            ad.killed_at = None
            ad.missed_scans = 0
            # Só preenche se ainda não tem produto — não troca um vínculo já
            # existente por outro (ex: handle mudou de dono, caso raro).
            if product is not None and ad.product_id is None:
                ad.product_id = product.id
            if raw.get("started_at"):
                ad.started_at = raw["started_at"]  # upgrade de "hora que vimos" pra data real, se agora deu pra parsear
            if raw.get("started_at_raw"):
                ad.started_at_raw = raw["started_at_raw"]
            if was_inactive:
                if not raw.get("started_at"):
                    ad.started_at = datetime.now(timezone.utc)  # nova veiculação, sem data real pra usar
                ad.is_winning = False

        if not ad.is_winning and (ad.days_active or 0) >= WINNING_AD_DAYS:
            ad.is_winning = True
            await alert_service.create_alert(
                db,
                competitor,
                AlertType.WINNING_AD,
                f"Anúncio ativo há {ad.days_active}+ dias → {ad.creative_text or ad.library_url} "
                f"em {competitor.name}, pode estar convertendo",
                product=product,
                ad=ad,
            )

        db.add(AdSnapshot(ad_id=ad.id, status=ad.status, comment_count=None, raw=_json_safe(raw)))

    await _mark_killed_ads(db, competitor, platform, seen_external_ids)
    db.commit()


async def _mark_killed_ads(
    db: Session,
    competitor: Competitor,
    platform: AdPlatform,
    seen_external_ids: set[str],
) -> None:
    if platform == AdPlatform.GOOGLE:
        # NUNCA marca anúncio do Google como morto por ausência — confirmado
        # ao vivo que isso gera falso positivo grave: um anúncio foi marcado
        # "morto" (killed_at) numa rodada e, checando na hora direto na
        # página oficial do Google (adstransparency.google.com), a "Última
        # exibição" dele era HOJE — continuava ativo. A busca por domínio do
        # Google só expõe uma amostra pequena ("prioritária") de criativos, e
        # essa amostra roda: 2 buscas no MESMO dia trouxeram 2 conjuntos de 4
        # anúncios diferentes pro mesmo anunciante. "Não apareceu nessa
        # amostra" não é sinal nenhum de "parou de rodar" — sem uma forma
        # confiável de saber (precisaria da data "Última exibição" de cada
        # anúncio individualmente, que não é extraída hoje), o certo é NUNCA
        # declarar morto, só ativo (o que a gente de fato confirma ao achar).
        return

    query = db.query(Ad).filter(
        Ad.competitor_id == competitor.id, Ad.platform == platform, Ad.status == AdStatus.ACTIVE
    )

    # Meta: mesmo raciocínio do Google acima, um degrau mais tolerante — a
    # busca por keyword + scroll limitado às vezes simplesmente não traz um
    # anúncio real numa rodada específica (achado ao vivo revisando um
    # undercount de anúncios ativos). Uma rodada perdida vira só um contador
    # (`missed_scans`); só marca morto na SEGUNDA rodada seguida sem ver.
    require_two_misses = platform == AdPlatform.META

    for ad in query.all():
        if ad.external_ad_id in seen_external_ids:
            continue
        if require_two_misses and ad.missed_scans < 1:
            ad.missed_scans += 1
            continue
        ad.status = AdStatus.INACTIVE
        ad.killed_at = datetime.now(timezone.utc)
        db.add(AdSnapshot(ad_id=ad.id, status=ad.status, comment_count=None, raw=None))
        await alert_service.create_alert(
            db,
            competitor,
            AlertType.AD_KILLED,
            f"Anúncio pausado → {ad.creative_text or ad.library_url} em {competitor.name}, "
            "produto possivelmente morto",
            product=ad.product,
            ad=ad,
        )
