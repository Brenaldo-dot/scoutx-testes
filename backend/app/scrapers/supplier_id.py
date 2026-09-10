"""
Módulo 2.5 — identificação do fornecedor real via barcode/SKU.

Portado de uma ferramenta que o usuário já usa em produção
(buscar-barcode-shopify) e adaptado pro resto do pipeline. O campo `vendor`
do Shopify é texto livre que o dropshipper escolhe e pode renomear pra
qualquer coisa; o barcode/SKU da variação, quando o app de importação não
limpa, muitas vezes carrega o código original do fornecedor de import
(AliExpress/1688/etc) — é um sinal mais difícil de mascarar.

Duas fontes, em ordem de confiabilidade:
1. Barcode real do produto — só vem no endpoint individual
   `/products/{handle}.json`, a listagem em massa (`/products.json`) nunca
   inclui esse campo (confirmado ao vivo contra allbirds.com: sempre None).
   Custa 1 request por produto, por isso só roda no raio-x (Módulo 2), não
   no snapshot diário.
2. SKU da listagem em massa — sempre disponível de graça, mas é campo livre:
   às vezes é o código real, às vezes um placeholder tipo "-1" ou "v678".
   Serve de fallback até o raio-x rodar.
"""

import asyncio
import logging
import re

import httpx

from app.scrapers.http_client import build_async_client

logger = logging.getLogger(__name__)

# Se o mesmo "código" (já validado por looks_like_id, então já é numérico)
# aparece em mais produtos diferentes do que isso na mesma loja, não é um
# identificador de verdade — é um placeholder genérico reaproveitado pelo
# app de importação. Testado ao vivo: um cód. real e legítimo compartilhado
# por 8 páginas duplicadas do MESMO produto (mesmo padrão "câmera 1/câmera 2"
# que o clustering quer capturar) quase foi zerado com um limite de 6 — por
# isso o corte é bem mais alto, pra pegar só código genérico de verdade
# repetido em produtos SEM relação nenhuma entre si, não uma família pequena
# de páginas duplicadas.
JUNK_FREQUENCY_THRESHOLD = 15

# Bug real encontrado em produção: loja COD típica tem TODO o catálogo (ou
# quase) vindo de 1-2 fornecedores só — então o cód. de fornecedor REAL se
# repete em dezenas/centenas de produtos, ultrapassando o threshold acima
# folgado. Resultado: o alerta de "fornecedor mudou" nunca disparava, porque
# `filter_junk_supplier_ids` zerava o código de TODO o catálogo, todo santo
# dia, achando que era placeholder — mesmo sendo o identificador real do
# fornecedor único da loja. Fix: um código que cobre a MAIORIA do catálogo
# não é "genérico repetido em produtos sem relação" (o caso que o threshold
# original mirava), é o próprio fornecedor dominante da loja — sinal real,
# não lixo. Só zera quando fica no meio-termo: repete demais pra ser
# coincidência (> threshold) mas NÃO domina o catálogo (não é o fornecedor
# principal da loja).
JUNK_MAJORITY_RATIO = 0.5

# Cód. de fornecedor de verdade é SEMPRE numérico (ex: "37625", "2343") —
# confirmado pelo usuário a partir da própria experiência analisando
# fornecedor manualmente, não suposição nossa. "P2E1", "q4", "CG-0077" etc.
# NÃO são cód. de fornecedor real mesmo parecendo um código — são lixo de
# SKU/variante do app de importação. Hífen só é aceito como separador entre
# grupos de dígito (ex: "556688-2"), nunca junto de letra.
_NUMERIC_ID_RE = re.compile(r"\d+(-\d+)*")

# Mesmo sendo só número, segmento CURTO demais separado por hífen (ex: "-1",
# "02-0", "01-10") é visto ao vivo como placeholder de posição/lote de app de
# importação, não um cód. de fornecedor de verdade.
_NUMERIC_PLACEHOLDER_RE = re.compile(r"-?\d{1,3}(-\d{1,3})*")

ENRICH_CONCURRENCY = 6
ENRICH_CAP = 600


def looks_like_id(value: object) -> bool:
    """Um cód. de fornecedor de verdade é sempre numérico — ver nota acima.
    Espaço quase sempre é descrição digitada no campo errado. Números curtos
    tipo "-1", "0" ou sequências tipo "02-0" são placeholder de posição/lote
    de apps de importação. "null-5", "null-32" etc. (visto ao vivo) são
    artefato de script de import quebrado, não identificador nenhum."""
    if not isinstance(value, str):
        return False
    v = value.strip()
    if not v:
        return False
    if any(ch.isspace() for ch in v):
        return False
    if "null" in v.lower():
        return False
    if not _NUMERIC_ID_RE.fullmatch(v):
        return False
    if _NUMERIC_PLACEHOLDER_RE.fullmatch(v):
        return False
    return True


def pick_supplier_id_from_variants(variants: list[dict] | None) -> str | None:
    """Fallback a partir da listagem em massa: prioriza barcode (raramente
    presente aqui), cai pro SKU."""
    for v in variants or []:
        if looks_like_id(v.get("barcode")):
            return v["barcode"].strip()
    for v in variants or []:
        if looks_like_id(v.get("sku")):
            return v["sku"].strip()
    return None


def filter_junk_supplier_ids(
    products: list[dict], threshold: int = JUNK_FREQUENCY_THRESHOLD, majority_ratio: float = JUNK_MAJORITY_RATIO
) -> None:
    """Modifica `products` in-place: zera supplier_id que se repete demais entre
    produtos SEM relação, mas preserva um código que domina o catálogo — esse
    é o fornecedor principal da loja, não um placeholder (ver JUNK_MAJORITY_RATIO)."""
    freq: dict[str, int] = {}
    for p in products:
        sid = p.get("supplier_id")
        if sid:
            freq[sid] = freq.get(sid, 0) + 1
    majority_floor = len(products) * majority_ratio
    for p in products:
        sid = p.get("supplier_id")
        if sid and freq.get(sid, 0) > threshold and freq[sid] < majority_floor:
            p["supplier_id"] = None


async def _fetch_real_barcode(client: httpx.AsyncClient, domain: str, handle: str) -> str | None:
    try:
        response = await client.get(f"https://{domain}/products/{handle}.json")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    product = data.get("product") if isinstance(data, dict) else None
    if not product:
        return None
    for v in product.get("variants") or []:
        if looks_like_id(v.get("barcode")):
            return v["barcode"].strip()
    return None


async def enrich_with_real_barcodes(
    domain: str,
    products: list[dict],
    concurrency: int = ENRICH_CONCURRENCY,
    cap: int = ENRICH_CAP,
) -> None:
    """
    Busca o barcode real produto a produto (Módulo 2, só no raio-x — é caro
    demais pra rodar todo dia em toda loja). Quando encontrado, substitui o
    supplier_id que já veio do SKU da listagem em massa. Roda com um limite
    de conexões simultâneas pra não sobrecarregar a loja, e para nos
    primeiros `cap` produtos em catálogos muito grandes.
    """
    to_enrich = products[:cap]
    if not to_enrich:
        return

    semaphore = asyncio.Semaphore(concurrency)

    async def _worker(client: httpx.AsyncClient, product: dict) -> None:
        async with semaphore:
            handle = product.get("handle")
            if not handle:
                return
            real_barcode = await _fetch_real_barcode(client, domain, handle)
            if real_barcode:
                product["supplier_id"] = real_barcode

    async with await build_async_client(domain) as client:
        await asyncio.gather(*(_worker(client, p) for p in to_enrich))
