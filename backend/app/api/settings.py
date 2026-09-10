"""Módulo 9 — Minha Conta: preferências pessoais (hoje só notificação Discord)."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, get_current_user
from app.database import get_db
from app.models import UserNotificationSettings
from app.notifications import discord
from app.schemas.settings import ClearDiscordWebhooksPayload, DiscordWebhookOut, DiscordWebhookUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])

_VALID_PREFIXES = ("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/")

_DISCORD_PRO_ONLY_MESSAGE = (
    "Alertas no Discord são exclusivos do plano Pro, assine o Pro pra habilitar essa notificação."
)


def _get_or_none(db: Session, user_id: int) -> UserNotificationSettings | None:
    return db.query(UserNotificationSettings).filter(UserNotificationSettings.user_id == user_id).first()


@router.get("/discord", response_model=DiscordWebhookOut)
def get_discord_webhook(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    row = _get_or_none(db, current_user.id)
    return DiscordWebhookOut(discord_webhook_url=row.discord_webhook_url if row else None)


@router.put("/discord", response_model=DiscordWebhookOut)
def set_discord_webhook(
    payload: DiscordWebhookUpdate, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    url = payload.discord_webhook_url.strip() if payload.discord_webhook_url else None
    # Plano Standard só pode LIMPAR o campo (url=None) — nunca CONFIGURAR um
    # webhook novo. Deixamos o GET/DELETE liberados (a pessoa continua vendo
    # a tela e pode remover um webhook antigo de quando estava no Pro), só o
    # "habilitar de verdade" é bloqueado aqui, ponto único de escrita.
    if url and current_user.is_standard_plan:
        raise HTTPException(403, _DISCORD_PRO_ONLY_MESSAGE)
    if url and not url.startswith(_VALID_PREFIXES):
        raise HTTPException(400, "Isso não parece uma URL de webhook do Discord válida (precisa começar com https://discord.com/api/webhooks/...).")

    row = _get_or_none(db, current_user.id)
    if row is None:
        row = UserNotificationSettings(user_id=current_user.id, discord_webhook_url=url)
        db.add(row)
    else:
        row.discord_webhook_url = url
    db.commit()
    return DiscordWebhookOut(discord_webhook_url=url)


@router.delete("/discord", response_model=DiscordWebhookOut)
def remove_discord_webhook(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    row = _get_or_none(db, current_user.id)
    if row:
        row.discord_webhook_url = None
        db.commit()
    return DiscordWebhookOut(discord_webhook_url=None)


@router.post("/discord/test")
async def test_discord_webhook(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    if current_user.is_standard_plan:
        raise HTTPException(403, _DISCORD_PRO_ONLY_MESSAGE)
    row = _get_or_none(db, current_user.id)
    if not row or not row.discord_webhook_url:
        raise HTTPException(400, "Configure e salve o webhook do Discord antes de testar.")
    ok = await discord.send_test(row.discord_webhook_url)
    if not ok:
        raise HTTPException(502, "Não consegui enviar pro Discord, confira se a URL do webhook ainda é válida (ela pode ter sido apagada no servidor).")
    return {"ok": True}


@router.post("/discord/clear-for-users", status_code=204)
def clear_discord_webhooks_for_users(
    payload: ClearDiscordWebhooksPayload,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Achado em auditoria: PUT /discord bloqueia SALVAR um webhook novo no
    plano Standard, mas quem já tinha configurado um no Pro e a organização
    é rebaixada continuava recebendo alerta de graça pra sempre (create_alert
    em alert_service.py nunca reconfere o plano no momento de enviar, só a
    tela de configuração confere no momento de salvar). Chamado pelo Node
    (server.js) logo que um PATCH de organização muda o plano PRA Standard,
    com a lista de membros dessa organização — admin-only, mesmo padrão de
    confiança do resto do X-Internal-Secret (ver deps.py)."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem fazer isso.")
    if not payload.user_ids:
        return
    db.query(UserNotificationSettings).filter(
        UserNotificationSettings.user_id.in_(payload.user_ids),
    ).update({"discord_webhook_url": None}, synchronize_session=False)
    db.commit()
