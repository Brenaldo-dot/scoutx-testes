"""
Módulo 4.1 — Meta Ads Library.

Usa a biblioteca pública de anúncios da Meta (facebook.com/ads/library), que
não exige login e existe justamente para consulta de transparência. A busca
é pelo DOMÍNIO da loja: testado ao vivo contra um domínio real de COD
colombiano, achou os anúncios corretamente mesmo quando o nome da página
anunciante no Facebook era diferente do nome da loja na Shopify — o domínio
é um identificador mais confiável que o nome. A Meta também oferece uma Ad
Library API oficial (precisa de token de desenvolvedor); ela é mais estável
que fazer parsing de página e vale considerar migrar pra ela se isso for
pra produção.

Sobre os seletores: a Ads Library usa nomes de classe CSS ofuscados/gerados
(padrão React/Facebook) que não servem de seletor estável — confirmado
inspecionando a página ao vivo. A extração aqui é baseada em texto: acha o
nó de texto "Identificação da biblioteca"/"Library ID" (todo anúncio tem um)
e sobe pelos ancestrais até o texto parar de crescer sem juntar com o
próximo anúncio — isso sobrevive a mudança de classe CSS, mas ainda depende
do texto da UI, que muda por idioma. Testado ao vivo em português; os
padrões de regex abaixo tentam cobrir português/espanhol/inglês, mas quem
for rodar isso a sério deveria conferir contra o idioma real que aparecer
(depende do locale do navegador, não só do country= da URL).

A lista é virtualizada (carrega mais ao rolar), por isso o loop de scroll.

`started_at`: tenta parsear a data real que a Meta mostra — cobre "Veiculação
iniciada em D de MÊS de AAAA" (português/espanhol) E "Started running on MMM
D, AAAA" (inglês). O segundo formato foi adicionado depois de um bug real
encontrado ao vivo: a Ads Library tava sendo servida em INGLÊS mesmo em
buscas com country=CO/MX (o idioma depende do locale do navegador/proxy, não
do país da busca — já era um risco documentado aqui), então 100% dos
anúncios de produção caíam no fallback de "hora que vimos agora" mesmo tendo
data real de meses atrás — isso zerava sozinho o sinal de "tempo de anúncio
no ar" do score (services/scoring_service.py), que pesa até 60 pontos e
bastava sozinho pra cruzar a faixa "Quente". Quando NENHUM dos dois formatos
bate, fica None e quem chama (services/ads_service.py) cai no fallback de
usar a hora em que NÓS vimos o anúncio pela primeira vez — nunca inventa uma
data. `started_at_raw` sempre guarda o texto original pra quem quiser conferir.
"""

import logging
import re
from datetime import datetime, timezone
from urllib.parse import quote, unquote, urlparse

from playwright.async_api import async_playwright

from app.config import get_settings
from app.scrapers.browser import next_proxy
from app.scrapers.result import ScrapeResult

logger = logging.getLogger(__name__)
settings = get_settings()

LIBRARY_BASE_URL = "https://www.facebook.com/ads/library/"

MAX_ADS_PER_SEARCH = 30
MAX_SCROLL_ROUNDS = 6

_SPONSORED_LABELS = {"patrocinado", "sponsored", "publicidad", "patrocinado por"}

_ID_LABEL_RE = re.compile(r"(?:identifica\w*|library\s*id|id\s*da\s*biblioteca)[^\d]{0,20}(\d{10,20})", re.IGNORECASE)
_STARTED_RE = re.compile(r"iniciad|comenz|empez|running on|started", re.IGNORECASE)

# Formato "D de MÊS de AAAA" (visto ao vivo em português; espanhol usa a
# mesma ordem).
_DATE_PT_ES_RE = re.compile(r"(\d{1,2})\s+de\s+([a-zçé]+)\.?\s+de\s+(\d{4})", re.IGNORECASE)
_MONTHS_PT_ES = {
    "jan": 1, "ene": 1,
    "fev": 2, "feb": 2,
    "mar": 3,
    "abr": 4,
    "mai": 5, "may": 5,
    "jun": 6,
    "jul": 7,
    "ago": 8,
    "set": 9, "sep": 9,
    "out": 10, "oct": 10,
    "nov": 11,
    "dez": 12, "dic": 12,
}

