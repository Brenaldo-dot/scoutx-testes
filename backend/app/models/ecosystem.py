from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class EcosystemEntry(Base):
    """Mapa fornecedor -> produto -> loja (Módulo 2.5), usado para achar o mesmo
    fornecedor/agente vendendo através de múltiplas lojas concorrentes."""

    __tablename__ = "ecosystem_map"
    __table_args__ = (UniqueConstraint("vendor", "product_id", name="uq_ecosystem_entry"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    vendor: Mapped[str] = mapped_column(String(255), index=True)
    # ondelete="CASCADE": essa tabela não tem relationship nenhuma vindo de
    # Product/Competitor (só o sentido inverso, EcosystemEntry -> Product),
    # então o ORM nunca vê essas linhas pra apagar em cascata sozinho —
    # confirmado ao vivo: excluir um concorrente com produto com `vendor`
    # preenchido (a maioria) quebrava com ForeignKeyViolation em
    # ecosystem_map. Sem relationship bidirecional pra manter, a garantia
    # tem que vir do próprio banco.
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id", ondelete="CASCADE"), index=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    product: Mapped["Product"] = relationship()
    competitor: Mapped["Competitor"] = relationship()
