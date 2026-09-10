from pydantic import BaseModel, Field


class DiscordWebhookOut(BaseModel):
    discord_webhook_url: str | None


class DiscordWebhookUpdate(BaseModel):
    # Teto generoso de propósito: uma URL de webhook do Discord de verdade
    # tem bem menos que isso (~90 caracteres) — só uma rede de segurança
    # contra mandar um valor gigante sem necessidade (achado em auditoria).
    discord_webhook_url: str | None = Field(default=None, max_length=500)


class ClearDiscordWebhooksPayload(BaseModel):
    user_ids: list[int]
