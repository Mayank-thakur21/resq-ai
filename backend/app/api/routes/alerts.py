"""Disaster alerts & news: ``GET /api/alerts/disasters`` and ``GET /api/alerts/news``.

Real data from GDACS (global disaster alerts) and ReliefWeb (humanitarian reports, when
``RELIEFWEB_APPNAME`` is set) through :class:`~app.services.disaster_feed.DisasterFeedService`.
Paths are relative to the ``/api`` prefix; the default rate limit is applied by ``app.api``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import FeedsDep
from app.schemas.alerts import AlertLevel, DisasterEventsResponse, NewsResponse
from app.schemas.common import error_responses
from app.services.disaster_feed import (
    MAX_EVENTS_LIMIT,
    MAX_NEWS_LIMIT,
    MAX_QUERY_LENGTH,
    MAX_RADIUS_KM,
)

router = APIRouter(tags=["alerts"])


@router.get(
    "/alerts/disasters",
    response_model=DisasterEventsResponse,
    summary="Current GDACS disaster events (earthquakes, cyclones, floods ...)",
    responses=error_responses(422, 429, 502),
)
async def list_disaster_events(
    feeds: FeedsDep,
    lat: Annotated[
        float | None,
        Query(ge=-90.0, le=90.0, description="Latitude of the point of interest (with lon)"),
    ] = None,
    lon: Annotated[
        float | None,
        Query(ge=-180.0, le=180.0, description="Longitude of the point of interest (with lat)"),
    ] = None,
    radius_km: Annotated[
        float | None,
        Query(
            gt=0,
            le=MAX_RADIUS_KM,
            description="Only events within this distance of lat/lon (requires lat/lon)",
        ),
    ] = None,
    types: Annotated[
        list[str] | None,
        Query(
            description=(
                "GDACS event types, comma-separated or repeated: EQ (earthquake), "
                "TC (tropical cyclone), FL (flood), VO (volcano), DR (drought), WF (wildfire)"
            ),
            examples=["EQ,TC"],
        ),
    ] = None,
    min_level: Annotated[AlertLevel, Query(description="Minimum GDACS alert level")] = "green",
    limit: Annotated[int, Query(ge=1, le=MAX_EVENTS_LIMIT)] = 50,
) -> DisasterEventsResponse:
    """GDACS events, most severe first.

    With ``lat``/``lon`` every event carries ``distance_km`` and events are sorted by alert
    level (red first) then distance; otherwise by alert level then most recent activity.
    ``updated_at`` is when the GDACS feed was fetched (cached for ``FEED_CACHE_TTL``).
    """
    return await feeds.get_events_response(
        lat=lat, lon=lon, radius_km=radius_km, types=types, min_level=min_level, limit=limit
    )


@router.get(
    "/alerts/news",
    response_model=NewsResponse,
    summary="Latest humanitarian news (ReliefWeb, or derived from GDACS events)",
    responses=error_responses(422, 429, 502),
)
async def list_news(
    feeds: FeedsDep,
    limit: Annotated[int, Query(ge=1, le=MAX_NEWS_LIMIT)] = 20,
    query: Annotated[
        str | None, Query(max_length=MAX_QUERY_LENGTH, description="Full-text search")
    ] = None,
    country: Annotated[
        str | None,
        Query(max_length=3, description="ISO 3166-1 alpha-3 country code, e.g. IND"),
    ] = None,
) -> NewsResponse:
    """ReliefWeb reports when configured and healthy; otherwise news derived from GDACS events.

    Items are sorted newest first; ``sources`` lists the providers the response is based on.
    Blank ``query``/``country`` values are ignored.
    """
    return await feeds.get_news(limit=limit, query=query, country=country)
