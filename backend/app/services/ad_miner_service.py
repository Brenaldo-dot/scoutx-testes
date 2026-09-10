"""Módulo 5 — Minerador de Anúncios: varre Meta/Google/TikTok pra uma loja
avulsa (sem cadastro de concorrente) e aplica os critérios de "tá escalando"
definidos ao vivo com o usuário:

1) Mesmo produto rodando ativo em mais de uma plataforma ao mesmo tempo → o
   sinal mais forte que existe. Hoje só dá pra confirmar POR PRODUTO na Meta
   (o `product_handle` vem da URL de destino real do anúncio — ver
   scrapers/meta_ads.py). O Google Ads Transparency e o TikTok Creative
   Center não expõem essa URL publicamente (ambos documentam isso ao vivo em
   scrapers/google_ads.py e scrapers/tiktok_ads.py), então o cruzamento
   multi-plataforma aqui é um sinal FRACO, no nível da LOJA (Meta e Google
   com anúncio ativo ao mesmo tempo) — nunca afirma que é o mesmo produto.
2) 3+ criativos ativos do mesmo produto (mais forte quanto mais datas
   diferentes) OU 1 criativo com várias duplicatas (mesmo texto de anúncio
   repetido, "N anúncios usam esse criativo"). Isso dá pra confirmar de
   verdade na Meta: agrupa por `product_handle` e usa fingerprint de
   `creative_text` pra contar duplicata — mesma lógica de
   services/ads_service.py (`_fingerprint`), reaproduzida aqui porque essa
   função é síncrona e sem Session (scan avulso não grava Ad/AdSnapshot).
"""

import asyncio
import logging
from collections import Counter, defaultdict
from datetime import datetime, timezone

from app.scrapers import google_ads, meta_ads, tiktok_ads
from app.scrapers.result import ScrapeResult
from app.services.competitor_service import country_for_operation

logger = logging.getLogger(__name__)

_FINGERPRINT_LEN = 80
MIN_CREATIVES_FOR_SCALING = 3
MIN_DUPLICATES_FOR_SCALING = 3
HIGH_CONFIDENCE_DUPLICATES = 5
HIGH_CONFIDENCE_MIN_DATES = 3
HIGH_CONFIDENCE_MIN_CREATIVES = 4


def _fingerprint(creative_text: str | None) -> str | None:
    if not creative_text:
        return None
    normalized = creative_text.strip().lower()[:_FINGERPRINT_LEN]
    return normalized or None


def _group_key(ad: dict, index: int) -> str:
    if ad.get("product_handle"):
        return f"produto:{ad['product_handle']}"
    fingerprint = _fingerprint(ad.get("creative_text"))
    # Sem handle de produto (comum quando o anúncio não tem link de destino
    # extraível), agrupa por criativo idêntico; sem nenhum dos dois, cada
    # anúncio vira o próprio grupo — nunca junta coisas diferentes só pra
    # não aparecer "sem agrupamento".
    return f"criativo:{fingerprint}" if fingerprint else f"avulso:{index}"


def _build_product_group(key: str, ads: list[dict]) -> dict:
    fingerprints = [_fingerprint(a.get("creative_text")) for a in ads]
    cluster_sizes = Counter(fp for fp in fingerprints if fp)
    max_duplicates = max(cluster_sizes.values()) if cluster_sizes else 1

    dates = sorted({a["started_at"].date().isoformat() for a in ads if a.get("started_at")})
    total_creatives = len(ads)

    scaling = total_creatives >= MIN_CREATIVES_FOR_SCALING or max_duplicates >= MIN_DUPLICATES_FOR_SCALING
    if not scaling:
        confidence = "baixo"
    elif max_duplicates >= HIGH_CONFIDENCE_DUPLICATES or (
        len(dates) >= HIGH_CONFIDENCE_MIN_DATES and total_creatives >= HIGH_CONFIDENCE_MIN_CREATIVES
    ):
        confidence = "alto"
    else:
        confidence = "médio"

    handle = key.split(":", 1)[1] if key.startswith("produto:") else None
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    ordered = sorted(ads, key=lambda a: a.get("started_at") or epoch, reverse=True)

    return {
        "product_handle": handle,
        "total_creatives": total_creatives,
        "max_duplicate_cluster": max_duplicates,
        "distinct_dates": dates,
        "scaling": scaling,
        "confidence": confidence,
        "advertiser_names": sorted({a.get("advertiser_name") for a in ads if a.get("advertiser_name")}),
        "ads": [
            {
                "library_url": a.get("library_url"),
                "creative_text": a.get("creative_text"),
                "cta": a.get("cta"),
                "advertiser_name": a.get("advertiser_name"),
                "started_at": a["started_at"].isoformat() if a.get("started_at") else None,
                "started_at_raw": a.get("started_at_raw"),
            }
            for a in ordered
        ],
    }


