"""Weather: ``GET /api/weather`` and the legacy AI summary ``GET /api/advisories``.

Both use real provider data (OpenWeatherMap, or keyless Open-Meteo as a fallback) through
:class:`~app.services.weather.WeatherService`; no values are ever mocked. Paths are relative
to the ``/api`` prefix; the default rate limit is applied by ``app.api``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Query

from app.agents.advisory_agent import summarize_advisory
from app.api.deps import CacheDep, LLMDep, SettingsDep, WeatherDep
from app.schemas.chat import AdvisoryResponse
from app.schemas.common import error_responses
from app.schemas.weather import WeatherResponse
from app.services.geo import round_coord

logger = logging.getLogger(__name__)

router = APIRouter(tags=["weather"])

#: Time the Advisory Agent's LLM call may take in ``GET /api/advisories``.
ADVISORY_LLM_BUDGET_SECONDS = 8.0


class _AdvisoryTimeoutError(Exception):
    """Carries the deterministic advisory out of the cache factory (so it is not cached)."""

    def __init__(self, text: str) -> None:
        super().__init__("advisory LLM budget exceeded")
        self.text = text


LatQuery = Annotated[float, Query(ge=-90.0, le=90.0, description="Latitude (WGS84 degrees)")]
LonQuery = Annotated[float, Query(ge=-180.0, le=180.0, description="Longitude (WGS84 degrees)")]


@router.get(
    "/weather",
    response_model=WeatherResponse,
    summary="Current weather, 24 h forecast, official alerts and derived hazards",
    responses=error_responses(422, 429, 502),
)
async def get_weather(lat: LatQuery, lon: LonQuery, weather: WeatherDep) -> WeatherResponse:
    """Real weather for a point.

    * ``weather.source`` tells which provider answered (``openweathermap`` or ``open-meteo``).
    * ``forecast``: OpenWeatherMap gives 8 three-hourly steps, Open-Meteo up to 24 hourly steps.
    * ``alerts``: official alerts (OpenWeatherMap One Call 3.0, only when enabled).
    * ``hazards``: heuristics (extreme heat/cold, high wind, heavy rain, thunderstorms).

    Responses are cached per ~1 km cell for ``WEATHER_CACHE_TTL`` seconds. Returns 502
    ``upstream_error`` when every provider failed.
    """
    return await weather.get_weather(lat, lon)


@router.get(
    "/advisories",
    response_model=AdvisoryResponse,
    summary="AI weather safety advisory for a point (legacy)",
    responses=error_responses(422, 429, 502),
)
async def get_advisories(
    lat: LatQuery,
    lon: LonQuery,
    weather: WeatherDep,
    llm: LLMDep,
    cache: CacheDep,
    settings: SettingsDep,
    language: Annotated[
        str, Query(min_length=2, max_length=35, description="Answer language (code or name)")
    ] = "en",
) -> AdvisoryResponse:
    """Short safety advisory summarising the local weather, alerts and hazards.

    Written by the Advisory Agent (Gemini) when configured; otherwise a deterministic English
    advisory built from the same data. Cached per weather snapshot and language so repeated
    calls do not re-invoke the LLM.
    """
    data = await weather.get_weather(lat, lon)
    # Keyed on the exact weather snapshot, so a refreshed observation gets a fresh advisory.
    key = (
        "advisory",
        round_coord(lat),
        round_coord(lon),
        data.weather.source,
        data.weather.observed_at.isoformat(),
        language.strip().lower(),
    )

    async def _summarize() -> str:
        # Keep the whole request inside the proxy's 20 s timeout: a slow LLM yields the
        # deterministic advisory (not cached, so a later call can still get the AI text).
        try:
            async with asyncio.timeout(ADVISORY_LLM_BUDGET_SECONDS):
                return await summarize_advisory(data, language, llm)
        except TimeoutError:
            logger.warning(
                "Advisory summary exceeded %.0fs; using the fallback", ADVISORY_LLM_BUDGET_SECONDS
            )
            raise _AdvisoryTimeoutError(await summarize_advisory(data, language, None)) from None

    try:
        text = await cache.get_or_set(key, settings.weather_cache_ttl, _summarize)
    except _AdvisoryTimeoutError as fallback:
        text = fallback.text
    return AdvisoryResponse(advisories=text)
