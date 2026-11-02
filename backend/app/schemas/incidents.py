"""Community incidents: ``/api/incidents`` CRUD-ish endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, get_args
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import APIModel, Latitude, Longitude

DisasterType = Literal[
    "flood",
    "earthquake",
    "fire",
    "cyclone",
    "landslide",
    "drought",
    "heatwave",
    "tsunami",
    "storm",
    "accident",
    "medical",
    "other",
]
Severity = Literal["low", "medium", "high", "critical"]
IncidentStatus = Literal["open", "resolved"]
#: Filter for ``GET /api/incidents?status=`` (default ``open``).
IncidentStatusFilter = Literal["open", "resolved", "all"]

DISASTER_TYPES: tuple[str, ...] = get_args(DisasterType)
SEVERITIES: tuple[str, ...] = get_args(Severity)

DEFAULT_INCIDENT_RADIUS_KM = 50.0
MAX_INCIDENT_RADIUS_KM = 1000.0
MAX_INCIDENT_LIMIT = 200


def validate_http_url(value: str | None, *, max_length: int = 500) -> str | None:
    """Accept only absolute ``http(s)://host/...`` URLs up to ``max_length`` chars."""
    if value is None or value == "":
        return None
    if len(value) > max_length:
        raise ValueError(f"URL must be at most {max_length} characters")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("URL must be an absolute http(s) URL")
    return value


class IncidentCreate(APIModel):
    lat: Latitude
    lon: Longitude
    disaster_type: DisasterType
    severity: Severity
    description: str = Field(min_length=10, max_length=1000)
    image_url: str | None = Field(default=None, max_length=500)

    @field_validator("image_url")
    @classmethod
    def _check_image_url(cls, value: str | None) -> str | None:
        return validate_http_url(value)


class IncidentStatusUpdate(APIModel):
    status: IncidentStatus


class Reporter(BaseModel):
    id: str
    name: str


class IncidentOut(BaseModel):
    """Incident as returned by the API."""

    id: str
    created_at: datetime
    updated_at: datetime
    lat: float
    lon: float
    disaster_type: DisasterType
    severity: Severity
    description: str
    image_url: str | None = None
    status: IncidentStatus
    reporter: Reporter
    upvotes: int = 0
    #: ``upvotes >= INCIDENT_VERIFY_THRESHOLD``.
    verified: bool = False
    #: Whether the calling user (if authenticated) has upvoted this incident.
    upvoted_by_me: bool = False
    #: Distance from the query point (list endpoint with ``lat``/``lon``).
    distance_km: float | None = None


class IncidentListResponse(BaseModel):
    incidents: list[IncidentOut]