# Formato "Started running on MMM D, AAAA" (inglês) — visto ao vivo sendo o
# idioma REAL servido em produção pra buscas com country=CO e country=MX,
# apesar do país da busca (ver docstring do módulo). Sem isso o parser nunca
# batia com o dado real.
_DATE_EN_RE = re.compile(r"([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})")
_MONTHS_EN = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _parse_started_at(raw_text: str | None) -> datetime | None:
    if not raw_text:
        return None

    match = _DATE_PT_ES_RE.search(raw_text)
    if match:
        day_str, month_str, year_str = match.groups()
        month = _MONTHS_PT_ES.get(month_str.lower()[:3])
        if month:
            try:
                return datetime(int(year_str), month, int(day_str), tzinfo=timezone.utc)
            except ValueError:
                pass

    match = _DATE_EN_RE.search(raw_text)
    if match:
        month_str, day_str, year_str = match.groups()
        month = _MONTHS_EN.get(month_str.lower()[:3])
        if month:
            try:
                return datetime(int(year_str), month, int(day_str), tzinfo=timezone.utc)
            except ValueError:
                pass

    return None

# Roda no contexto da página (Playwright page.evaluate) — por isso é JS, não Python.
# Cada card retorna {text, urls}: `urls` são os links de destino REAIS por
# trás do botão do anúncio (ex: "Comprar agora") — passam pelo redirect da
# própria Meta (l.facebook.com/l.php?u=<destino codificado>) e apontam pra
# URL exata do produto anunciado (ex: .../products/flexair). Confirmado ao
# vivo contra tiendaconfianza.com: 3 anúncios distintos, 3 URLs de produto
# diferentes, extraídas certinho — ver `_extract_product_handle` abaixo.
_EXTRACT_CARDS_JS = """
() => {
  function textOf(node) { return node.innerText || node.textContent || ''; }
  const idPattern = /identifica|library\\s*id/i;

  function destinationUrls(el) {
    const out = [];
    for (const a of el.querySelectorAll('a[href]')) {
      let href = a.href;
      // O redirect da própria Meta (l.facebook.com/l.php?u=<destino>) às
      // vezes vem encadeado (o destino decodificado é OUTRO redirect com seu
      // próprio "u="), então decodifica de novo se ainda sobrar um "u=" —
      // limitado a poucas voltas só por segurança contra loop.
      for (let hop = 0; hop < 3; hop++) {
        const m = href.match(/[?&]u=([^&]+)/);
        if (!m) break;
        try { href = decodeURIComponent(m[1]); } catch (e) { break; }
      }
      if (/\\/(products|pages)\\//.test(href)) out.push(href);
    }
    return out;
  }

  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  const idNodes = [];
  while ((n = tw.nextNode())) {
    if (idPattern.test(n.nodeValue)) idNodes.push(n);
  }

  const cards = [];
  const seen = new Set();
  for (const node of idNodes) {
    let el = node.parentElement;
    if (!el) continue;
    let text = textOf(el);
    // Sobe enquanto o ancestral ainda tiver só 1 "cartão" de anúncio — para
    // um nível antes de juntar com o próximo (sem depender de profundidade
    // fixa, que quebraria se a Meta mudar a estrutura do DOM de novo).
    for (let i = 0; i < 14 && el.parentElement; i++) {
      const parent = el.parentElement;
      const parentText = textOf(parent);
      const idCount = (parentText.match(/identifica|library\\s*id/gi) || []).length;
      if (idCount > 1) break;
      el = parent;
      text = parentText;
    }
    if (!seen.has(text)) {
      seen.add(text);
      cards.push({ text, urls: destinationUrls(el) });
    }
  }
  return cards;
}
"""


def build_search_url(query: str, country: str = "CO") -> str:
    return (
        f"{LIBRARY_BASE_URL}?active_status=active&ad_type=all&country={country}"
        f"&q={quote(query)}&search_type=keyword_unordered"
    )


