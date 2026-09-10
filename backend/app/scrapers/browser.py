"""
Helper de renderização via Playwright.

Escopo deliberado: só carrega páginas públicas — vitrine Shopify e as
bibliotecas públicas de anúncios (Meta Ads Library, TikTok Creative Center).
O proxy por chamada existe para distribuir carga entre muitas lojas/consultas
por dia, não para burlar autenticação. Não usa plugins de 'stealth'/evasão de
fingerprint nem tenta alcançar áreas autenticadas de terceiros (ex: /orders,
área de cliente logado). Ver README para o racional completo.
"""

import itertools
import logging

from playwright.async_api import Browser, async_playwright

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()
_proxy_cycle = itertools.cycle(settings.proxy_list) if settings.proxy_list else None


def next_proxy() -> dict | None:
    if not _proxy_cycle:
        return None
    return {"server": next(_proxy_cycle)}


async def fetch_rendered_html(url: str, wait_selector: str | None = None, timeout_ms: int = 20000) -> str:
    async with async_playwright() as pw:
        browser: Browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=settings.scraper_user_agent,
            proxy=next_proxy(),
            viewport={"width": 1366, "height": 900},
        )
        page = await context.new_page()
        try:
            await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            if wait_selector:
                await page.wait_for_selector(wait_selector, timeout=timeout_ms)
            else:
                await page.wait_for_timeout(1500)
            return await page.content()
        finally:
            await context.close()
            await browser.close()


async def screenshot_element(url: str, selector: str, out_path: str, timeout_ms: int = 20000) -> bool:
    """Módulo 4.4 — salva o print de um anúncio vencedor para a biblioteca de criativos."""
    async with async_playwright() as pw:
        browser: Browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=settings.scraper_user_agent, proxy=next_proxy())
        page = await context.new_page()
        try:
            await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            locator = page.locator(selector).first
            await locator.wait_for(timeout=timeout_ms)
            await locator.screenshot(path=out_path)
            return True
        except Exception:
            logger.exception("Falha ao capturar screenshot de anúncio: %s", url)
            return False
        finally:
            await context.close()
            await browser.close()
