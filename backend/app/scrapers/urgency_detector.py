"""
Módulo 3.1 — detecção de copy de urgência/escassez.

Roda em cima do `body_html` que já vem no payload público de /products.json
(não precisa de request extra). As lojas monitoradas vendem para a Colômbia,
então os padrões cobrem espanhol; ajuste a lista conforme for observando o
copy real das lojas monitoradas.
"""

import re

URGENCY_PATTERNS = [
    re.compile(r"quedan\s+\d+", re.IGNORECASE),
    re.compile(r"solo\s+quedan", re.IGNORECASE),
    re.compile(r"\bpocas\s+unidades\b", re.IGNORECASE),
    re.compile(r"stock\s+limitado", re.IGNORECASE),
    re.compile(r"\<?ltimas?\s+\d+\s+unidades?", re.IGNORECASE),
    re.compile(r"\boferta\s+termina\b", re.IGNORECASE),
    re.compile(r"\bse\s+agota\b", re.IGNORECASE),
    re.compile(r"envío\s+gratis\s+hoy", re.IGNORECASE),
]


def detect_urgency_copy(text: str) -> bool:
    if not text:
        return False
    return any(pattern.search(text) for pattern in URGENCY_PATTERNS)
