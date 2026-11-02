"""Real weather data: OpenWeatherMap (primary, when a key is set) with an Open-Meteo fallback.

Providers
---------
* **OpenWeatherMap** (``OPENWEATHER_API_KEY``): current conditions
  ``GET /data/2.5/weather`` and a 3-hourly forecast ``GET /data/2.5/forecast?cnt=8`` (next 24 h).
  Official alerts come from One Call 3.0 only when ``OPENWEATHER_ONECALL_ENABLED`` is set (it
  needs a separate OWM subscription); a 401/403 there is logged once and alerts are skipped
  for an hour.
* **Open-Meteo** (free, keyless): used when no OWM key is configured or OWM fails. WMO
  weather codes are mapped to a description and an OWM-style icon code. Open-Meteo has no
  reverse geocoding (``city``/``country`` are ``None``) and no official alerts.

Both failing raises :class:`~app.core.errors.UpstreamError` (HTTP 502). Values are never
invented: every number in a response comes from a provider.

Caching & resilience
--------------------
* Results are cached per ``(round(lat, 2), round(lon, 2))`` (a ~1 km cell) for
  ``WEATHER_CACHE_TTL`` seconds. Upstream requests use the rounded coordinates as well, so the
  user's precise location is never sent to third parties.
* A failing OWM is skipped for a cool-down period (15 min for a rejected key, 1 min otherwise)
  so every request does not pay the failed round-trip before falling back.
* When every provider failed for a cell, the failure is remembered for a few seconds so that
  concurrent/repeated requests fail fast instead of piling up on dead upstreams.

Hazards
-------
:func:`derive_hazards` turns the same data into heuristic hazards (extreme heat/cold, high
wind, heavy rain, thunderstorms); thresholds are the module constants below.

Logging never includes request URLs: OWM URLs carry the API key (``appid``).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from functools import partial
from typing import Any

import httpx
from pydantic import ValidationError

from app.core.config import Settings
from app.core.errors import UpstreamError
from app.schemas.common import Severity3
from app.schemas.weather import (
    CurrentWeather,
    ForecastItem,
    Hazard,
    WeatherAlert,
    WeatherResponse,
)
from app.services.cache import TTLCache
from app.services.geo import round_coord, validate_coordinates
from app.services.http import ProviderError, request_json

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Provider endpoints & request parameters
# ---------------------------------------------------------------------------------------------
OWM_CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather"
OWM_FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast"
OWM_ONECALL_URL = "https://api.openweathermap.org/data/3.0/onecall"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

#: OWM 2.5 forecast steps are 3-hourly: 8 steps = the next 24 hours.
OWM_FORECAST_STEPS = 8
OPEN_METEO_FORECAST_HOURS = 24
OPEN_METEO_CURRENT_VARS = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day"
)
#: ``is_day`` is requested hourly too so forecast icons get the right day/night variant.
OPEN_METEO_HOURLY_VARS = "temperature_2m,precipitation_probability,weather_code,is_day"

PROVIDER_OWM = "OpenWeatherMap"
PROVIDER_OWM_ONECALL = "OpenWeatherMap One Call"
PROVIDER_OPEN_METEO = "Open-Meteo"

# ---------------------------------------------------------------------------------------------
# Resilience tuning (seconds)
# ---------------------------------------------------------------------------------------------
#: OWM rejected the key / plan (401, 403): stop trying for a while.
OWM_AUTH_COOLDOWN_SECONDS = 900.0
#: OWM rate-limited us (429).
OWM_RATE_LIMIT_COOLDOWN_SECONDS = 300.0
#: Any other OWM failure (network, 5xx, malformed payload).
OWM_ERROR_COOLDOWN_SECONDS = 60.0
#: One Call 3.0 answered 401/403 (no subscription): skip alerts for an hour.
ONECALL_DENIED_COOLDOWN_SECONDS = 3600.0
#: Every provider failed for a cell: fail fast for this long.
ALL_PROVIDERS_FAILED_TTL_SECONDS = 15.0

# Cool-down flags live in the shared TTL cache (bounded, cleared together with it in tests).
_OWM_COOLDOWN_KEY = ("weather", "owm-cooldown")
_ONECALL_COOLDOWN_KEY = ("weather", "onecall-cooldown")

# ---------------------------------------------------------------------------------------------
# Hazard heuristics
# ---------------------------------------------------------------------------------------------
HEAT_FEELS_LIKE_C = 40.0
SEVERE_HEAT_FEELS_LIKE_C = 46.0
COLD_FEELS_LIKE_C = -10.0
SEVERE_COLD_FEELS_LIKE_C = -25.0
HIGH_WIND_KMH = 60.0
SEVERE_WIND_KMH = 90.0
HEAVY_RAIN_PROBABILITY = 80
#: How far ahead of the observation forecast steps are considered for rain/storm hazards.
HAZARD_WINDOW_HOURS = 12

MAX_ALERT_DESCRIPTION_CHARS = 2000
MS_TO_KMH = 3.6

_OWM_ICON = re.compile(r"^\d{2}[dn]$")

#: WMO weather interpretation code -> (description, OWM icon base without the d/n suffix).
#: https://open-meteo.com/en/docs ("WMO Weather interpretation codes").
WMO_CODES: dict[int, tuple[str, str]] = {
    0: ("Clear sky", "01"),
    1: ("Mainly clear", "02"),
    2: ("Partly cloudy", "03"),
    3: ("Overcast", "04"),
    45: ("Fog", "50"),
    48: ("Depositing rime fog", "50"),
    51: ("Light drizzle", "09"),
    53: ("Moderate drizzle", "09"),
    55: ("Dense drizzle", "09"),
    56: ("Light freezing drizzle", "09"),
    57: ("Dense freezing drizzle", "09"),
    61: ("Slight rain", "10"),
    63: ("Moderate rain", "10"),
    65: ("Heavy rain", "10"),
    66: ("Light freezing rain", "13"),
    67: ("Heavy freezing rain", "13"),
    71: ("Slight snowfall", "13"),
    73: ("Moderate snowfall", "13"),
    75: ("Heavy snowfall", "13"),
    77: ("Snow grains", "13"),
    80: ("Slight rain showers", "09"),
    81: ("Moderate rain showers", "09"),
    82: ("Violent rain showers", "09"),
    85: ("Slight snow showers", "13"),
    86: ("Heavy snow showers", "13"),
    95: ("Thunderstorm", "11"),
    96: ("Thunderstorm with slight hail", "11"),
    99: ("Thunderstorm with heavy hail", "11"),
}
UNKNOWN_CONDITIONS = ("Unknown conditions", "03")

WMO_THUNDERSTORM_CODES = frozenset({95, 96, 99})
WMO_HAIL_CODES = frozenset({96, 99})
WMO_HEAVY_RAIN_CODES = frozenset({65, 67, 82})
#: OWM condition ids: 2xx thunderstorm; heavy/extreme/very heavy (shower) rain.
OWM_HEAVY_RAIN_IDS = frozenset({202, 212, 502, 503, 504, 522, 531})


# ---------------------------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Outlook:
    """Provider-neutral weather signal for one observation/forecast step (hazard input)."""

    time: datetime
    precipitation_probability: int | None = None
    thunderstorm: bool = False
    hail: bool = False
    heavy_rain: bool = False


@dataclass(frozen=True, slots=True)
class Observation:
    """Parsed provider data: current conditions + forecast, plus the hazard signals."""

    current: CurrentWeather
    current_signal: Outlook
    forecast: list[ForecastItem]
    outlook: list[Outlook]


# ---------------------------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------------------------
class WeatherService:
    """Current conditions, short forecast, official alerts and derived hazards.

    Cached :class:`WeatherResponse` objects are shared between callers: treat them as
    read-only.
    """

    def __init__(self, http: httpx.AsyncClient, cache: TTLCache, settings: Settings) -> None:
        self.http = http
        self.cache = cache
        self.settings = settings
        self._onecall_denied_logged = False

    async def get_weather(self, lat: float, lon: float) -> WeatherResponse:
        """Weather for a point (cached per rounded coordinate for ``weather_cache_ttl``).

        Raises:
            InvalidInputError: coordinates out of range.
            UpstreamError: when every provider failed.
        """
        lat, lon = validate_coordinates(lat, lon)
        cell = (round_coord(lat), round_coord(lon))
        return await self.cache.get_or_set(
            ("weather", *cell), self.settings.weather_cache_ttl, partial(self._load, *cell)
        )

    # -- orchestration ---------------------------------------------------------------------------
    async def _load(self, lat: float, lon: float) -> WeatherResponse:
        failed_key = ("weather", "all-failed", lat, lon)
        if self.cache.get(failed_key):
            raise UpstreamError("Weather providers unavailable")

        observation: Observation | None = None
        alerts: list[WeatherAlert] = []
        if self.settings.openweather_enabled:
            if self.cache.get(_OWM_COOLDOWN_KEY):
                logger.debug("OpenWeatherMap cooling down after a failure; using Open-Meteo")
            else:
                observation, alerts = await self._load_openweathermap(lat, lon)

        if observation is None:
            try:
                observation = await self._load_open_meteo(lat, lon)
            except ProviderError as exc:
                logger.warning("Weather provider %s failed: %s", exc.provider, exc.reason)

        if observation is None:
            self.cache.set(failed_key, True, ALL_PROVIDERS_FAILED_TTL_SECONDS)
            raise UpstreamError("Weather providers unavailable")

        return WeatherResponse(
            weather=observation.current,
            forecast=observation.forecast,
            alerts=alerts,
            hazards=derive_hazards(observation),
        )

    async def _load_openweathermap(
        self, lat: float, lon: float
    ) -> tuple[Observation | None, list[WeatherAlert]]:
        """OWM current + forecast + (optional) alerts, fetched concurrently.

        Returns ``(None, alerts)`` when the current-conditions call failed; alerts come from a
        separate product and are kept even then.
        """
        params = {
            "lat": lat,
            "lon": lon,
            "appid": self.settings.openweather_api_key,
            "units": "metric",
        }
        current_res, forecast_res, alerts_res = await asyncio.gather(
            self._get_json(PROVIDER_OWM, OWM_CURRENT_URL, params),
            self._get_json(PROVIDER_OWM, OWM_FORECAST_URL, {**params, "cnt": OWM_FORECAST_STEPS}),
            self._load_onecall_alerts(lat, lon),
            return_exceptions=True,
        )
        # Anything that is not a ProviderError is a bug (or cancellation): re-raise it.
        for result in (current_res, forecast_res, alerts_res):
            if isinstance(result, BaseException) and not isinstance(result, ProviderError):
                raise result
        alerts = alerts_res if isinstance(alerts_res, list) else []

        forecast_payload: Any = None
        if isinstance(forecast_res, ProviderError):
            logger.warning("OpenWeatherMap forecast unavailable: %s", forecast_res.reason)
        else:
            forecast_payload = forecast_res

        if isinstance(current_res, ProviderError):
            self._trip_owm_cooldown(current_res)
            return None, alerts
        try:
            observation = parse_openweathermap(current_res, forecast_payload)
        except ProviderError as exc:
            self._trip_owm_cooldown(exc)
            return None, alerts
        return observation, alerts

    def _trip_owm_cooldown(self, exc: ProviderError) -> None:
        if exc.status_code in (401, 403):
            seconds = OWM_AUTH_COOLDOWN_SECONDS
            logger.error(
                "OpenWeatherMap rejected the API key (HTTP %s); using Open-Meteo for %.0f s. "
                "Check OPENWEATHER_API_KEY.",
                exc.status_code,
                seconds,
            )
        else:
            seconds = (
                OWM_RATE_LIMIT_COOLDOWN_SECONDS
                if exc.status_code == 429
                else OWM_ERROR_COOLDOWN_SECONDS
            )
            logger.warning(
                "OpenWeatherMap unavailable (%s); falling back to Open-Meteo for %.0f s",
                exc.reason,
                seconds,
            )
        self.cache.set(_OWM_COOLDOWN_KEY, True, seconds)

    async def _load_onecall_alerts(self, lat: float, lon: float) -> list[WeatherAlert]:
        """Official alerts from One Call 3.0; ``[]`` when disabled or on any failure."""
        if not self.settings.openweather_onecall_enabled or self.cache.get(_ONECALL_COOLDOWN_KEY):
            return []
        params = {
            "lat": lat,
            "lon": lon,
            "appid": self.settings.openweather_api_key,
            "exclude": "minutely,hourly,daily,current",
            "units": "metric",
        }
        try:
            payload = await self._get_json(PROVIDER_OWM_ONECALL, OWM_ONECALL_URL, params)
            return parse_onecall_alerts(payload)
        except ProviderError as exc:
            if exc.status_code in (401, 403):
                self.cache.set(_ONECALL_COOLDOWN_KEY, True, ONECALL_DENIED_COOLDOWN_SECONDS)
                if not self._onecall_denied_logged:
                    self._onecall_denied_logged = True
                    logger.warning(
                        "OpenWeatherMap One Call 3.0 denied (HTTP %s): the key has no One Call "
                        "subscription. Weather alerts are disabled; set "
                        "OPENWEATHER_ONECALL_ENABLED=false to silence this.",
                        exc.status_code,
                    )
                else:
                    logger.debug("One Call 3.0 still denied (HTTP %s)", exc.status_code)
            else:
                logger.warning("Weather alerts unavailable: %s", exc.reason)
            return []

    async def _load_open_meteo(self, lat: float, lon: float) -> Observation:
        params: dict[str, str | float | int] = {
            "latitude": lat,
            "longitude": lon,
            "current": OPEN_METEO_CURRENT_VARS,
            "hourly": OPEN_METEO_HOURLY_VARS,
            "forecast_hours": OPEN_METEO_FORECAST_HOURS,
            "timezone": "auto",
            "wind_speed_unit": "kmh",
        }
        payload = await self._get_json(PROVIDER_OPEN_METEO, OPEN_METEO_URL, params)
        return parse_open_meteo(payload)

    async def _get_json(self, provider: str, url: str, params: dict[str, Any]) -> Any:
        """GET ``url`` and decode JSON, mapping every failure to :class:`ProviderError`."""
        return await request_json(self.http, provider, "GET", url, params=params)


# ---------------------------------------------------------------------------------------------
# WMO code helpers
# ---------------------------------------------------------------------------------------------
def describe_wmo_code(code: int | None, is_day: bool | None = True) -> tuple[str, str]:
    """``(description, icon)`` for a WMO weather code; ``is_day=False`` selects the night icon."""
    description, icon_base = (
        UNKNOWN_CONDITIONS if code is None else WMO_CODES.get(code, UNKNOWN_CONDITIONS)
    )
    return description, f"{icon_base}{'n' if is_day is False else 'd'}"


def _wmo_signal(time: datetime, code: int | None, pop: int | None = None) -> Outlook:
    return Outlook(
        time=time,
        precipitation_probability=pop,
        thunderstorm=code in WMO_THUNDERSTORM_CODES,
        hail=code in WMO_HAIL_CODES,
        heavy_rain=code in WMO_HEAVY_RAIN_CODES,
    )


def _owm_signal(time: datetime, condition_id: int | None, pop: int | None = None) -> Outlook:
    return Outlook(
        time=time,
        precipitation_probability=pop,
        thunderstorm=condition_id is not None and 200 <= condition_id <= 232,
        heavy_rain=condition_id in OWM_HEAVY_RAIN_IDS,
    )


# ---------------------------------------------------------------------------------------------
# Parsers (pure functions; raise ProviderError on malformed payloads)
# ---------------------------------------------------------------------------------------------
def parse_openweathermap(current_payload: Any, forecast_payload: Any = None) -> Observation:
    """Parse OWM ``/data/2.5/weather`` (+ optional ``/data/2.5/forecast``) responses."""
    try:
        current, signal = _parse_owm_current(current_payload)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_OWM, f"malformed current weather ({_why(exc)})") from exc

    forecast: list[ForecastItem] = []
    outlook: list[Outlook] = []
    if forecast_payload is not None:
        try:
            forecast, outlook = _parse_owm_forecast(forecast_payload)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            # The current conditions are still good: degrade to "no forecast".
            logger.warning("OpenWeatherMap forecast malformed (%s); ignoring it", _why(exc))
        else:
            if current.city is None or current.country is None:
                city_info = forecast_payload.get("city") or {}
                current = current.model_copy(
                    update={
                        "city": current.city or _clean_str(city_info.get("name")),
                        "country": current.country or _country_code(city_info.get("country")),
                    }
                )
    return Observation(current=current, current_signal=signal, forecast=forecast, outlook=outlook)


def _parse_owm_current(payload: Any) -> tuple[CurrentWeather, Outlook]:
    if not isinstance(payload, dict):
        raise TypeError("payload is not an object")
    main = payload["main"]
    condition = _first_condition(payload.get("weather"))
    condition_id = _opt_int(condition.get("id"))
    observed_at = _from_epoch(payload["dt"])

    sys_info = payload.get("sys") or {}
    icon = _clean_str(condition.get("icon"))
    if icon and _OWM_ICON.match(icon):
        is_day: bool | None = icon.endswith("d")
    else:
        is_day = _is_daytime(observed_at, sys_info.get("sunrise"), sys_info.get("sunset"))
        icon = f"{UNKNOWN_CONDITIONS[1]}{'n' if is_day is False else 'd'}"

    current = CurrentWeather(
        temperature=round(float(main["temp"]), 1),
        feels_like=round(float(main["feels_like"]), 1),
        humidity=_clamp_percent(main["humidity"]),
        wind_speed_kmh=round(max(0.0, float(payload["wind"]["speed"])) * MS_TO_KMH, 1),
        description=_sentence_case(
            _clean_str(condition.get("description")) or _clean_str(condition.get("main"))
        )
        or UNKNOWN_CONDITIONS[0],
        icon=icon,
        weather_code=condition_id,
        city=_clean_str(payload.get("name")),
        country=_country_code(sys_info.get("country")),
        is_day=is_day,
        observed_at=observed_at,
        source="openweathermap",
    )
    return current, _owm_signal(observed_at, condition_id)


def _parse_owm_forecast(payload: Any) -> tuple[list[ForecastItem], list[Outlook]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("list"), list):
        raise TypeError("forecast payload has no 'list'")
    forecast: list[ForecastItem] = []
    outlook: list[Outlook] = []
    for entry in payload["list"]:
        try:
            time = _from_epoch(entry["dt"])
            condition = _first_condition(entry.get("weather"))
            condition_id = _opt_int(condition.get("id"))
            pop_raw = entry.get("pop")
            pop = _clamp_percent(float(pop_raw) * 100) if pop_raw is not None else None
            icon = _clean_str(condition.get("icon"))
            if not icon or not _OWM_ICON.match(icon):
                pod = _clean_str((entry.get("sys") or {}).get("pod"))
                icon = f"{UNKNOWN_CONDITIONS[1]}{'n' if pod == 'n' else 'd'}"
            item = ForecastItem(
                time=time,
                temperature=round(float(entry["main"]["temp"]), 1),
                description=_sentence_case(_clean_str(condition.get("description")))
                or UNKNOWN_CONDITIONS[0],
                icon=icon,
                precipitation_probability=pop,
            )
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            logger.debug("Skipping malformed OWM forecast step (%s)", _why(exc))
            continue
        forecast.append(item)
        outlook.append(_owm_signal(time, condition_id, pop))
    return forecast, outlook


def parse_onecall_alerts(payload: Any) -> list[WeatherAlert]:
    """Parse the ``alerts`` array of a One Call 3.0 response (absent => no alerts)."""
    if not isinstance(payload, dict):
        raise ProviderError(PROVIDER_OWM_ONECALL, "malformed response (not an object)")
    raw_alerts = payload.get("alerts") or []
    if not isinstance(raw_alerts, list):
        raise ProviderError(PROVIDER_OWM_ONECALL, "malformed response ('alerts' is not a list)")
    alerts: list[WeatherAlert] = []
    for raw in raw_alerts:
        if not isinstance(raw, dict):
            continue
        try:
            event = _clean_str(raw.get("event")) or "Weather alert"
            alerts.append(
                WeatherAlert(
                    event=event,
                    description=_truncate(
                        str(raw.get("description") or "").strip(), MAX_ALERT_DESCRIPTION_CHARS
                    ),
                    sender=_clean_str(raw.get("sender_name")) or PROVIDER_OWM,
                    start=_from_epoch(raw["start"]) if raw.get("start") is not None else None,
                    end=_from_epoch(raw["end"]) if raw.get("end") is not None else None,
                    severity=classify_alert_severity(event),
                )
            )
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed One Call alert (%s)", _why(exc))
    alerts.sort(key=lambda a: _SEVERITY_RANK[a.severity], reverse=True)
    return alerts


def parse_open_meteo(payload: Any) -> Observation:
    """Parse an Open-Meteo ``/v1/forecast`` response (``current`` + ``hourly`` blocks).

    Open-Meteo times are local wall-clock times of the requested ``timezone=auto``; they are
    converted to UTC with ``utc_offset_seconds``. Hourly steps before the current hour are
    dropped and at most :data:`OPEN_METEO_FORECAST_HOURS` steps are returned.
    """
    try:
        if not isinstance(payload, dict):
            raise TypeError("payload is not an object")
        tz = timezone(timedelta(seconds=int(payload.get("utc_offset_seconds") or 0)))
        block = payload["current"]
        observed_at = _parse_local_time(block["time"], tz)
        code = _opt_int(block.get("weather_code"))
        is_day = _opt_bool(block.get("is_day"))
        description, icon = describe_wmo_code(code, is_day)
        current = CurrentWeather(
            temperature=round(float(block["temperature_2m"]), 1),
            feels_like=round(float(block["apparent_temperature"]), 1),
            humidity=_clamp_percent(block["relative_humidity_2m"]),
            wind_speed_kmh=round(max(0.0, float(block["wind_speed_10m"])), 1),
            description=description,
            icon=icon,
            weather_code=code,
            city=None,
            country=None,
            is_day=is_day,
            observed_at=observed_at,
            source="open-meteo",
        )
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ProviderError(PROVIDER_OPEN_METEO, f"malformed response ({_why(exc)})") from exc

    forecast, outlook = _parse_open_meteo_hourly(payload.get("hourly"), tz, observed_at)
    return Observation(
        current=current,
        current_signal=_wmo_signal(observed_at, code),
        forecast=forecast,
        outlook=outlook,
    )


def _parse_open_meteo_hourly(
    hourly: Any, tz: timezone, observed_at: datetime
) -> tuple[list[ForecastItem], list[Outlook]]:
    if not isinstance(hourly, dict):
        return [], []
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    pops = hourly.get("precipitation_probability") or []
    codes = hourly.get("weather_code") or []
    days = hourly.get("is_day") or []
    # Hourly steps sit on *local* hours (offsets can be :30/:45), so floor in local time.
    current_hour = (
        observed_at.astimezone(tz).replace(minute=0, second=0, microsecond=0).astimezone(UTC)
    )

    forecast: list[ForecastItem] = []
    outlook: list[Outlook] = []
    for index, raw_time in enumerate(times):
        if len(forecast) >= OPEN_METEO_FORECAST_HOURS:
            break
        try:
            time = _parse_local_time(raw_time, tz)
            temperature = _at(temps, index)
            if time < current_hour or temperature is None:
                continue
            code = _opt_int(_at(codes, index))
            is_day = _opt_bool(_at(days, index))
            if is_day is None:
                # Cosmetic only (icon variant): fall back to the local hour of the step.
                local_hour = time.astimezone(tz).hour
                is_day = 6 <= local_hour < 18
            pop_raw = _at(pops, index)
            pop = _clamp_percent(pop_raw) if pop_raw is not None else None
            description, icon = describe_wmo_code(code, is_day)
            item = ForecastItem(
                time=time,
                temperature=round(float(temperature), 1),
                description=description,
                icon=icon,
                precipitation_probability=pop,
            )
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed Open-Meteo hourly step (%s)", _why(exc))
            continue
        forecast.append(item)
        outlook.append(_wmo_signal(time, code, pop))
    return forecast, outlook


# ---------------------------------------------------------------------------------------------
# Alerts & hazards
# ---------------------------------------------------------------------------------------------
_SEVERITY_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}
_ALERT_HIGH = re.compile(r"\b(extreme|emergency|red|orange|severe|danger(ous)?)\b", re.I)
_ALERT_MEDIUM_LEVEL = re.compile(r"\b(yellow|minor|moderate)\b", re.I)
_ALERT_WARNING = re.compile(r"\bwarnings?\b", re.I)
_ALERT_MEDIUM = re.compile(r"\b(watch|advisory|advisories)\b", re.I)


def classify_alert_severity(event: str) -> Severity3:
    """Map an official alert title to ``low``/``medium``/``high``.

    Explicit level words win (``Extreme``/``Red``/``Orange``/``Severe`` -> high,
    ``Yellow``/``Minor``/``Moderate`` -> medium), then the NWS-style product type
    (``Warning`` -> high, ``Watch``/``Advisory`` -> medium, statements/outlooks -> low).
    """
    if _ALERT_HIGH.search(event):
        return "high"
    if _ALERT_MEDIUM_LEVEL.search(event):
        return "medium"
    if _ALERT_WARNING.search(event):
        return "high"
    if _ALERT_MEDIUM.search(event):
        return "medium"
    return "low"


def derive_hazards(observation: Observation) -> list[Hazard]:
    """Heuristic hazards from current conditions and the next :data:`HAZARD_WINDOW_HOURS`.

    Rules (one hazard per type, most severe first):

    * ``extreme_heat``: feels-like >= 40 °C (high from 46 °C).
    * ``extreme_cold``: feels-like <= -10 °C (high from -25 °C).
    * ``high_wind``: sustained wind >= 60 km/h (high from 90 km/h).
    * ``thunderstorm``: thunderstorm now (high) or forecast (medium; high with hail).
    * ``heavy_rain``: heavy-rain conditions now/forecast (high) or precipitation probability
      >= 80 % in the window (medium).
    """
    current = observation.current
    now = observation.current_signal
    # Include the hourly step covering "now" (it starts up to an hour before the observation).
    window_start = now.time - timedelta(hours=1)
    window_end = now.time + timedelta(hours=HAZARD_WINDOW_HOURS)
    upcoming = [s for s in observation.outlook if window_start < s.time <= window_end]
    hazards: list[Hazard] = []

    feels = current.feels_like
    if feels >= HEAT_FEELS_LIKE_C:
        hazards.append(
            Hazard(
                type="extreme_heat",
                severity="high" if feels >= SEVERE_HEAT_FEELS_LIKE_C else "medium",
                message=(
                    f"Extreme heat: it feels like {feels:.0f}°C. Stay indoors during the hottest "
                    "hours, drink water regularly and check on elderly neighbours."
                ),
            )
        )
    elif feels <= COLD_FEELS_LIKE_C:
        hazards.append(
            Hazard(
                type="extreme_cold",
                severity="high" if feels <= SEVERE_COLD_FEELS_LIKE_C else "medium",
                message=(
                    f"Extreme cold: it feels like {feels:.0f}°C. Limit time outdoors, wear "
                    "layers and watch for signs of frostbite and hypothermia."
                ),
            )
        )

    wind = current.wind_speed_kmh
    if wind >= HIGH_WIND_KMH:
        hazards.append(
            Hazard(
                type="high_wind",
                severity="high" if wind >= SEVERE_WIND_KMH else "medium",
                message=(
                    f"High winds of {wind:.0f} km/h. Secure loose objects and keep away from "
                    "trees, power lines and hoardings."
                ),
            )
        )

    storm_soon = any(s.thunderstorm for s in upcoming)
    if now.thunderstorm or storm_soon:
        hail = now.hail or any(s.hail for s in upcoming)
        what = "Thunderstorm with hail" if hail else "Thunderstorm"
        when = "in progress" if now.thunderstorm else f"likely in the next {HAZARD_WINDOW_HOURS} h"
        hazards.append(
            Hazard(
                type="thunderstorm",
                severity="high" if now.thunderstorm or hail else "medium",
                message=(
                    f"{what} {when}. Stay indoors away from windows and avoid open ground, "
                    "water and tall isolated objects."
                ),
            )
        )

    pops = [
        s.precipitation_probability for s in upcoming if s.precipitation_probability is not None
    ]
    max_pop = max(pops, default=None)
    if now.heavy_rain or any(s.heavy_rain for s in upcoming):
        when = "now" if now.heavy_rain else f"expected in the next {HAZARD_WINDOW_HOURS} h"
        chance = f" (up to {max_pop}% chance)" if max_pop is not None and not now.heavy_rain else ""
        hazards.append(
            Hazard(
                type="heavy_rain",
                severity="high",
                message=(
                    f"Heavy rain {when}{chance}. Avoid low-lying areas and never walk or drive "
                    "through flood water."
                ),
            )
        )
    elif max_pop is not None and max_pop >= HEAVY_RAIN_PROBABILITY:
        hazards.append(
            Hazard(
                type="heavy_rain",
                severity="medium",
                message=(
                    f"{max_pop}% chance of rain in the next {HAZARD_WINDOW_HOURS} h. Watch for "
                    "waterlogging and avoid flooded roads."
                ),
            )
        )

    hazards.sort(key=lambda h: _SEVERITY_RANK[h.severity], reverse=True)
    return hazards


# ---------------------------------------------------------------------------------------------
# Small parsing helpers
# ---------------------------------------------------------------------------------------------
def _why(exc: BaseException) -> str:
    """Short, log-safe description of a parsing error (no payload dump)."""
    if isinstance(exc, ValidationError):
        return f"{exc.error_count()} validation error(s)"
    if isinstance(exc, KeyError):
        return f"missing {exc.args[0]!r}" if exc.args else "missing field"
    return type(exc).__name__


def _first_condition(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _sentence_case(value: str | None) -> str | None:
    return value[:1].upper() + value[1:] if value else value


def _country_code(value: Any) -> str | None:
    code = _clean_str(value)
    return code.upper() if code and len(code) == 2 and code.isalpha() else None


def _opt_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _opt_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return bool(value)
    return None


def _clamp_percent(value: Any) -> int:
    return max(0, min(100, round(float(value))))


def _at(values: Sequence[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


def _from_epoch(value: Any) -> datetime:
    return datetime.fromtimestamp(int(value), tz=UTC)


def _parse_local_time(value: Any, tz: timezone) -> datetime:
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(UTC)


def _is_daytime(observed_at: datetime, sunrise: Any, sunset: Any) -> bool | None:
    try:
        return int(sunrise) <= int(observed_at.timestamp()) < int(sunset)
    except (TypeError, ValueError):
        return None


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


__all__ = [
    "OPEN_METEO_URL",
    "OWM_CURRENT_URL",
    "OWM_FORECAST_URL",
    "OWM_ONECALL_URL",
    "WMO_CODES",
    "Observation",
    "Outlook",
    "ProviderError",
    "WeatherService",
    "classify_alert_severity",
    "derive_hazards",
    "describe_wmo_code",
    "parse_onecall_alerts",
    "parse_open_meteo",
    "parse_openweathermap",
]
