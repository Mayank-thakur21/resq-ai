"""Disaster events (GDACS) and humanitarian news (ReliefWeb, with a GDACS-derived fallback).

GDACS
-----
``GET https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP`` returns a GeoJSON
``FeatureCollection``; each feature's ``properties`` hold ``eventtype`` (EQ, TC, FL, VO, DR,
WF), ``eventid``, ``episodeid``, ``name``/``eventname``, ``description``/``htmldescription``,
``alertlevel`` (Green/Orange/Red), ``country``, ``iso3``/``affectedcountries``, ``fromdate``/
``todate`` (UTC, usually without offset), ``iscurrent`` (often the *string* ``"true"``),
``severitydata`` and ``url{report,details,geometry}``. Parsing is tolerant: features with no
type/id/usable location are skipped, missing optional fields become ``None``, and the same
event appearing several times (episodes / extra geometries) is de-duplicated.

The normalised feed is cached for ``FEED_CACHE_TTL``; type / alert-level / radius filtering and
sorting happen *after* the cache, so every query shares one upstream request. When GDACS
fails, the last good copy (up to :data:`STALE_FEED_MAX_AGE` old) is served instead of an error.

ReliefWeb
---------
Only when ``RELIEFWEB_APPNAME`` is set (ReliefWeb requires a pre-approved appname):
``POST https://api.reliefweb.int/v2/reports?appname=<name>`` with the ``latest`` preset and the
``list`` profile, optional full-text ``query`` and ``country.iso3`` filter.

News behaviour (:meth:`DisasterFeedService.get_news`): ReliefWeb reports when configured and
healthy; when ReliefWeb is not configured, fails, or has nothing for the query, news items are
derived from GDACS events (title = event name, url = GDACS report). Items are merged and
sorted newest first; ``sources`` lists the providers the response is based on.

Failing providers are skipped for a short cool-down so concurrent requests do not pile up on
a dead upstream.
"""

from __future__ import annotations

import html
import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any, cast

import httpx

from app.core.config import Settings
from app.core.errors import InvalidInputError, UpstreamError
from app.schemas.alerts import (
    ALERT_LEVEL_RANK,
    EVENT_TYPE_LABELS,
    AlertLevel,
    DisasterEvent,
    DisasterEventsResponse,
    NewsItem,
    NewsResponse,
    NewsSource,
)
from app.services.cache import TTLCache
from app.services.geo import haversine_km, is_valid_lat, is_valid_lon, validate_coordinates
from app.services.http import ProviderError, request_json

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Provider endpoints
# ---------------------------------------------------------------------------------------------
GDACS_EVENTS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
GDACS_REPORT_URL_TEMPLATE = (
    "https://www.gdacs.org/report.aspx?eventtype={event_type}&eventid={event_id}"
)
RELIEFWEB_REPORTS_URL = "https://api.reliefweb.int/v2/reports"
RELIEFWEB_NODE_URL_TEMPLATE = "https://reliefweb.int/node/{id}"
RELIEFWEB_BASE_URL = "https://reliefweb.int"
RELIEFWEB_FIELDS: tuple[str, ...] = (
    "title",
    "url_alias",
    "date.created",
    "source.shortname",
    "country.name",
    "disaster_type.name",
    "headline.summary",
)

PROVIDER_GDACS = "GDACS"
PROVIDER_RELIEFWEB = "ReliefWeb"

