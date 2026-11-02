"""Nearby places (OpenStreetMap / Overpass): ``GET /api/places`` + legacy endpoints."""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel

PlaceType = Literal["hospital", "shelter", "police", "fire_station", "pharmacy"]
PLACE_TYPES: tuple[str, ...] = get_args(PlaceType)

#: Overpass radius clamp (metres).
MIN_PLACES_RADIUS_M = 500
MAX_PLACES_RADIUS_M = 20_000
DEFAULT_PLACES_RADIUS_M = 5_000


class Place(BaseModel):
    #: Stable OSM id, e.g. ``"node/123456"`` or ``"way/987"``.
    id: str
    name: str
    type: PlaceType
    lat: float
    lon: float
    distance_km: float
    address: str | None = None
    phone: str | None = None


class PlacesResponse(BaseModel):
    places: list[Place]


# --- legacy v1 endpoints (same item shape) ---------------------------------------------------
class HospitalsResponse(BaseModel):
    hospitals: list[Place]


class SheltersResponse(BaseModel):
    shelters: list[Place]


class PoliceResponse(BaseModel):
    police: list[Place]


class FireStationsResponse(BaseModel):
    fire_stations: list[Place]
