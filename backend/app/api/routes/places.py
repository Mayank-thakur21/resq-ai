"""Nearby places: ``GET /api/places`` + legacy ``/api/hospitals``, ``/api/shelters``,
``/api/police``, ``/api/fire-stations``.

Real OpenStreetMap data through :class:`~app.services.places.PlacesService` (Overpass API).
Every endpoint returns items of the same :class:`~app.schemas.places.Place` shape, nearest
first. The radius is in metres and clamped server-side to 500-20000. Upstream failures return
502 ``upstream_error`` (never a misleading empty list). Paths are relative to the ``/api``
prefix; the default rate limit is applied by ``app.api``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import PlacesDep
from app.schemas.common import error_responses
from app.schemas.places import (
    DEFAULT_PLACES_RADIUS_M,
    FireStationsResponse,
    HospitalsResponse,
    Place,
    PlacesResponse,
    PlaceType,
    PoliceResponse,
    SheltersResponse,
)
from app.services.places import DEFAULT_PLACES_LIMIT, MAX_PLACES_LIMIT, PlacesService

router = APIRouter(tags=["places"])

#: Accepted (then clamped) radius range in metres; generous so legacy clients never get a 422.
_MAX_ACCEPTED_RADIUS_M = 100_000

LatQuery = Annotated[float, Query(ge=-90.0, le=90.0, description="Latitude (WGS84 degrees)")]
LonQuery = Annotated[float, Query(ge=-180.0, le=180.0, description="Longitude (WGS84 degrees)")]
RadiusQuery = Annotated[
    int,
    Query(
        gt=0,
        le=_MAX_ACCEPTED_RADIUS_M,
        description="Search radius in metres (clamped to 500-20000)",
    ),
]
LimitQuery = Annotated[
    int, Query(ge=1, le=MAX_PLACES_LIMIT, description="Maximum number of places (nearest first)")
]

_RESPONSES = error_responses(422, 429, 502)


@router.get(
    "/places",
    response_model=PlacesResponse,
    summary="Nearby hospitals, shelters, police, fire stations or pharmacies (OpenStreetMap)",
    responses=_RESPONSES,
)
async def get_places(
    lat: LatQuery,
    lon: LonQuery,
    places: PlacesDep,
    place_type: Annotated[PlaceType, Query(alias="type", description="Kind of place")],
    radius: RadiusQuery = DEFAULT_PLACES_RADIUS_M,
    limit: LimitQuery = DEFAULT_PLACES_LIMIT,
) -> PlacesResponse:
    """Places of one ``type`` around a point, nearest first, each with ``distance_km``.

    Answered from one cached Overpass query per ~1.1 km cell and radius tier (all place
    types at once) for ``PLACES_CACHE_TTL`` seconds; distances are from the exact point.
    """
    return PlacesResponse(places=await places.get_places(lat, lon, place_type, radius, limit=limit))


async def _legacy(
    places: PlacesService, lat: float, lon: float, place_type: PlaceType, radius: int
) -> list[Place]:
    return await places.get_places(lat, lon, place_type, radius)


@router.get(
    "/hospitals",
    response_model=HospitalsResponse,
    summary="Nearby hospitals and clinics (legacy; prefer /places?type=hospital)",
    responses=_RESPONSES,
)
async def get_hospitals(
    lat: LatQuery, lon: LonQuery, places: PlacesDep, radius: RadiusQuery = DEFAULT_PLACES_RADIUS_M
) -> HospitalsResponse:
    return HospitalsResponse(hospitals=await _legacy(places, lat, lon, "hospital", radius))


@router.get(
    "/shelters",
    response_model=SheltersResponse,
    summary="Nearby shelters and assembly points (legacy; prefer /places?type=shelter)",
    responses=_RESPONSES,
)
async def get_shelters(
    lat: LatQuery, lon: LonQuery, places: PlacesDep, radius: RadiusQuery = DEFAULT_PLACES_RADIUS_M
) -> SheltersResponse:
    return SheltersResponse(shelters=await _legacy(places, lat, lon, "shelter", radius))


@router.get(
    "/police",
    response_model=PoliceResponse,
    summary="Nearby police stations (legacy; prefer /places?type=police)",
    responses=_RESPONSES,
)
async def get_police(
    lat: LatQuery, lon: LonQuery, places: PlacesDep, radius: RadiusQuery = DEFAULT_PLACES_RADIUS_M
) -> PoliceResponse:
    return PoliceResponse(police=await _legacy(places, lat, lon, "police", radius))


@router.get(
    "/fire-stations",
    response_model=FireStationsResponse,
    summary="Nearby fire stations (legacy; prefer /places?type=fire_station)",
    responses=_RESPONSES,
)
async def get_fire_stations(
    lat: LatQuery, lon: LonQuery, places: PlacesDep, radius: RadiusQuery = DEFAULT_PLACES_RADIUS_M
) -> FireStationsResponse:
    return FireStationsResponse(
        fire_stations=await _legacy(places, lat, lon, "fire_station", radius)
    )