# ---------------------------------------------------------------------------------------------
# Limits & tuning
# ---------------------------------------------------------------------------------------------
MAX_EVENTS_LIMIT = 500
MAX_NEWS_LIMIT = 100
MAX_RADIUS_KM = 20_037.5  # half the Earth's circumference
MAX_QUERY_LENGTH = 200
#: ReliefWeb page sizes requested upstream (a fixed size keeps the cache hit rate high).
RELIEFWEB_PAGE_SIZES = (50, MAX_NEWS_LIMIT)
#: Serve the last good GDACS copy for this long when GDACS is down.
STALE_FEED_MAX_AGE = timedelta(hours=6)
PROVIDER_ERROR_COOLDOWN_SECONDS = 60.0
RELIEFWEB_RATE_LIMIT_COOLDOWN_SECONDS = 300.0
#: ReliefWeb rejected the appname (401/403): it is not approved (yet).
RELIEFWEB_AUTH_COOLDOWN_SECONDS = 900.0
MAX_TITLE_CHARS = 300
#: Event coordinates are rounded (bbox centres would otherwise carry float noise).
COORD_DECIMALS = 5
MAX_DESCRIPTION_CHARS = 2000
MAX_SUMMARY_CHARS = 600

_GDACS_CACHE_KEY = ("feeds", "gdacs", "events")
_GDACS_COOLDOWN_KEY = ("feeds", "gdacs", "cooldown")
_RELIEFWEB_COOLDOWN_KEY = ("feeds", "reliefweb", "cooldown")

_EVENT_TYPE_CODE = re.compile(r"^[A-Z]{2,3}$")
_ISO3 = re.compile(r"^[A-Za-z]{3}$")
_HTML_TAG = re.compile(r"<[^>]+>")
_WHITESPACE = re.compile(r"\s+")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


# ---------------------------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------------------------
class ProviderCoolingDown(ProviderError):
    """The provider failed recently and is skipped until its cool-down expires."""

    def __init__(self, provider: str) -> None:
        super().__init__(provider, "skipped after a recent failure (cooling down)")


@dataclass(frozen=True, slots=True)
class GdacsRecord:
    """A normalised GDACS event plus the metadata needed for filtering and news."""

    event: DisasterEvent
    episode_id: int | None = None
    #: Upper-case ISO 3166-1 alpha-3 codes of the affected countries.
    iso3: frozenset[str] = frozenset()
    #: Affected country names.
    countries: tuple[str, ...] = ()
    modified_at: datetime | None = None
    #: ``True`` when the location is a Point geometry (else a bbox centre).
    is_point: bool = True


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    """The whole normalised GDACS feed as fetched at ``fetched_at``."""

    fetched_at: datetime
    records: tuple[GdacsRecord, ...]


@dataclass(frozen=True, slots=True)
class NewsSnapshot:
    fetched_at: datetime
    items: tuple[NewsItem, ...]


