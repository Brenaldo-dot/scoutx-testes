"""Envio de alertas via Telegram Bot API."""

import logging

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE = "https://api.telegram.org"


def is_configured() -> bool:
    settings = get_settings()
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


async def send_message(text: str) -> bool:
    settings = get_settings()
    if not is_configured():
        logger.warning(
            "Telegram não configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes); alerta não enviado."
        )
        return False

    url = f"{TELEGRAM_API_BASE}/bot{settings.telegram_bot_token}/sendMessage"
    payload = {
        "chat_id": settings.telegram_chat_id,
        # Texto puro de propósito: o conteúdo interpolado nas mensagens (título
        # de produto, nome de vendor) vem de lojas concorrentes, ou seja, é
        # dado não confiável. Sem parse_mode, o Telegram trata tudo como
        # literal em vez de tentar interpretar marcação.
        "text": text,
        "disable_web_page_preview": True,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return True
        except httpx.HTTPError:
            logger.exception("Falha ao enviar alerta para o Telegram")
            return False
