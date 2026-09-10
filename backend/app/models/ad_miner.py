"""Módulo 5 — Minerador de Anúncios: consulta avulsa (sem cadastrar concorrente).

Diferente de `Competitor`/`Ad` (Módulo 4, monitoramento contínuo de loja já
cadastrada), isto é uma busca pontual: cola uma URL, escaneia as bibliotecas
públicas na hora e guarda só o resultado dessa consulta — sem histórico
diário, sem alerta, sem duplicar a lógica de ingest_search_results.
"""

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AdMinerScanStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class AdMinerScan(Base):
    __tablename__ = "ad_miner_scans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Revisão de segurança: sem isso, GET /scans/{id} não tinha como saber de
    # quem era cada scan — qualquer usuário logado lia o resultado (domínio +
    # anúncios encontrados) de scan de OUTRA organização só incrementando o
    # id (sequencial). id de app_users (banco do app Node) — mesma limitação
    # de FK entre bancos diferentes de CompetitorTracker.user_id acima.
    # Nullable só pelos registros que já existiam antes desse campo existir
    # (ninguém sabe de quem eram); esses ficam visíveis só pra admin.
    user_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    domain: Mapped[str] = mapped_column(String(255), index=True)
    # Define o país da biblioteca de anúncios buscada (ver
    # services/competitor_service.py:country_for_operation) — sem isso, todo
    # scan avulso rodava sempre em "CO" mesmo pra loja mexicana.
    operation: Mapped[str] = mapped_column(String(50), default="colombia", nullable=False)
    status: Mapped[AdMinerScanStatus] = mapped_column(
        Enum(AdMinerScanStatus, native_enum=False), default=AdMinerScanStatus.PENDING
    )
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