# ---------------------------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------------------------
class DisasterFeedService:
    """Fetches, normalises, caches and filters disaster feeds."""

    def __init__(self, http: httpx.AsyncClient, cache: TTLCache, settings: Settings) -> None:
        self.http = http
        self.cache = cache
        self.settings = settings
        #: Last successfully fetched GDACS feed (stale fallback while GDACS is down).
        self._last_gdacs: FeedSnapshot | None = None

    # -- public API ----------------------------------------------------------------------------
    async def get_events(
        self,
        lat: float | None = None,
        lon: float | None = None,
        radius_km: float | None = None,
        types: Sequence[str] | None = None,
        min_level: AlertLevel = "green",
        limit: int = 50,
    ) -> list[DisasterEvent]:
        """GDACS events filtered by type / minimum alert level / radius.

        With ``lat``/``lon`` each event gets ``distance_km`` and results are sorted by alert
        level (desc) then distance; without, by alert level then most recent activity.

        Args:
            types: GDACS type codes (``["EQ", "TC"]``); items may be comma-separated
                (``["EQ,TC"]``). Empty/None = all types.
            radius_km: Only events within this distance (requires ``lat``/``lon``).

        Raises:
            InvalidInputError: inconsistent or out-of-range arguments.
            UpstreamError: GDACS unavailable and nothing cached.
        """
        response = await self.get_events_response(
            lat=lat, lon=lon, radius_km=radius_km, types=types, min_level=min_level, limit=limit
        )
        return response.events

    async def get_events_response(
        self,
        lat: float | None = None,
        lon: float | None = None,
        radius_km: float | None = None,
        types: Sequence[str] | None = None,
        min_level: AlertLevel = "green",
        limit: int = 50,
    ) -> DisasterEventsResponse:
        """Like :meth:`get_events` but returns the API envelope (``updated_at`` = feed time)."""
        point = _validate_point(lat, lon)
        if radius_km is not None:
            if point is None:
                raise InvalidInputError("radius_km requires lat and lon")
            if not 0 < radius_km <= MAX_RADIUS_KM:
                raise InvalidInputError(f"radius_km must be > 0 and <= {MAX_RADIUS_KM:g}")
        if min_level not in ALERT_LEVEL_RANK:
            raise InvalidInputError("min_level must be one of green, orange, red")
        type_codes = normalize_event_types(types)
        limit = max(1, min(int(limit), MAX_EVENTS_LIMIT))

        snapshot = await self._gdacs_snapshot()
        events = select_events(
            snapshot.records,
            point=point,
            radius_km=radius_km,
            types=type_codes,
            min_level=min_level,
            limit=limit,
        )
        return DisasterEventsResponse(events=events, updated_at=snapshot.fetched_at)

    async def get_news(
        self,
        limit: int = 20,
        query: str | None = None,
        country: str | None = None,
    ) -> NewsResponse:
        """Latest news items (ReliefWeb when configured & healthy, else derived from GDACS).

        Args:
            limit: 1..100 items.
            query: Optional full-text search (ReliefWeb query / substring match on GDACS).
            country: Optional ISO 3166-1 alpha-3 code (``"IND"``).

        Raises:
            InvalidInputError: malformed ``country``.
            UpstreamError: no provider could be reached.
        """
        limit = max(1, min(int(limit), MAX_NEWS_LIMIT))
        query = normalize_query(query)
        iso3 = normalize_iso3(country)

        items: list[NewsItem] = []
        sources: list[NewsSource] = []
        fetched: list[datetime] = []

        if self.settings.reliefweb_enabled:
            reliefweb = await self._reliefweb_news(limit, query, iso3)
            if reliefweb is not None:
                sources.append("reliefweb")
                items.extend(reliefweb.items)
                fetched.append(reliefweb.fetched_at)

        if not items:
            try:
                snapshot = await self._gdacs_snapshot()
            except UpstreamError:
                if not sources:
                    raise UpstreamError("News providers unavailable") from None
            else:
                sources.append("gdacs")
                items.extend(gdacs_news_items(snapshot.records, query=query, iso3=iso3))
                fetched.append(snapshot.fetched_at)

        items.sort(key=lambda item: item.published_at or _EPOCH, reverse=True)
        return NewsResponse(
            items=items[:limit],
            sources=sources,
            updated_at=min(fetched) if fetched else _utcnow(),
        )

    # -- GDACS -----------------------------------------------------------------------------------
    async def _gdacs_snapshot(self) -> FeedSnapshot:
        """Cached GDACS feed; the last good copy while GDACS is down; else UpstreamError."""
        try:
            return await self.cache.get_or_set(
                _GDACS_CACHE_KEY, self.settings.feed_cache_ttl, self._fetch_gdacs
            )
        except ProviderError as exc:
            stale = self._last_gdacs
            if stale is not None and _utcnow() - stale.fetched_at <= STALE_FEED_MAX_AGE:
                logger.log(
                    logging.DEBUG if isinstance(exc, ProviderCoolingDown) else logging.WARNING,
                    "GDACS unavailable (%s); serving the feed fetched at %s",
                    exc.reason,
                    stale.fetched_at.isoformat(timespec="seconds"),
                )
                return stale
            raise UpstreamError("Disaster feed (GDACS) unavailable") from None

    async def _fetch_gdacs(self) -> FeedSnapshot:
        # Checked inside the cache factory so callers queued behind a failed load fail fast.
        if self.cache.get(_GDACS_COOLDOWN_KEY):
            raise ProviderCoolingDown(PROVIDER_GDACS)
        try:
            payload = await self._request_json(PROVIDER_GDACS, "GET", GDACS_EVENTS_URL)
            try:
                records = parse_gdacs_events(payload)
            except (TypeError, ValueError) as exc:
                raise ProviderError(PROVIDER_GDACS, f"malformed feed ({exc})") from exc
        except ProviderError as exc:
            self.cache.set(_GDACS_COOLDOWN_KEY, True, PROVIDER_ERROR_COOLDOWN_SECONDS)
            logger.warning("GDACS request failed: %s", exc.reason)
            raise
        snapshot = FeedSnapshot(fetched_at=_utcnow(), records=tuple(records))
        self._last_gdacs = snapshot
        logger.info("GDACS feed refreshed: %d events", len(records))
        return snapshot

    # -- ReliefWeb -------------------------------------------------------------------------------
    async def _reliefweb_news(
        self, limit: int, query: str | None, iso3: str | None
    ) -> NewsSnapshot | None:
        """ReliefWeb reports for the query, or ``None`` when ReliefWeb is unavailable."""
        page_size = next(size for size in RELIEFWEB_PAGE_SIZES if size >= limit)
        key = ("feeds", "reliefweb", page_size, query.casefold() if query else None, iso3)
        try:
            return await self.cache.get_or_set(
                key,
                self.settings.feed_cache_ttl,
                partial(self._fetch_reliefweb, page_size, query, iso3),
            )
        except ProviderError as exc:
            logger.log(
                logging.DEBUG if isinstance(exc, ProviderCoolingDown) else logging.WARNING,
                "ReliefWeb unavailable (%s); news falls back to GDACS",
                exc.reason,
            )
            return None

    async def _fetch_reliefweb(
        self, page_size: int, query: str | None, iso3: str | None
    ) -> NewsSnapshot:
        if self.cache.get(_RELIEFWEB_COOLDOWN_KEY):
            raise ProviderCoolingDown(PROVIDER_RELIEFWEB)
        body: dict[str, Any] = {
            "limit": page_size,
            "preset": "latest",
            "profile": "list",
            "fields": {"include": list(RELIEFWEB_FIELDS)},
        }
        if query:
            body["query"] = {"value": query}
        if iso3:
            # ReliefWeb stores ISO3 codes in lower case ("ind").
            body["filter"] = {"field": "country.iso3", "value": iso3.lower()}
        try:
            payload = await self._request_json(
                PROVIDER_RELIEFWEB,
                "POST",
                RELIEFWEB_REPORTS_URL,
                params={"appname": self.settings.reliefweb_appname},
                json=body,
            )
            try:
                items = parse_reliefweb_reports(payload)
            except (TypeError, ValueError) as exc:
                raise ProviderError(PROVIDER_RELIEFWEB, f"malformed response ({exc})") from exc
        except ProviderError as exc:
            self._trip_reliefweb_cooldown(exc)
            raise
        return NewsSnapshot(fetched_at=_utcnow(), items=tuple(items))

    def _trip_reliefweb_cooldown(self, exc: ProviderError) -> None:
        status = exc.status_code
        if status in (401, 403):
            logger.error(
                "ReliefWeb rejected appname %r (HTTP %s); is it approved? Using GDACS for news.",
                self.settings.reliefweb_appname,
                status,
            )
            seconds = RELIEFWEB_AUTH_COOLDOWN_SECONDS
        elif status == 429:
            seconds = RELIEFWEB_RATE_LIMIT_COOLDOWN_SECONDS
        elif status is not None and 400 <= status < 500:
            # e.g. a query string ReliefWeb cannot parse: specific to this request, no cool-down.
            return
        else:
            seconds = PROVIDER_ERROR_COOLDOWN_SECONDS
        self.cache.set(_RELIEFWEB_COOLDOWN_KEY, True, seconds)

    # -- HTTP ------------------------------------------------------------------------------------
    async def _request_json(
        self,
        provider: str,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> Any:
        """Send a request and decode JSON, mapping every failure to :class:`ProviderError`."""
        return await request_json(self.http, provider, method, url, params=params, json=json)


# ---------------------------------------------------------------------------------------------
# Argument normalisation
# ---------------------------------------------------------------------------------------------
def normalize_event_types(types: Iterable[str] | None) -> frozenset[str]:
    """``["eq", "TC,fl"]`` -> ``{"EQ", "TC", "FL"}``; empty/None -> empty set (= all types).

    Raises:
        InvalidInputError: a token is not a 2-3 letter code.
    """
    codes: set[str] = set()
    for item in types or ():
        for token in str(item).split(","):
            code = token.strip().upper()
            if not code:
                continue
            if not _EVENT_TYPE_CODE.match(code):
                known = ", ".join(EVENT_TYPE_LABELS)
                raise InvalidInputError(f"Invalid event type {token.strip()!r} (use {known})")
            codes.add(code)
    return frozenset(codes)


def normalize_iso3(country: str | None) -> str | None:
    """Blank -> ``None``; ``"ind"`` -> ``"IND"``; anything else raises InvalidInputError."""
    value = (country or "").strip()
    if not value:
        return None
    if not _ISO3.match(value):
        raise InvalidInputError("country must be an ISO 3166-1 alpha-3 code such as 'IND'")
    return value.upper()


def normalize_query(query: str | None) -> str | None:
    """Collapse whitespace, cap the length; blank -> ``None``."""
    value = _WHITESPACE.sub(" ", query or "").strip()
    return value[:MAX_QUERY_LENGTH] or None


def _validate_point(lat: float | None, lon: float | None) -> tuple[float, float] | None:
    if lat is None and lon is None:
        return None
    if lat is None or lon is None:
        raise InvalidInputError("lat and lon must be provided together")
    return validate_coordinates(lat, lon)


# ---------------------------------------------------------------------------------------------
# Filtering / sorting (pure)
# ---------------------------------------------------------------------------------------------
def select_events(
    records: Iterable[GdacsRecord],
    *,
    point: tuple[float, float] | None = None,
    radius_km: float | None = None,
    types: frozenset[str] = frozenset(),
    min_level: str = "green",
    limit: int = 50,
) -> list[DisasterEvent]:
    """Filter, annotate (``distance_km``) and sort cached records without mutating them."""
    min_rank = ALERT_LEVEL_RANK[min_level]
    selected: list[DisasterEvent] = []
    for record in records:
        event = record.event
        if types and event.event_type not in types:
            continue
        if ALERT_LEVEL_RANK[event.alert_level] < min_rank:
            continue
        if point is not None:
            distance = haversine_km(point[0], point[1], event.lat, event.lon)
            if radius_km is not None and distance > radius_km:
                continue
            event = event.model_copy(update={"distance_km": round(distance, 1)})
        selected.append(event)

    if point is not None:
        selected.sort(key=lambda e: (-ALERT_LEVEL_RANK[e.alert_level], e.distance_km or 0.0))
    else:
        selected.sort(
            key=lambda e: (ALERT_LEVEL_RANK[e.alert_level], _last_activity(e) or _EPOCH),
            reverse=True,
        )
    return selected[:limit]


def _last_activity(event: DisasterEvent) -> datetime | None:
    return event.to_date or event.from_date


# ---------------------------------------------------------------------------------------------
# GDACS parsing (pure)
# ---------------------------------------------------------------------------------------------
def parse_gdacs_events(payload: Any) -> list[GdacsRecord]:
    """Normalise a GDACS ``EVENTS4APP`` FeatureCollection.

    Raises:
        ValueError: the payload is not a FeatureCollection at all.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("features"), list):
        raise ValueError("expected a GeoJSON FeatureCollection with 'features'")
    by_id: dict[str, GdacsRecord] = {}
    skipped = 0
    for feature in payload["features"]:
        try:
            record = _parse_gdacs_feature(feature)
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed GDACS feature (%s)", type(exc).__name__)
            record = None
        if record is None:
            skipped += 1
            continue
        existing = by_id.get(record.event.id)
        if existing is None or _record_rank(record) > _record_rank(existing):
            by_id[record.event.id] = record
    if skipped:
        logger.debug("Skipped %d unusable GDACS feature(s)", skipped)
    return list(by_id.values())


def _record_rank(record: GdacsRecord) -> tuple[int, bool]:
    """Newest episode wins; for the same episode a Point beats a bbox centre."""
    return (record.episode_id if record.episode_id is not None else -1, record.is_point)


def _parse_gdacs_feature(feature: Any) -> GdacsRecord | None:
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties")
    if not isinstance(props, dict):
        return None
    event_type = (_clean(props.get("eventtype")) or "").upper()
    event_id = _clean(props.get("eventid"))
    if not event_type or not event_id:
        return None
    location = _feature_location(feature)
    if location is None:
        return None
    lat, lon, is_point = location

    label = EVENT_TYPE_LABELS.get(event_type, event_type)
    level = (_clean(props.get("alertlevel")) or "green").lower()
    alert_level = cast(AlertLevel, level) if level in ALERT_LEVEL_RANK else "green"

    countries, iso3 = _gdacs_countries(props)
    country = _clean(props.get("country")) or (", ".join(countries) if countries else None)

    name = _clean(props.get("name"))
    eventname = _clean(props.get("eventname"))
    if name:
        title = name
    elif eventname:
        title = f"{label} {eventname}"
    else:
        title = f"{label} in {country}" if country else label

    description = _clean_text(props.get("description"))
    html_description = _strip_html(props.get("htmldescription"))
    if html_description and (not description or description.casefold() == title.casefold()):
        description = html_description

    severity = props.get("severitydata")
    severity_text = _clean(severity.get("severitytext")) if isinstance(severity, dict) else None

    urls = props.get("url")
    report = _clean(urls.get("report")) if isinstance(urls, dict) else None
    if not report or not report.startswith(("https://", "http://")):
        report = GDACS_REPORT_URL_TEMPLATE.format(event_type=event_type, event_id=event_id)

    event = DisasterEvent(
        id=f"{event_type}-{event_id}",
        source="gdacs",
        event_type=event_type,
        event_type_label=label,
        title=_truncate(title, MAX_TITLE_CHARS),
        description=_truncate(description or "", MAX_DESCRIPTION_CHARS),
        alert_level=alert_level,
        severity_text=severity_text,
        country=country,
        lat=round(lat, COORD_DECIMALS),
        lon=round(lon, COORD_DECIMALS),
        from_date=parse_datetime(props.get("fromdate")),
        to_date=parse_datetime(props.get("todate")),
        is_current=_parse_bool(props.get("iscurrent"), default=True),
        url=report,
    )
    return GdacsRecord(
        event=event,
        episode_id=_opt_int(props.get("episodeid")),
        iso3=iso3,
        countries=countries,
        modified_at=parse_datetime(props.get("datemodified")),
        is_point=is_point,
    )


def _feature_location(feature: dict[str, Any]) -> tuple[float, float, bool] | None:
    """``(lat, lon, is_point)`` from a Point geometry, else from the feature's bbox centre."""
    geometry = feature.get("geometry")
    if isinstance(geometry, dict) and geometry.get("type") == "Point":
        coords = geometry.get("coordinates")
        if isinstance(coords, list | tuple) and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])
            if is_valid_lat(lat) and is_valid_lon(lon):
                return lat, lon, True
            return None
    bbox = feature.get("bbox")
    if isinstance(bbox, list | tuple) and len(bbox) >= 4:
        west, south, east, north = (float(v) for v in bbox[:4])
        lat = (south + north) / 2
        if west <= east:
            lon = (west + east) / 2
        else:  # crosses the antimeridian
            lon = (west + east + 360.0) / 2
            if lon > 180.0:
                lon -= 360.0
        if is_valid_lat(lat) and is_valid_lon(lon):
            return lat, lon, False
    return None


