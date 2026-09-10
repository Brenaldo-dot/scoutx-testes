import enum
from datetime import date as date_
from datetime import datetime

from sqlalchemy import Date, DateTime, Enum, Float, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class VolumeMethod(str, enum.Enum):
    INVENTORY_DELTA = "inventory_delta"
    SEQUENTIAL_ID = "sequential_id"


class VolumeStatus(str, enum.Enum):
    READY = "ready"
    AWAITING_SECOND_POINT = "awaiting_second_point"


class DailyVolume(Base):
    """
    Estimativa de volume diário (Módulo 3.2).

    Deliberadamente NÃO implementa 'order_probes' (pedidos-teste) nem leitura
    de /orders: os dois métodos aqui (queda de estoque e ID sequencial de
    produto) usam apenas dado já público do catálogo. Nunca é gerado a partir
    de um único ponto de dado — ver VolumeStatus.AWAITING_SECOND_POINT.
    """

    __tablename__ = "daily_volume"
    __table_args__ = (UniqueConstraint("competitor_id", "date", name="uq_volume_per_day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)
    date: Mapped[date_] = mapped_column(Date, index=True)

    estimated_orders: Mapped[int | None] = mapped_column(Integer, nullable=True)
    method: Mapped[VolumeMethod | None] = mapped_column(Enum(VolumeMethod, native_enum=False), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-1
    status: Mapped[VolumeStatus] = mapped_column(
        Enum(VolumeStatus, native_enum=False), default=VolumeStatus.AWAITING_SECOND_POINT
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    competitor: Mapped["Competitor"] = relationship(back_populates="daily_volumes")