def build_advertiser_search_url(page_id: str, country: str = "CO") -> str:
    """Busca por página anunciante — mais precisa que por termo quando já se
    conhece o advertiser dono do Pixel ID coletado no Módulo 2.4."""
    return f"{LIBRARY_BASE_URL}?active_status=active&ad_type=all&country={country}&view_all_page_id={page_id}"


def _parse_card_text(text: str, country: str = "CO") -> dict | None:
    id_match = _ID_LABEL_RE.search(text)
    if not id_match:
        return None
    external_id = id_match.group(1)

    lines = [ln.strip() for ln in text.split("\n") if ln.strip() and ln.strip() != "​"]

    started_at_raw = next((ln for ln in lines if _STARTED_RE.search(ln)), None)

    sponsored_idx = next((i for i, ln in enumerate(lines) if ln.strip().lower() in _SPONSORED_LABELS), None)
    advertiser_name = lines[sponsored_idx - 1] if sponsored_idx and sponsored_idx > 0 else None

    creative_text = None
    cta = None
    if sponsored_idx is not None:
        after = lines[sponsored_idx + 1 :]
        if after:
            # A Meta não marca semanticamente qual linha é copy, qual é o
            # domínio mostrado, qual é headline e qual é CTA — só a ordem
            # visual. Aproximação: junta tudo menos a última linha como
            # texto do criativo, e a última como CTA (nem sempre perfeito).
            creative_text = " ".join(after[:-1]) if len(after) > 1 else after[0]
            cta = after[-1] if len(after) > 1 else None

    return {
        "external_ad_id": external_id,
        # Revisão: achado ao vivo — sem `country=`, quem abre esse link vê o
        # país da Ads Library INFERIDO pela localização do PRÓPRIO usuário
        # (não o país que a gente pesquisou), e o anúncio simplesmente não
        # aparece pra quem tá em outro país. `active_status=all` (não só
        # `active`) porque a pessoa pode abrir o link semanas depois do
        # anúncio ter sido pausado — sem isso o link vira uma página vazia
        # mesmo estando correto.
        "library_url": f"{LIBRARY_BASE_URL}?active_status=all&ad_type=all&country={country}&id={external_id}",
        "creative_text": creative_text,
        "started_at_raw": started_at_raw,
        "started_at": _parse_started_at(started_at_raw),
        "cta": cta,
        "advertiser_name": advertiser_name,
    }


# Revisão: achado ao vivo — "SOPLADOR DE AIRE INALAMBRICO" (compralinea.com.mx)
# tinha 5 anúncios reais apontando pra mesma página, e só 2 batiam aqui. Dois
# ajustes: aceita também subdomínio (tienda.loja.com) e o espelho Shopify
# (loja.myshopify.com) — bem comum em anúncio de COD linkar direto pro
# myshopify em vez do domínio próprio — e não fica só em /products/, um
# anúncio pode linkar uma página de oferta/funil (/pages/...) que aponta pro
# mesmo produto.
_PRODUCT_HANDLE_RE = re.compile(r"/(?:products|pages)/([^/?#]+)", re.IGNORECASE)


def _extract_product_handle(urls: list[str], domain: str) -> str | None:
    """
    Match de produto por handle da URL de destino do anúncio — bem mais
    confiável que tentar casar texto de criativo contra título salvo (testado
    ao vivo: buscar pelo TÍTULO do produto na Ads Library retorna 0
    resultados sempre, porque o texto do anúncio é copy de venda, não repete
    o título da página; ver docstring de `_EXTRACT_CARDS_JS`).

    Só aceita URL do PRÓPRIO domínio da loja (ou subdomínio/espelho
    myshopify dele) — um anúncio pode ter outros links (Instagram, WhatsApp)
    que não devem virar match nenhum.
    """
    domain_lower = domain.lower().removeprefix("www.")
    shop_name = domain_lower.split(".")[0]
    for url in urls:
        parsed = urlparse(url)
        host = parsed.netloc.lower().removeprefix("www.")
        is_same_store = (
            host == domain_lower or host.endswith(f".{domain_lower}") or host == f"{shop_name}.myshopify.com"
        )
        if not is_same_store:
            continue
        match = _PRODUCT_HANDLE_RE.search(parsed.path)
        if match:
            return unquote(match.group(1)).strip().lower()
    return None


