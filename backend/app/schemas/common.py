"""Shared schema building blocks: coordinates, error envelope, health/meta responses."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

#: Latitude in decimal degrees (WGS84).
Latitude = Annotated[float, Field(ge=-90.0, le=90.0, description="Latitude (WGS84 degrees)")]
#: Longitude in decimal degrees (WGS84).
Longitude = Annotated[float, Field(ge=-180.0, le=180.0, description="Longitude (WGS84 degrees)")]

#: Three-level severity used by weather alerts and hazards.
Severity3 = Literal["low", "medium", "high"]


class APIModel(BaseModel):
    """Base model for API payloads: ignores unknown fields, strips string whitespace."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class Coordinates(APIModel):
    """A validated point."""

    lat: Latitude
    lon: Longitude


class OptionalCoordinates(APIModel):
    """Optional point — both ``lat`` and ``lon`` or neither."""

    lat: Latitude | None = None
    lon: Longitude | None = None

    @model_validator(mode="after")
    def _both_or_neither(self) -> OptionalCoordinates:
        if (self.lat is None) != (self.lon is None):
            raise ValueError("lat and lon must be provided together")
        return self


class ErrorDetail(BaseModel):
    code: str = Field(examples=["not_found"])
    message: str = Field(examples=["Incident not found."])
    request_id: str = Field(examples=["6f1c2d0a9b8e4f7a"])


class ErrorResponse(BaseModel):
    """Error envelope returned by every failing endpoint."""

    error: ErrorDetail


class OkResponse(BaseModel):
    ok: bool = True


class HealthServices(BaseModel):
    database: Literal["ok", "error"]
    gemini: bool
    openweathermap: bool
    reliefweb: bool
    twilio: bool
    push: bool
    auth: bool


class HealthResponse(BaseModel):
    """``GET /api/health`` — ``status`` is ``"degraded"`` (HTTP 503) when the DB is down."""

    status: Literal["ok", "degraded"]
    version: str
    services: HealthServices


class RootResponse(BaseModel):
    name: str = "ResQ AI API"
    version: str
    docs: str = "/docs"


#: Reusable OpenAPI ``responses=`` entries documenting the error envelope.
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    401: {"model": ErrorResponse, "description": "Missing/invalid/expired token"},
    403: {"model": ErrorResponse, "description": "Forbidden"},
    404: {"model": ErrorResponse, "description": "Not found"},
    409: {"model": ErrorResponse, "description": "Conflict"},
    422: {"model": ErrorResponse, "description": "Validation error"},
    429: {"model": ErrorResponse, "description": "Rate limited"},
    502: {"model": ErrorResponse, "description": "Upstream provider error"},
    503: {"model": ErrorResponse, "description": "Feature not configured"},
}


def error_responses(*status_codes: int) -> dict[int | str, dict[str, object]]:
    """Subset of :data:`ERROR_RESPONSES` for a route's ``responses=`` argument."""
    return {code: ERROR_RESPONSES[code] for code in status_codes if code in ERROR_RESPONSES}
