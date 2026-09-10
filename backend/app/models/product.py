import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ProductEventType(str, enum.Enum):
    NEW_PRODUCT = "new_product"
    PRODUCT_REMOVED = "product_removed"
    PRICE_CHANGE = "price_change"
    STOCK_CHANGE = "stock_change"
    VARIATIONS_ADDED = "variations_added"
    TITLE_CHANGE = "title_change"
    IMAGE_CHANGE = "image_change"
    URGENCY_DETECTED = "urgency_detected"
    VENDOR_CHANGED = "vendor_changed"
    SUPPLIER_ID_CHANGED = "supplier_id_changed"


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("competitor_id", "shopify_product_id", name="uq_product_per_competitor"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)

    # BigInteger: os IDs internos de produto do Shopify já passam de 17 dígitos
    # (ex: 15979208769617) — INTEGER comum (~2,1 bilhões de limite) estoura e
    # derruba o INSERT inteiro em lote (visto ao vivo salvando o catálogo real
    # da velmoratienda.shop: 0 de 233 produtos gravados, erro silencioso pro
    # usuário — só "0 produtos" na tela, sem dizer por quê).
    shopify_product_id: Mapped[int] = mapped_column(BigInteger, index=True)
    title: Mapped[str] = mapped_column(String(500))
    handle: Mapped[str] = mapped_column(String(500))
    vendor: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    # Código de barras/SKU real do fornecedor de import (Módulo 2.5) — mais
    # difícil de mascarar que `vendor`, que é texto livre. Ver scrapers/supplier_id.py.
    supplier_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    product_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)

    price_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    variant_count: Mapped[int] = mapped_column(Integer, default=0)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    total_inventory: Mapped[int | None] = mapped_column(Integer, nullable=True)
    main_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Todas as imagens (não só a principal) e descrição em TEXTO PURO — nunca
    # HTML cru do concorrente, pra não abrir XSS de novo renderizando isso no
    # front. Usado na prévia rápida (scroll de verdade sem depender da loja
    # deixar carregar em iframe, que o Shopify bloqueia por padrão).
    image_urls: Mapped[list[str]] = mapped_column(JSON, default=list)
    description_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    shopify_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    shopify_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Módulo 2.2 — agrupamento de páginas duplicadas (scrapers/duplicate_detector.py).
    # duplicated é derivado (duplicate_count > 0), mantido pra não quebrar o
    # sinal binário que scoring_service já consome.
    duplicated: Mapped[bool] = mapped_column(Boolean, default=False)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_of: Mapped[list[dict]] = mapped_column(JSON, default=list)
    scaling: Mapped[bool] = mapped_column(Boolean, default=False)  # Módulo 3.3

    competitor: Mapped["Competitor"] = relationship(back_populates="products")
    snapshots: Mapped[list["ProductSnapshot"]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="ProductSnapshot.captured_at"
    )
    events: Mapped[list["ProductEvent"]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="ProductEvent.created_at"
    )
    scores: Mapped[list["ProductScore"]] = relationship(back_populates="product", cascade="all, delete-orphan")
    ads: Mapped[list["Ad"]] = relationship(back_populates="product")


class ProductSnapshot(Base):
    """Foto diária de um produto (Módulo 3.1)."""

    __tablename__ = "product_snapshots"
    __table_args__ = (Index("ix_product_snapshots_product_captured", "product_id", "captured_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    title: Mapped[str] = mapped_column(String(500))
    vendor: Mapped[str | None] = mapped_column(String(255), nullable=True)
    price_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    variant_count: Mapped[int] = mapped_column(Integer, default=0)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    total_inventory: Mapped[int | None] = mapped_column(Integer, nullable=True)
    main_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    has_urgency_copy: Mapped[bool] = mapped_column(Boolean, default=False)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    product: Mapped["Product"] = relationship(back_populates="snapshots")


class ProductEvent(Base):
    """Evento detectado ao comparar dois snapshots consecutivos (Módulo 3.1)."""

    __tablename__ = "product_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    event_type: Mapped[ProductEventType] = mapped_column(Enum(ProductEventType, native_enum=False), index=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    product: Mapped["Product"] = relationship(back_populates="events")
