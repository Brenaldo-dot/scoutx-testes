from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserNotificationSettings(Base):
    """Preferências de notificação por usuário (Módulo 9 — Minha Conta).

    Vive no banco do FastAPI, não no Postgres do app Node onde mora
    app_users (mesma limitação de FK entre bancos diferentes já documentada
    em CompetitorTracker.user_id — ver models/competitor.py). user_id é só o
    inteiro cru vindo do header X-User-Id (api/deps.py), sem FK de verdade."""

    __tablename__ = "user_notification_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)
    discord_webhook_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
