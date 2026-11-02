"""Disaster alerts & news: ``GET /api/alerts/disasters`` and ``GET /api/alerts/news``."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AlertLevel = Literal["green", "orange", "red"]
NewsSource = Literal["reliefweb", "gdacs"]

#: Ordering used for ``min_level`` filtering and "most severe first" sorting.
ALERT_LEVEL_RANK: dict[str, int] = {"green": 0, "orange": 1, "red": 2}

#: GDACS event type code -> human label.
EVENT_TYPE_LABELS: dict[str, str] = {
    "EQ": "Earthquake",
    "TC": "Tropical Cyclone",
    "FL": "Flood",
    "VO": "Volcano",
    "DR": "Drought",
    "WF": "Wildfire",
}


class DisasterEvent(BaseModel):
    """Normalised GDACS event."""

    id: str = Field(examples=["EQ-1234567"])
    source: Literal["gdacs"] = "gdacs"
    event_type: str = Field(examples=["EQ"])
    event_type_label: str = Field(examples=["Earthquake"])
    title: str
    description: str = ""
    alert_level: AlertLevel
    severity_text: str | None = None
    country: str | None = None
    lat: float
    lon: float
    from_date: datetime | None = None
    to_date: datetime | None = None
    is_current: bool = True
    url: str
    #: Distance from the query point; only set when ``lat``/``lon`` were given.
    distance_km: float | None = None


class DisasterEventsResponse(BaseModel):
    events: list[DisasterEvent]
    updated_at: datetime


class NewsItem(BaseModel):
    id: str
    source: NewsSource
    title: str
    url: str
    published_at: datetime | None = None
    summary: str | None = None
    countries: list[str] = Field(default_factory=list)
    disaster_types: list[str] = Field(default_factory=list)
    #: Publishing organisation (e.g. ``"OCHA"``) when known.
    source_name: str | None = None


class NewsResponse(BaseModel):
    items: list[NewsItem]
    #: Providers that contributed items (``["reliefweb", "gdacs"]``).
    sources: list[NewsSource] = Field(default_factory=list)
    updated_at: datetime
