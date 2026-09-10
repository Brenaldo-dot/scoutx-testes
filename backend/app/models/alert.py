import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, JSON, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AlertType(str, enum.Enum):
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
    DUPLICATE_DETECTED = "duplicate_detected"
    SCALING_DETECTED = "scaling_detected"
    NEW_AD = "new_ad"
    WINNING_AD = "winning_ad"
    AD_KILLED = "ad_killed"
    NOT_SHOPIFY = "not_shopify"


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    ad_id: Mapped[int | None] = mapped_column(ForeignKey("ads.id"), nullable=True)

    alert_type: Mapped[AlertType] = mapped_column(Enum(AlertType, native_enum=False), index=True)
    message: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # sent_to_telegram: mantido pra não quebrar linha antiga (canal trocado
    # pra Discord — ver notifications/discord.py — fica sempre False daqui
    # pra frente, campo não é mais escrito).
    sent_to_telegram: Mapped[bool] = mapped_column(Boolean, default=False)
    sent_to_discord: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    competitor: Mapped["Competitor"] = relationship(back_populates="alerts")
    ad: Mapped["Ad | None"] = relationship()
    product: Mapped["Product | None"] = relationship()

    @property
    def ad_library_url(self) -> str | None:
        return self.ad.library_url if self.ad else None

    @property
    def product_url(self) -> str | None:
        # Link direto pro produto na loja de verdade — usuário pediu depois
        # de ver alerta de "duplicado"/"preço mudou" sem jeito nenhum de
        # abrir o produto sem ir catar na aba Produtos manualmente.
        if not self.product:
            return None
        return f"https://{self.competitor.domain}/products/{self.product.handle}"

    @property
    def product_image_url(self) -> str | None:
        # Pra deixar o feed de alertas mais vivo (pedido do usuário) — a
        # imagem já vem raspada em Product.main_image_url, só faltava expor
        # aqui pro AlertOut alcançar.
        return self.product.main_image_url if self.product else None

    @property
    def product_title(self) -> str | None:
        # Usuário pediu um botão que leva pra aba Produtos já pesquisando
        # esse nome — pra comparar em quantas lojas o mesmo produto aparece
        # e se tá escalando em alguma delas. Precisa do título estruturado
        # (não dava pra confiar em extrair de dentro do texto da mensagem,
        # que muda de formato por tipo de alerta).
        return self.product.title if self.product else None

    @property
    def competitor_name(self) -> str:
        # Estruturado, não texto embutido na mensagem — usuário pediu a loja
        # visível em TODO alerta; confiar em cada f-string mencionar a loja
        # manualmente já causou 3 alertas saindo sem isso (variations_added,
        # new_ad, scaling_detected). Aqui não tem como esquecer.
        return self.competitor.name
