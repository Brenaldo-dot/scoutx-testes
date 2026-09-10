from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.competitor import CompetitorStatus, ScaleClassification


class CompetitorCreate(BaseModel):
    domain: str
    name: str | None = None
    niche: str | None = None
    tags: list[str] = []
    operation: str = "colombia"


class CompetitorUpdate(BaseModel):
    status: CompetitorStatus | None = None
    niche: str | None = None
    tags: list[str] | None = None
    operation: str | None = None


class CompetitorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    domain: str
    name: str
    niche: str | None
    tags: list[str]
    operation: str
    status: CompetitorStatus
    created_at: datetime
    last_checked_at: datetime | None
    total_products: int
    vendor_count: int
    price_min: float | None
    price_max: float | None
    price_avg: float | None
    classification: ScaleClassification | None
    avg_daily_volume: float | None
    hot_products: int
    # Data de criação (na Shopify, não no nosso banco) do produto ATIVO mais
    # antigo dessa loja — proxy de "desde quando essa loja está no mercado"
    # (ver competitors.py:list_competitors). Não é uma coluna do model, é
    # calculado e atribuído no endpoint antes de serializar; None quando a
    # loja não tem nenhum produto com essa data preenchida.
    oldest_product_at: datetime | None = None


class TechStackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    external_id: str | None
    active: bool
    first_detected_at: datetime
    last_detected_at: datetime


class CompetitorDetailOut(CompetitorOut):
    tech_stack: list[TechStackOut] = []


class ProtectedStoreCreate(BaseModel):
    domain: str
    note: str | None = None


class ProtectedStoreOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    domain: str
    note: str | None
    added_by_user_id: int
    created_at: datetime
