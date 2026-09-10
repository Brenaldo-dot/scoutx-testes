from datetime import datetime

from pydantic import BaseModel

from app.schemas.alert import AlertOut


class DashboardSummary(BaseModel):
    total_competitors: int
    active_competitors: int
    total_products: int
    hot_products: int
    alerts_last_24h: int
    recent_alerts: list[AlertOut]


class TrendingProductOut(BaseModel):
    product_id: int
    title: str
    competitor_name: str
    image_url: str | None
    score: int
    delta: int


class WinningAdMiniOut(BaseModel):
    id: int
    product_title: str | None
    product_image_url: str | None
    competitor_name: str
    days_active: int | None
    library_url: str | None


class VendorChangeMiniOut(BaseModel):
    id: int
    competitor_name: str
    message: str
    product_title: str | None
    created_at: datetime


class DashboardHighlights(BaseModel):
    trending_products: list[TrendingProductOut]
    winning_ads: list[WinningAdMiniOut]
    vendor_changes: list[VendorChangeMiniOut]
