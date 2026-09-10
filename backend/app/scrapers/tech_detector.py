"""Módulo 2.4 — detecção de stack tecnológica a partir do HTML público da loja."""

import re

TECH_SIGNATURES: dict[str, list[str]] = {
    "Meta Pixel": ["fbq(", "connect.facebook.net", "facebook.com/tr"],
    "TikTok Pixel": ["ttq.", "analytics.tiktok.com"],
    "Google Ads": ["gtag(", "googletagmanager.com", "google-analytics.com"],
    "Loox Reviews": ["loox.io", "loox-widget"],
    "Judge.me Reviews": ["judge.me", "judgeme"],
    "Klaviyo": ["klaviyo.com"],
    "Zipify": ["zipify"],
    "ReConvert": ["reconvert"],
    "Vitals": ["vitals.com"],
    "PageFly": ["pagefly"],
    "GemPages": ["gempages"],
}

# Extrai o ID quando o sinal encontrado permite (o pixel do Meta é o mais
# valioso: dá pra cruzar com a Meta Ads Library por advertiser/pixel).
_ID_EXTRACTORS: dict[str, re.Pattern] = {
    "Meta Pixel": re.compile(r"fbq\(\s*['\"]init['\"]\s*,\s*['\"](\d{10,20})['\"]"),
    "TikTok Pixel": re.compile(r"ttq\.load\(\s*['\"]([A-Za-z0-9]{10,30})['\"]"),
    "Google Ads": re.compile(r"(AW-\d{9,12})"),
}


def detect_tech_stack(html: str) -> list[dict]:
    """Retorna [{"name": ..., "external_id": ... | None}] para cada tecnologia encontrada."""
    if not html:
        return []
    lowered = html.lower()
    findings = []
    for name, signatures in TECH_SIGNATURES.items():
        if not any(sig.lower() in lowered for sig in signatures):
            continue
        external_id = None
        extractor = _ID_EXTRACTORS.get(name)
        if extractor:
            match = extractor.search(html)
            if match:
                external_id = match.group(1)
        findings.append({"name": name, "external_id": external_id})
    return findings
