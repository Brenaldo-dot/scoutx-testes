from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AdMinerScanCreate(BaseModel):
    url: str = Field(min_length=3, max_length=500)
    operation: str = "colombia"


class AdMinerScanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    domain: str
    operation: str
    status: str
    result: dict | None
    error: str | None
    created_at: datetime
    finished_at: datetime | None