def _group_meta_results(meta_results: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for i, ad in enumerate(meta_results):
        groups[_group_key(ad, i)].append(ad)

    products = [_build_product_group(key, ads) for key, ads in groups.items()]
    products.sort(key=lambda p: (p["scaling"], p["total_creatives"], p["max_duplicate_cluster"]), reverse=True)
    return products


def _safe(result, platform: str, domain: str) -> ScrapeResult:
    if isinstance(result, BaseException):
        logger.exception("Falha inesperada ao escanear %s pra %s", platform, domain, exc_info=result)
        return ScrapeResult(failed=True, error=str(result))
    return result


async def scan_store_domain(domain: str, operation: str = "colombia") -> dict:
    country = country_for_operation(operation)
    meta_result, google_result, tiktok_result = await asyncio.gather(
        meta_ads.search_ads(domain, country=country, verify_domain=domain),
        google_ads.search_ads(domain, region=country),
        tiktok_ads.search_ads(domain, region=country),
        return_exceptions=True,
    )

    meta_result = _safe(meta_result, "Meta", domain)
    google_result = _safe(google_result, "Google", domain)
    tiktok_result = _safe(tiktok_result, "TikTok", domain)

    meta_products = _group_meta_results(meta_result.ads)
    meta_has_scaling = any(p["scaling"] for p in meta_products)

    # Sinal fraco de multi-plataforma — ver docstring do módulo: sem URL de
    # destino confirmável em Google/TikTok, não dá pra provar que é o MESMO
    # produto. Só sinaliza no nível da loja, com o aviso explícito no texto
    # (o front precisa deixar isso claro, não é a mesma força do critério 1
    # original pedido — esse critério só existe de verdade quando as duas
    # plataformas expõem produto, o que hoje só acontece dentro da própria
    # Meta se ela rodar 2 páginas anunciantes diferentes pro mesmo produto).
    # `not google_result.failed` importa aqui: 0 por FALHA não pode contar
    # como "não roda no Google" nem entrar num sinal positivo por acidente.
    multi_platform_signal = meta_has_scaling and not google_result.failed and len(google_result.ads) > 0

    google_note = (
        "A busca no Google Ads Transparency falhou agora (timeout ou bloqueio temporário), isso NÃO significa "
        "que a loja não anuncia lá, só que não deu pra confirmar nessa tentativa. Tenta escanear de novo em "
        "alguns minutos."
        if google_result.failed
        else "O Google Ads Transparency Center não expõe a URL de destino do criativo publicamente, "
        "então aqui só dá pra confirmar QUE a loja tem anúncio ativo no Google, não QUAL produto."
    )
    tiktok_note = (
        "A busca no TikTok Creative Center falhou agora (timeout ou bloqueio temporário), isso NÃO significa "
        "que a loja não anuncia lá, só que não deu pra confirmar nessa tentativa. Tenta escanear de novo em "
        "alguns minutos."
        if tiktok_result.failed
        else "TikTok Creative Center é uma vitrine curada (não um índice completo pesquisável) e boa parte "
        "do texto do anúncio fica gravada no vídeo, cobertura baixa é característica da ferramenta, "
        "não é sinal de que a loja não anuncia lá."
    )

    return {
        "domain": domain,
        "meta": {
            "total_ads_found": len(meta_result.ads),
            "products": meta_products,
            "scan_failed": meta_result.failed,
        },
        "google": {
            "total_ads_found": len(google_result.ads),
            "advertiser_names": sorted(
                {r.get("advertiser_name") for r in google_result.ads if r.get("advertiser_name")}
            ),
            "scan_failed": google_result.failed,
            "note": google_note,
        },
        "tiktok": {
            "total_ads_found": len(tiktok_result.ads),
            "scan_failed": tiktok_result.failed,
            "note": tiktok_note,
        },
        "multi_platform_signal": multi_platform_signal,
    }