def _filter_by_advertisers(results: list[dict], allowed_advertisers: set[str]) -> list[dict]:
    return [r for r in results if r.get("advertiser_name") in allowed_advertisers]


def _confirmed_advertisers_by_domain_mention(results: list[dict], domain: str) -> set[str]:
    """
    A busca por domínio na Ads Library é keyword search "solto"
    (search_type=keyword_unordered) — testado ao vivo contra tiendaconfianza.
    com: voltou anúncio de "Honex" (anti-ronco), "American Health Support
    Community" (remédio de pressão), "Target" (sorteio de giftcard) e outros
    anunciantes sem NENHUMA relação com a loja, misturados com o anunciante
    real ("Tienda Confianza") — provavelmente correspondência frouxa da
    própria busca da Meta, não erro do parser.

    Sinal de confiança usado aqui: se PELO MENOS UM anúncio de um anunciante
    menciona o domínio buscado em algum lugar do texto do criativo, os outros
    anúncios do MESMO anunciante entram também — mesmo que a peça
    individual não cite (testado ao vivo: "Emma Perez", anunciante real de
    Velmora, tem 4 criativos e só 1 deles cita o domínio). Anunciante que
    NUNCA cita em nenhum criativo é descartado por inteiro.

    Sinal FRACO por natureza: cobre só o caso em que o copy do anúncio cita a
    URL crua. Testado ao vivo contra velmoratienda.shop: nenhum dos anúncios
    reais da loja cita "velmoratienda.shop" no texto — o copy usa o nome da
    marca ("Tienda Velmora"), nunca a URL. Sozinho, esse sinal filtra 100% dos
    anúncios reais pra fora (0 resultados, mesmo com a loja anunciando ativamente
    — ver `_confirmed_advertisers_by_landing_page` abaixo pro sinal forte).
    """
    domain_lower = domain.lower()
    return {
        r["advertiser_name"]
        for r in results
        if r.get("advertiser_name") and domain_lower in (r.get("creative_text") or "").lower()
    }


def _confirmed_advertisers_by_landing_page(results: list[dict]) -> set[str]:
    """
    Sinal FORTE de confirmação: `product_handle` só fica preenchido quando
    `_extract_product_handle` achou, entre os links reais do anúncio, uma URL
    de destino cujo host bate EXATAMENTE com o domínio da loja (verify_domain)
    — ver `_extract_product_handle` acima. Isso é o botão "Comprar agora" do
    próprio anúncio apontando pra loja, não texto solto — muito mais
    confiável que procurar a URL escrita na copy (`_confirmed_advertisers_by_
    domain_mention`), que a maioria dos anúncios reais nunca faz (testado ao
    vivo, ver docstring acima). Combinar os dois sinais (união) evita falso
    negativo sem abrir mão do filtro contra anunciante não relacionado — quem
    não bate em NENHUM dos dois continua descartado.
    """
    return {r["advertiser_name"] for r in results if r.get("advertiser_name") and r.get("product_handle")}


async def search_ads(
    query: str,
    country: str = "CO",
    max_ads: int = MAX_ADS_PER_SEARCH,
    verify_domain: str | None = None,
) -> ScrapeResult:
    url = build_search_url(query, country)
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
        # `failed=True` (não lista vazia) — ver docstring de ScrapeResult:
        # falha de rede não pode virar "0 anúncios" pra quem consome isso.
        logger.exception("Falha ao carregar a Meta Ads Library para query=%s", query)
        return ScrapeResult(failed=True, error=str(exc))

    results = []
    for card in cards_raw[:max_ads]:
        parsed = _parse_card_text(card["text"], country)
        if parsed:
            # Handle do produto (match exato contra Product.handle) só faz
            # sentido quando sabemos QUAL domínio é da loja — sem isso não
            # tem contra o que validar a URL de destino.
            parsed["product_handle"] = _extract_product_handle(card["urls"], verify_domain) if verify_domain else None
            results.append(parsed)

    if verify_domain:
        confirmed = _confirmed_advertisers_by_domain_mention(results, verify_domain) | _confirmed_advertisers_by_landing_page(
            results
        )
        results = _filter_by_advertisers(results, confirmed)

    return ScrapeResult(ads=results)