def _gdacs_countries(props: dict[str, Any]) -> tuple[tuple[str, ...], frozenset[str]]:
    names: list[str] = []
    codes: set[str] = set()
    own_iso3 = _clean(props.get("iso3"))
    if own_iso3:
        codes.update(code.strip().upper() for code in own_iso3.split(",") if code.strip())
    affected = props.get("affectedcountries")
    if isinstance(affected, list):
        for entry in affected:
            if not isinstance(entry, dict):
                continue
            name = _clean(entry.get("countryname"))
            if name and name not in names:
                names.append(name)
            code = _clean(entry.get("iso3"))
            if code:
                codes.add(code.upper())
    if not names:
        country = _clean(props.get("country"))
        if country:
            names = [part.strip() for part in country.split(",") if part.strip()]
    return tuple(names), frozenset(codes)


def gdacs_news_items(
    records: Iterable[GdacsRecord], *, query: str | None = None, iso3: str | None = None
) -> list[NewsItem]:
    """Derive news items from GDACS events (newest first), filtered by query / country."""
    tokens = query.casefold().split() if query else []
    now = _utcnow()
    items: list[NewsItem] = []
    for record in records:
        event = record.event
        if iso3 and iso3 not in record.iso3:
            continue
        if tokens:
            haystack = " ".join(
                part
                for part in (
                    event.title,
                    event.description,
                    event.country,
                    event.event_type_label,
                    event.severity_text,
                    *record.countries,
                )
                if part
            ).casefold()
            if not all(token in haystack for token in tokens):
                continue
        items.append(
            NewsItem(
                id=f"gdacs-{event.id}",
                source="gdacs",
                title=event.title,
                url=event.url,
                published_at=_gdacs_published_at(record, now),
                summary=_gdacs_summary(event),
                countries=list(record.countries) or ([event.country] if event.country else []),
                disaster_types=[event.event_type_label],
                source_name=PROVIDER_GDACS,
            )
        )
    items.sort(key=lambda item: item.published_at or _EPOCH, reverse=True)
    return items


