from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TechStack(Base):
    """Pixels e apps detectados por loja (Módulo 2.4)."""

    __tablename__ = "tech_stack"
    __table_args__ = (
        UniqueConstraint("competitor_id", "name", "external_id", name="uq_tech_per_competitor"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)

    name: Mapped[str] = mapped_column(String(120))  # ex: "Meta Pixel", "Loox Reviews"
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)  # pixel/tag ID extraído

    first_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    competitor: Mapped["Competitor"] = relationship(back_populates="tech_stack")
