"""
Módulo 2.1 — coleta de produtos via API pública do Shopify (/products.json).

Este endpoint é servido por padrão em qualquer loja Shopify para a vitrine
(o mesmo que o Googlebot ou qualquer visitante lê); não requer autenticação.
"""

import asyncio
import logging

import httpx
from bs4 import BeautifulSoup
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from app.scrapers.http_client import SSRFBlockedError, build_async_client
from app.scrapers.supplier_id import pick_supplier_id_from_variants

logger = logging.getLogger(__name__)

PRODUCTS_PAGE_LIMIT = 250


class NotShopifyError(Exception):
    """A loja não expõe /products.json como uma loja Shopify normal."""


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    # 429 (rate limit) não é "não é Shopify" nem "site fora do ar" — é a
    # própria loja pedindo pra esperar um pouco. Visto ao vivo: várias lojas
    # DIFERENTES devolvendo 429 na primeira tentativa de cadastro no mesmo
    # dia, todas com "não é Shopify" errado na tela — o IP do servidor tinha
    # levado rate limit da Shopify por causa do volume de raspagem do dia,
    # não porque cada loja individualmente bloqueou a gente. Sem retry aqui,
    # verify_is_shopify() (Módulo 1, roda ANTES de aceitar o cadastro)
    # desistia na primeira tentativa e classificava a loja errado pra sempre.
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
        return True
    return False


@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=2, min=3, max=40),
    retry=retry_if_exception(_is_retryable),
)
async def _get_products_page(client: httpx.AsyncClient, domain: str, page: int, limit: int) -> list[dict]:
    url = f"https://{domain}/products.json"
    response = await client.get(url, params={"limit": limit, "page": page})
    response.raise_for_status()
    data = response.json()
    products = data.get("products")
    if not isinstance(products, list):
        raise NotShopifyError(f"{domain} não retornou um payload de produtos válido")
    return products


async def verify_is_shopify(domain: str) -> bool:
    """Módulo 1: confirma /products.json antes de aceitar o cadastro do concorrente."""
    try:
        async with await build_async_client(domain) as client:
            await _get_products_page(client, domain, page=1, limit=1)
        return True
    except (httpx.HTTPError, NotShopifyError, ValueError, SSRFBlockedError) as exc:
        logger.info("Domínio %s falhou na verificação Shopify: %s", domain, exc)
        return False


async def fetch_all_products(domain: str, delay_seconds: float = 1.5) -> list[dict]:
    """
    Pagina /products.json até a página vir vazia, com duas proteções:

    1. Rate limit (HTTP 429): a loja está pedindo pra gente parar. Em vez de
       propagar e derrubar a raspagem inteira (ou pior, insistir e piorar o
       bloqueio), paramos aqui e devolvemos o que já foi coletado.
    2. Loja que ignora `?page=N` e sempre devolve a primeira página nunca
       retornaria uma página vazia — sem essa checagem o loop giraria pra
       sempre. Se o primeiro ID da página bater com o da página anterior,
       encerramos.
    """
    all_products: list[dict] = []
    page = 1
    last_page_first_id = None
    async with await build_async_client(domain) as client:
        while True:
            try:
                products = await _get_products_page(client, domain, page=page, limit=PRODUCTS_PAGE_LIMIT)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 429:
                    logger.warning(
                        "%s respondeu 429 (rate limit) na página %d — parando com %d produtos já coletados.",
                        domain,
                        page,
                        len(all_products),
                    )
                    break
                raise

            if not products:
                break
            if products[0].get("id") == last_page_first_id:
                logger.warning(
                    "%s parece ignorar ?page= (página %d repetiu a página anterior) — parando com %d produtos.",
                    domain,
                    page,
                    len(all_products),
                )
                break
            last_page_first_id = products[0].get("id")

            all_products.extend(products)
            if len(products) < PRODUCTS_PAGE_LIMIT:
                break
            page += 1
            await asyncio.sleep(delay_seconds)
    return all_products


async def fetch_homepage_html(domain: str) -> str:
    async with await build_async_client(domain) as client:
        response = await client.get(f"https://{domain}/")
        response.raise_for_status()
        return response.text


def _split_tags(tags) -> list[str]:
    if isinstance(tags, list):
        return tags
    if isinstance(tags, str) and tags:
        return [t.strip() for t in tags.split(",") if t.strip()]
    return []


def normalize_product(raw: dict) -> dict:
    """
    Extrai os campos do Módulo 2.1 a partir do payload bruto de /products.json.

    Nota sobre estoque: o endpoint público normalmente só expõe `available`
    (bool) por variação, não a quantidade exata (`inventory_quantity` é campo
    de admin/app e só aparece se o tema da loja vazar isso). Por isso
    `total_inventory` fica None quando o dado não está presente, em vez de
    assumir zero — seguindo a regra de não mostrar número que não é confiável.

    `supplier_id` aqui é só o palpite a partir do SKU da listagem em massa —
    o barcode real (mais confiável) exige 1 request por produto e só é
    buscado no raio-x (scrapers/supplier_id.py:enrich_with_real_barcodes).
    """
    variants = raw.get("variants") or []
    images = raw.get("images") or []
    prices = [float(v["price"]) for v in variants if v.get("price") not in (None, "")]

    has_inventory_field = any("inventory_quantity" in v for v in variants)
    total_inventory = None
    if has_inventory_field:
        total_inventory = sum(int(v.get("inventory_quantity") or 0) for v in variants)

    return {
        "shopify_product_id": raw.get("id"),
        "title": raw.get("title") or "",
        "handle": raw.get("handle") or "",
        "vendor": raw.get("vendor"),
        "product_type": raw.get("product_type"),
        "tags": _split_tags(raw.get("tags")),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "variant_count": len(variants),
        "image_count": len(images),
        "total_inventory": total_inventory,
        "in_stock_variant_count": sum(1 for v in variants if v.get("available")),
        "main_image_url": images[0]["src"] if images else None,
        "image_urls": [img["src"] for img in images if img.get("src")],
        "supplier_id": pick_supplier_id_from_variants(variants),
        "shopify_created_at": raw.get("created_at"),
        "shopify_updated_at": raw.get("updated_at"),
        "body_html": raw.get("body_html") or "",
        "description_text": _strip_html(raw.get("body_html") or ""),
    }


def _strip_html(html: str, max_length: int = 3000) -> str:
    """Texto puro pra prévia rápida no app — nunca guarda/renderiza o HTML cru
    do concorrente (é dado externo não confiável; já corrigimos um XSS nesse
    projeto por interpolar texto de loja concorrente sem escapar)."""
    if not html:
        return ""
    text = BeautifulSoup(html, "html.parser").get_text(separator=" ", strip=True)
    return text[:max_length]