def _gdacs_published_at(record: GdacsRecord, now: datetime) -> datetime | None:
    """Latest activity of the event that is not in the future (GDACS ``todate`` can be)."""
    event = record.event
    for candidate in (event.to_date, event.from_date, record.modified_at):
        if candidate is not None and candidate <= now + timedelta(hours=1):
            return candidate
    return None


def _gdacs_summary(event: DisasterEvent) -> str | None:
    """``"Orange alert · Magnitude 6.8M, Depth:35km · <description>"`` without repetition."""
    text = event.description.strip()
    if text.casefold() == event.title.casefold():
        text = ""
    lowered = text.casefold()
    parts: list[str] = []
    if event.alert_level not in lowered:
        parts.append(f"{event.alert_level.capitalize()} alert")
    if event.severity_text and event.severity_text.casefold() not in lowered:
        parts.append(event.severity_text)
    if text:
        parts.append(text)
    return _truncate(" · ".join(parts), MAX_SUMMARY_CHARS) if parts else None


# ---------------------------------------------------------------------------------------------
# ReliefWeb parsing (pure)
# ---------------------------------------------------------------------------------------------
def parse_reliefweb_reports(payload: Any) -> list[NewsItem]:
    """Normalise a ReliefWeb v2 ``/reports`` response; entries without a title are skipped.

    Raises:
        ValueError: the payload has no ``data`` list.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("expected an object with a 'data' list")
    items: list[NewsItem] = []
    for entry in payload["data"]:
        try:
            item = _parse_reliefweb_entry(entry)
        except (TypeError, ValueError) as exc:
            logger.debug("Skipping malformed ReliefWeb report (%s)", type(exc).__name__)
            continue
        if item is not None:
            items.append(item)
    return items


def _parse_reliefweb_entry(entry: Any) -> NewsItem | None:
    if not isinstance(entry, dict):
        return None
    fields = entry.get("fields")
    if not isinstance(fields, dict):
        return None
    report_id = _clean(entry.get("id")) or _clean(fields.get("id"))
    title = _clean_text(fields.get("title"))
    if not report_id or not title:
        return None
    url = _clean(fields.get("url_alias"))
    if url and url.startswith("/"):
        url = f"{RELIEFWEB_BASE_URL}{url}"
    if not url or not url.startswith(("https://", "http://")):
        url = RELIEFWEB_NODE_URL_TEMPLATE.format(id=report_id)
    date = fields.get("date")
    headline = fields.get("headline")
    summary = _clean_text(headline.get("summary")) if isinstance(headline, dict) else None
    source_names = _names(fields.get("source"), "shortname")
    return NewsItem(
        id=f"reliefweb-{report_id}",
        source="reliefweb",
        title=_truncate(title, MAX_TITLE_CHARS),
        url=url,
        published_at=parse_datetime(date.get("created")) if isinstance(date, dict) else None,
        summary=_truncate(summary, MAX_SUMMARY_CHARS) if summary else None,
        countries=_names(fields.get("country"), "name"),
        disaster_types=_names(fields.get("disaster_type"), "name"),
        source_name=", ".join(source_names[:3]) or None,
    )


def _names(value: Any, key: str) -> list[str]:
    """``[{"name": "India"}, ...]`` -> ``["India", ...]`` (also accepts a single object)."""
    entries = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
    names: list[str] = []
    for entry in entries:
        name = _clean(entry.get(key)) if isinstance(entry, dict) else None
        if name and name not in names:
            names.append(name)
    return names


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
_DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%d %b %Y %H:%M:%S", "%a, %d %b %Y %H:%M:%S %Z")


def parse_datetime(value: Any) -> datetime | None:
    """Tolerant timestamp parser -> aware UTC datetime (naive values are taken as UTC).

    Accepts ISO 8601 (with/without offset or ``Z``), a few common textual formats and epoch
    seconds/milliseconds; returns ``None`` for anything else.
    """
    if value is None or value == "" or isinstance(value, bool):
        return None
    parsed: datetime | None = None
    if isinstance(value, int | float):
        seconds = value / 1000 if value > 1e11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        for fmt in _DATETIME_FORMATS:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _parse_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no"}:
            return False
    return default


def _opt_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clean(value: Any) -> str | None:
    """``str(value).strip()`` or ``None`` when empty."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _clean_text(value: Any) -> str | None:
    """Collapse whitespace (and unescape HTML entities) in a free-text field."""
    text = _clean(value)
    if text is None:
        return None
    return _WHITESPACE.sub(" ", html.unescape(text)).strip() or None


def _strip_html(value: Any) -> str | None:
    text = _clean(value)
    if text is None:
        return None
    return _clean_text(_HTML_TAG.sub(" ", text))


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _utcnow() -> datetime:
    return datetime.now(UTC)


__all__ = [
    "GDACS_EVENTS_URL",
    "RELIEFWEB_FIELDS",
    "RELIEFWEB_REPORTS_URL",
    "DisasterFeedService",
    "FeedSnapshot",
    "GdacsRecord",
    "NewsSnapshot",
    "ProviderCoolingDown",
    "ProviderError",
    "gdacs_news_items",
    "normalize_event_types",
    "normalize_iso3",
    "normalize_query",
    "parse_datetime",
    "parse_gdacs_events",
    "parse_reliefweb_reports",
    "select_events",
]
