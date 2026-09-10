"""
Módulo 4.2 — TikTok Creative Center ("Top Ads").

Investigado ao vivo (não só suposto): é uma vitrine curada de anúncios em
destaque, não um índice completo pesquisável como a Meta Ads Library. Busquei
por "shein" — uma das maiores anunciantes do mundo — e voltou 0 resultados,
então a cobertura por palavra-chave/domínio é baixa por natureza da
ferramenta, não por seletor errado. Além disso, boa parte do texto de copy
que aparece nos cards fica GRAVADO NO VÍDEO (legenda embutida no pixel), não
é texto de HTML — não dá pra extrair sem OCR de frame de vídeo, o que está
fora do escopo aqui.

Por isso este scraper é deliberadamente conservador: confirma o estado "sem
resultados" com segurança e, fora isso, só devolve o que consegue achar como
texto de verdade — nunca teor de UI (rótulo de filtro, objetivo de campanha
etc.) fingindo ser anúncio. Prefere devolver lista vazia a inventar dado.
Pra investigar de verdade, use o link direto que a UI oferece (mesma lógica
do botão "Ver anúncios ao vivo" do Meta) — a pessoa navegando manualmente
enxerga o vídeo, que o scraper não consegue "ler".
"""

import logging
from urllib.parse import quote

from playwright.async_api import async_playwright

from app.config import get_settings
from app.scrapers.browser import next_proxy
from app.scrapers.result import ScrapeResult

logger = logging.getLogger(__name__)
settings = get_settings()

CREATIVE_CENTER_URL = "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en"

_NO_RESULTS_MARKERS = ("no search results found", "nenhum resultado", "no se encontraron resultados")


def build_search_url(keyword: str, region: str = "CO") -> str:
    return f"{CREATIVE_CENTER_URL}?keyword={quote(keyword)}&region={region}&period=30"


async def search_ads(keyword: str, region: str = "CO") -> ScrapeResult:
    url = build_search_url(keyword, region)
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            context = await browser.new_context(user_agent=settings.scraper_user_agent, proxy=next_proxy())
            page = await context.new_page()
            try:
                await page.goto(url, timeout=25000, wait_until="networkidle")
                await page.wait_for_timeout(1500)
                body_text = (await page.inner_text("body")).lower()
            finally:
                await context.close()
                await browser.close()
    except Exception as exc:
        # `failed=True` (não lista vazia) — ver docstring de ScrapeResult:
        # falha de rede não pode virar "0 anúncios" pra quem consome isso.
        logger.exception("Falha ao carregar o TikTok Creative Center para keyword=%s", keyword)
        return ScrapeResult(failed=True, error=str(exc))

    if any(marker in body_text for marker in _NO_RESULTS_MARKERS):
        return ScrapeResult(ads=[])

    # Sem um card real e confirmado pra basear um parser (ver nota acima —
    # o texto que importa costuma estar dentro do vídeo, não no DOM), listar
    # 0 aqui é mais honesto que arriscar devolver rótulo de UI como se fosse
    # anúncio. `library_url` fica disponível pra quem quiser abrir e olhar.
    # Isso NÃO é falha (a página carregou e respondeu normalmente) — só não
    # dá pra extrair um card confiável, então `failed` continua False.
    logger.info("TikTok Creative Center respondeu para '%s', mas sem extração de card confiável ainda.", keyword)
    return ScrapeResult(ads=[])
