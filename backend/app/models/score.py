from datetime import date as date_
from datetime import datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, JSON, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ProductScore(Base):
    """Score diário 0-100 por produto, derivado dos sinais de escala (Módulo 3.3)."""

    __tablename__ = "product_scores"
    __table_args__ = (UniqueConstraint("product_id", "date", name="uq_score_per_day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    date: Mapped[date_] = mapped_column(Date, index=True)

    score: Mapped[int] = mapped_column(Integer)  # 0-100
    signals: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Quantos anúncios ativos vinculados a este produto nesse dia — histórico
    # dia a dia disso é o que permite detectar tendência de crescimento
    # (services/scoring_service.py:_ad_count_growing), não o valor isolado.
    active_ad_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    product: Mapped["Product"] = relationship(back_populates="scores")
