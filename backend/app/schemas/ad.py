from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AdOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    competitor_id: int
    product_id: int | None
    product_title: str | None
    product_image_url: str | None
    platform: str
    external_ad_id: str
    library_url: str | None
    advertiser_name: str | None
    creative_text: str | None
    cta: str | None
    started_at: datetime | None
    started_at_raw: str | None
    status: str
    is_winning: bool
    killed_at: datetime | None
    days_active: int | None


class AdListOut(BaseModel):
    items: list[AdOut]
    total: int
