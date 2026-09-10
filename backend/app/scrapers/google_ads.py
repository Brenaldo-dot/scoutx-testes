"""
Módulo 4.4 — Google Ads Transparency Center (adstransparency.google.com).

Cobre Colômbia — testado ao vivo, diferente do TikTok (scrapers/tiktok_ads.py),
que só cobre países da União Europeia por exigência regulatória (DSA); o
seletor de região do Google tem "Colômbia" na lista. Busca por DOMÍNIO na aba
"Por domínio" da própria ferramenta — testado ao vivo contra
velmoratienda.shop: buscar pelo NOME do anunciante não achou nada, buscar
pelo domínio achou ~6 mil anúncios (mesma lição já registrada em meta_ads.py:
domínio é mais confiável que nome).

Texto do criativo (a copy do anúncio) fica dentro de um iframe "safeframe" do
Google (tpc.googlesyndication.com) que só tem o vídeo/imagem renderizado —
testado ao vivo (extração de texto do frame voltou vazia mesmo depois de
esperar carregar). Mesma limitação já documentada em tiktok_ads.py: o texto
que importa é parte do criativo (vídeo/imagem), não HTML de verdade. Por isso
`creative_text` fica None aqui — nome do anunciante (classe CSS estável
`.advertiser-name`, não ofuscada) e o link direto pra biblioteca (que mostra
o criativo de verdade) são o que dá pra confirmar com segurança.

A página inicial de busca por domínio só expõe um card "prioritário" por
anunciante (poucas unidades, mesmo quando o total anunciado é milhares) — pra
ver todos os criativos de um anunciante específico seria preciso entrar na
página `/advertiser/{id}` dele, que não é o que este scraper tenta fazer;
`domain_library_url` fica disponível pra quem quiser abrir e ver tudo.

`started_at`: a ferramenta só mostra "Última exibição" (quando foi visto por
ÚLTIMO), nunca quando começou — diferente da Meta. Usar isso como data de
início seria inventar dado, então fica sempre None aqui; quem chama
(services/ads_service.py) cai no fallback de usar a hora em que NÓS vimos o
anúncio pela primeira vez.
"""

import logging
import re
from urllib.parse import quote

from playwright.async_api import async_playwright

from app.config import get_settings
from app.scrapers.browser import next_proxy
from app.scrapers.result import ScrapeResult

logger = logging.getLogger(__name__)
settings = get_settings()

TRANSPARENCY_BASE_URL = "https://adstransparency.google.com/"

MAX_ADS_PER_SEARCH = 30
MAX_SCROLL_ROUNDS = 4

_CREATIVE_HREF_RE = re.compile(r"advertiser/([^/]+)/creative/([^?]+)")

# Roda no contexto da página (Playwright page.evaluate) — por isso é JS, não Python.
_EXTRACT_CARDS_JS = """
() => {
  const links = [...document.querySelectorAll('a[href*="/creative/"]')];
  const seen = new Set();
  const out = [];
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const card = a.closest('creative-preview');
    const nameEl = card ? card.querySelector('.advertiser-name') : null;
    out.push({
      href,
      advertiserName: nameEl ? nameEl.textContent.trim() : null,
      verified: !!(nameEl && nameEl.className.includes('verified')),
    });
  }
  return out;
}
"""


def build_search_url(domain: str, region: str = "CO") -> str:
    return f"{TRANSPARENCY_BASE_URL}?region={region}&domain={quote(domain)}"


def _parse_card(raw: dict, region: str) -> dict | None:
    match = _CREATIVE_HREF_RE.search(raw.get("href") or "")
    if not match:
        return None
    advertiser_id, creative_id = match.groups()
    return {
        "external_ad_id": f"{advertiser_id}:{creative_id}",
        "library_url": f"{TRANSPARENCY_BASE_URL}advertiser/{advertiser_id}/creative/{creative_id}?region={region}",
        "creative_text": None,
        "started_at_raw": None,
        "started_at": None,
        "cta": None,
        "advertiser_name": raw.get("advertiserName"),
    }


async def search_ads(domain: str, region: str = "CO", max_ads: int = MAX_ADS_PER_SEARCH) -> ScrapeResult:
    url = build_search_url(domain, region)
    cards_raw: list[dict] = []

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=settings.scraper_user_agent,
                proxy=next_proxy(),
                viewport={"width": 1366, "height": 900},
            )
            page = await context.new_page()
            try:
                await page.goto(url, timeout=25000, wait_until="networkidle")
                await page.wait_for_timeout(1500)

                stable_rounds = 0
                for _ in range(MAX_SCROLL_ROUNDS):
                    extracted = await page.evaluate(_EXTRACT_CARDS_JS)
                    stable_rounds = stable_rounds + 1 if len(extracted) <= len(cards_raw) else 0
                    cards_raw = extracted
                    if stable_rounds >= 2 or len(cards_raw) >= max_ads:
                        break
                    await page.mouse.wheel(0, 2500)
                    await page.wait_for_timeout(1200)
            finally:
                await context.close()
                await browser.close()
    except Exception as exc:
        # `failed=True` (não lista vazia) — visto ao vivo: um timeout aqui
        # virava "0 anúncios" pra loja que tinha 4 ativos confirmados minutos
        # antes por outra tela. Ver docstring de ScrapeResult.
        logger.exception("Falha ao carregar o Google Ads Transparency Center para domain=%s", domain)
        return ScrapeResult(failed=True, error=str(exc))

    results = []
    seen_ids: set[str] = set()
    for raw in cards_raw[:max_ads]:
        parsed = _parse_card(raw, region)
        if parsed and parsed["external_ad_id"] not in seen_ids:
            seen_ids.add(parsed["external_ad_id"])
            results.append(parsed)
    return ScrapeResult(ads=results)
