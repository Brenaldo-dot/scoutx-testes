from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    competitor_id: int
    competitor_name: str
    product_id: int | None
    ad_id: int | None
    ad_library_url: str | None
    product_url: str | None
    product_image_url: str | None
    product_title: str | None
    alert_type: str
    message: str
    payload: dict | None
    sent_to_telegram: bool
    sent_to_discord: bool
    created_at: datetime


class AlertListOut(BaseModel):
    items: list[AlertOut]
    total: int


class AlertCountsOut(BaseModel):
    total: int
    by_category: dict[str, int]
