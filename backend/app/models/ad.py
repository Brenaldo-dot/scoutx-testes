import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AdPlatform(str, enum.Enum):
    META = "meta"
    TIKTOK = "tiktok"
    GOOGLE = "google"


class AdStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Ad(Base):
    """Anúncio encontrado nas bibliotecas públicas Meta/TikTok (Módulo 4)."""

    __tablename__ = "ads"
    __table_args__ = (
        UniqueConstraint("platform", "external_ad_id", name="uq_ad_platform_external_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)

    platform: Mapped[AdPlatform] = mapped_column(Enum(AdPlatform, native_enum=False))
    external_ad_id: Mapped[str] = mapped_column(String(255), index=True)
    library_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Nome da página anunciante mostrado na biblioteca — pode ser diferente
    # do nome da loja/competitor.name (confirmado ao vivo: uma loja real
    # rodava anúncio sob um nome de página completamente diferente).
    advertiser_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    creative_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    cta: Mapped[str | None] = mapped_column(String(120), nullable=True)
    placements: Mapped[list[str]] = mapped_column(JSON, default=list)
    creative_screenshot_path: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Data real quando dá pra parsear o texto da biblioteca (scrapers/meta_ads.py);
    # senão fica igual a started_at (hora que NÓS vimos o anúncio pela
    # primeira vez). started_at_raw guarda o texto original pra conferência.
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at_raw: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[AdStatus] = mapped_column(Enum(AdStatus, native_enum=False), default=AdStatus.ACTIVE)
    killed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Revisão: achado ao vivo — anúncio real da Meta sumindo do "ativo" só
    # porque uma rodada de scan não achou ele de novo (busca por keyword +
    # scroll limitado, não é 100% determinística — mesma razão que já valia
    # pro Google, ver _mark_killed_ads em services/ads_service.py). Exige 2
    # rodadas seguidas sem ver o anúncio antes de marcar morto; zera assim
    # que ele reaparece.
    missed_scans: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_winning: Mapped[bool] = mapped_column(Boolean, default=False)  # ativo por 7+ dias

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    competitor: Mapped["Competitor"] = relationship(back_populates="ads")
    product: Mapped["Product | None"] = relationship(back_populates="ads")
    snapshots: Mapped[list["AdSnapshot"]] = relationship(
        back_populates="ad", cascade="all, delete-orphan", order_by="AdSnapshot.captured_at"
    )

    @property
    def product_image_url(self) -> str | None:
        # Nenhum scraper de anúncio (Meta/Google/TikTok) consegue capturar o
        # criativo em si (Meta é texto puro, Google fica dentro de um
        # safeframe, TikTok não expõe card por anúncio — ver os 3 módulos em
        # scrapers/) — usa a imagem do PRODUTO vinculado (Product.main_image_url,
        # casado por product_handle) como aproximação visual, pedido do
        # usuário pra não deixar o card de anúncio só com texto.
        return self.product.main_image_url if self.product else None

    @property
    def product_title(self) -> str | None:
        return self.product.title if self.product else None

    @property
    def days_active(self) -> int | None:
        if not self.started_at:
            return None
        # SQLite não preserva tzinfo mesmo em coluna "timezone=True" — volta
        # naive na releitura mesmo pra valor que foi salvo aware (ver mesma
        # nota em utils/date.js do frontend). Sem normalizar os DOIS lados,
        # `killed_at` naive vs `datetime.now(timezone.utc)` aware quebra a
        # subtração assim que o primeiro anúncio é marcado inativo.
        start = self.started_at if self.started_at.tzinfo else self.started_at.replace(tzinfo=timezone.utc)
        if self.killed_at:
            end = self.killed_at if self.killed_at.tzinfo else self.killed_at.replace(tzinfo=timezone.utc)
        else:
            end = datetime.now(timezone.utc)
        return (end - start).days


class AdSnapshot(Base):
    """Estado diário de cada anúncio, usado para medir velocidade de engajamento (Módulo 4.3)."""

    __tablename__ = "ad_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ad_id: Mapped[int] = mapped_column(ForeignKey("ads.id"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    status: Mapped[AdStatus] = mapped_column(Enum(AdStatus, native_enum=False))
    comment_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    ad: Mapped["Ad"] = relationship(back_populates="snapshots")
