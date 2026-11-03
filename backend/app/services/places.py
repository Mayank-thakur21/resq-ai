"""Nearby emergency places from OpenStreetMap through the Overpass API.

Replaces the v1 ``mapping_agent``. One Overpass query per place type:

=============  =====================================================================
type           OSM tags
=============  =====================================================================
hospital       ``amenity=hospital`` or ``amenity=clinic``
shelter        ``amenity=shelter``, ``emergency=assembly_point``,
               ``social_facility=shelter``
police         ``amenity=police``
fire_station   ``amenity=fire_station``
pharmacy       ``amenity=pharmacy``
=============  =====================================================================

Results are parsed into :class:`~app.schemas.places.Place` (name fallback ``"Unnamed <type>"``,
address from ``addr:*`` tags, phone from ``phone``/``contact:phone``), filtered to the
requested radius and sorted nearest first.

One query per map view
----------------------
The map asks for up to five place types at once, for every user, and the public Overpass
instance grants each server IP only ~2 concurrent query slots. So instead of one query per
(type, point, radius), the service runs **one** Overpass query per *view* — a coarse cell
(:data:`CELL_DECIMALS` = 2 decimals, ~1.1 km) and a radius *tier* (:data:`RADIUS_TIERS_M`,
the map's 1/2/5/10/20 km choices) — that returns every place type (one ``out`` per type, so
each type keeps its own element cap). Elements are classified by their tags, the result is
cached for ``PLACES_CACHE_TTL`` seconds, and every request (any type, any radius up to the
tier, any point inside the cell) is answered from it, filtered and measured against the
caller's exact point. The query is centred on the cell and widened by
:data:`CELL_SLACK_M`, so no place inside the caller's radius is missed. Concurrent requests
for the same view share one upstream query (single-flight cache), and arbitrary ``radius``
values can no longer produce new upstream queries.

Failures raise :class:`~app.core.errors.UpstreamError` (HTTP 502): an empty list would be
indistinguishable from "nothing nearby", which is dangerous in an emergency app. The chat
agent catches the error and degrades gracefully.

Partial answers: when Overpass runs out of time or memory it still answers HTTP 200 with the
elements written so far and a "runtime error" ``remark``. The types are queried one after
another, so a type that was never reached would look exactly like a type with no results.
Every type's block therefore ends with ``out count;``, and in a partial answer only the
types whose count marker arrived are known; the others raise :class:`UpstreamError` instead
of being served as empty. A partial view is cached only briefly
(:data:`PARTIAL_RESULT_TTL_SECONDS`).

Concurrency and time budget: upstream queries pass through a per-process semaphore of
``OVERPASS_MAX_CONCURRENCY`` slots (default :data:`MAX_CONCURRENT_OVERPASS`, what the public
instance allows; raise it for a self-hosted ``OVERPASS_URL``). Every lookup has a total
budget of :data:`REQUEST_BUDGET_SECONDS` (inside the frontend proxy's 20 s timeout): the slot
wait, the HTTP request and the single retry of a 429 all run against one deadline, which is
enforced as a whole (``asyncio.timeout``, so a slowly streamed answer cannot run past it;
httpx timeouts only bound each phase and each read). Overpass's own ``[timeout:N]`` is kept
inside what is left of it. A "busy" failure is remembered for only
:data:`BUSY_FAILURE_TTL_SECONDS`.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import InvalidInputError, UpstreamError
from app.schemas.places import (
    DEFAULT_PLACES_RADIUS_M,
    MAX_PLACES_RADIUS_M,
    MIN_PLACES_RADIUS_M,
    Place,
    PlaceType,
)
from app.services.cache import TTLCache
from app.services.geo import clamp, haversine_km, round_coord, validate_coordinates

logger = logging.getLogger(__name__)

#: Default Overpass endpoint (``OVERPASS_URL`` overrides it).
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

#: Default and maximum number of places returned per request (nearest first).
DEFAULT_PLACES_LIMIT = 100
MAX_PLACES_LIMIT = 200
#: Upper bound on elements requested from Overpass per place type (protects against huge
#: city responses; each type has its own ``out`` statement, so types never crowd each other).
OVERPASS_MAX_ELEMENTS = 2000
#: Cache cell precision (2 decimals ~= 1.1 km) and the matching query-radius slack in metres
#: (half-diagonal of a cell, rounded up), so every place inside the caller's radius is fetched.
CELL_DECIMALS = 2
CELL_SLACK_M = 800
#: Radii actually queried (the map's choices); a request uses the smallest tier that covers
#: its (clamped) radius and is filtered locally.
RADIUS_TIERS_M: tuple[int, ...] = (1000, 2000, 5000, 10000, MAX_PLACES_RADIUS_M)
#: How long a failed Overpass lookup is remembered (avoids hammering a struggling server).
FAILURE_TTL_SECONDS = 20.0
#: Shorter memory for "too busy" failures (HTTP 429, or no local slot became free in time).
BUSY_FAILURE_TTL_SECONDS = 5.0
#: Cache lifetime of a partial answer (Overpass runtime error with some elements).
PARTIAL_RESULT_TTL_SECONDS = 60.0
#: Default concurrent Overpass queries per process (overpass-api.de allows ~2 per client IP).
MAX_CONCURRENT_OVERPASS = 2
#: Longest wait for a free slot (further capped by the remaining request budget).
MAX_SLOT_WAIT_SECONDS = 8.0
#: Total time one lookup may spend on Overpass: slot wait + request(s) (the frontend proxy
#: gives up after 20 s).
REQUEST_BUDGET_SECONDS = 17.0
#: An Overpass request is only started when at least this much of the budget is left.
MIN_ATTEMPT_SECONDS = 4.0
#: Pause before the single retry of a 429 answer.
OVERPASS_RETRY_DELAY_SECONDS = 1.5
#: Extra seconds the HTTP request may take beyond the Overpass server-side ``[timeout:N]``.
TRANSFER_MARGIN_SECONDS = 5.0

#: Overpass QL tag filters per place type (each entry becomes one ``nwr[...]`` statement).
PLACE_FILTERS: dict[str, tuple[str, ...]] = {
    "hospital": ('["amenity"~"^(hospital|clinic)$"]',),
    "shelter": (
        '["amenity"="shelter"]',
        '["emergency"="assembly_point"]',
        '["social_facility"="shelter"]',
    ),
    "police": ('["amenity"="police"]',),
    "fire_station": ('["amenity"="fire_station"]',),
    "pharmacy": ('["amenity"="pharmacy"]',),
}

#: Python equivalent of :data:`PLACE_FILTERS` (tag key -> accepted values), used to sort the
#: elements of a combined query back into their types.
PLACE_MATCHERS: dict[str, tuple[tuple[str, frozenset[str]], ...]] = {
    "hospital": (("amenity", frozenset({"hospital", "clinic"})),),
    "shelter": (
        ("amenity", frozenset({"shelter"})),
        ("emergency", frozenset({"assembly_point"})),
        ("social_facility", frozenset({"shelter"})),
    ),
    "police": (("amenity", frozenset({"police"})),),
    "fire_station": (("amenity", frozenset({"fire_station"})),),
    "pharmacy": (("amenity", frozenset({"pharmacy"})),),
}

#: Human labels used for the ``"Unnamed <type>"`` fallback.
PLACE_LABELS: dict[str, str] = {
    "hospital": "hospital",
    "shelter": "shelter",
    "police": "police station",
    "fire_station": "fire station",
    "pharmacy": "pharmacy",
}

_NAME_TAGS = ("name", "name:en", "official_name", "short_name", "operator")
_PHONE_TAGS = ("phone", "contact:phone", "emergency:phone", "contact:mobile", "mobile")
_CITY_TAGS = ("addr:city", "addr:town", "addr:village", "addr:municipality")


class OverpassBusyError(UpstreamError):
    """Overpass answered 429 or no local query slot became free in time (502, retry soon)."""


#: Places of one view, per type.
PlacesByType = dict[str, tuple["RawPlace", ...]]


@dataclass(frozen=True, slots=True)
class _View:
    """Cached answer of one combined query."""

    #: Places per type; a partial answer only has the types it searched completely.
    places: PlacesByType
    complete: bool


@dataclass(frozen=True, slots=True)
class RawPlace:
    """A parsed OSM element before the distance to the caller is known."""

    id: str
    name: str
    lat: float
    lon: float
    address: str | None
    phone: str | None

    def to_place(self, place_type: PlaceType, lat: float, lon: float) -> Place:
        return Place(
            id=self.id,
            name=self.name,
            type=place_type,
            lat=self.lat,
            lon=self.lon,
            distance_km=round(haversine_km(lat, lon, self.lat, self.lon), 3),
            address=self.address,
            phone=self.phone,
        )


class PlacesService:
    """Hospitals, shelters, police, fire stations and pharmacies near a point."""

    def __init__(self, http: httpx.AsyncClient, cache: TTLCache, settings: Settings) -> None:
        self.http = http
        self.cache = cache
        self.settings = settings
        self.url = settings.overpass_url
        # Overpass declares its own server-side time limit; keep it inside our HTTP timeout.
        self._server_timeout_s = max(5, math.ceil(settings.http_timeout_seconds))
        self._request_timeout_s = self._server_timeout_s + TRANSFER_MARGIN_SECONDS
        self._slots = asyncio.Semaphore(settings.overpass_max_concurrency)
        #: Tunables (tests shorten them).
        self.slot_wait_seconds = MAX_SLOT_WAIT_SECONDS
        self.retry_delay_seconds = OVERPASS_RETRY_DELAY_SECONDS
        self.request_budget_seconds = REQUEST_BUDGET_SECONDS

    async def get_places(
        self,
        lat: float,
        lon: float,
        place_type: PlaceType,
        radius_m: int = DEFAULT_PLACES_RADIUS_M,
        *,
        limit: int = DEFAULT_PLACES_LIMIT,
    ) -> list[Place]:
        """Places of ``place_type`` within ``radius_m`` (clamped 500-20000), nearest first.

        Args:
            lat, lon: Query point (validated; 422 when out of range).
            place_type: One of :data:`~app.schemas.places.PLACE_TYPES`.
            radius_m: Search radius in metres, clamped to [500, 20000].
            limit: Maximum number of places returned (1..200).

        Raises:
            InvalidInputError: bad coordinates or unknown place type (422).
            UpstreamError: Overpass unavailable or returned an unusable answer (502).
        """
        lat, lon = validate_coordinates(lat, lon)
        if place_type not in PLACE_FILTERS:
            raise InvalidInputError(f"Unknown place type {place_type!r}")
        radius = clamp_radius(radius_m)
        limit = int(clamp(limit, 1, MAX_PLACES_LIMIT))

        view = await self._view(lat, lon, radius_tier(radius))
        items = view.places.get(place_type)
        if items is None:
            # Partial answer that never reached this type: unknown, not "nothing nearby".
            raise UpstreamError(
                "OpenStreetMap (Overpass) could not complete the search. Please retry shortly."
            )
        radius_km = radius / 1000.0
        places = [
            place
            for place in (item.to_place(place_type, lat, lon) for item in items)
            if place.distance_km <= radius_km
        ]
        places.sort(key=lambda p: (p.distance_km, p.name.lower(), p.id))
        return places[:limit]

    # ------------------------------------------------------------------------------------------
    # Views (one cached combined query per coarse cell and radius tier)
    # ------------------------------------------------------------------------------------------
    def _raise_remembered_failure(self, failed_key: tuple[Any, ...]) -> None:
        failure = self.cache.get(failed_key)
        if failure is None:
            return
        error_class, message = failure
        raise error_class(message)

    async def _view(self, lat: float, lon: float, tier: int) -> _View:
        cell = (round_coord(lat, CELL_DECIMALS), round_coord(lon, CELL_DECIMALS))
        key = ("places-view", *cell, tier)
        failed_key = ("places-failed", *cell, tier)
        self._raise_remembered_failure(failed_key)

        async def _load() -> _View:
            # Requests that queued behind a failed load must not query again right away.
            self._raise_remembered_failure(failed_key)
            try:
                return await self._fetch_limited(cell[0], cell[1], tier + CELL_SLACK_M)
            except OverpassBusyError as exc:
                self.cache.set(
                    failed_key, (OverpassBusyError, exc.message), BUSY_FAILURE_TTL_SECONDS
                )
                raise
            except UpstreamError as exc:
                self.cache.set(failed_key, (UpstreamError, exc.message), FAILURE_TTL_SECONDS)
                raise

        def _ttl(view: _View) -> float:
            ttl = float(self.settings.places_cache_ttl)
            return ttl if view.complete else min(ttl, PARTIAL_RESULT_TTL_SECONDS)

        return await self.cache.get_or_set(key, _ttl, _load)

    # ------------------------------------------------------------------------------------------
    # Upstream
    # ------------------------------------------------------------------------------------------
    async def _fetch_limited(self, lat: float, lon: float, radius_m: int) -> _View:
        """:meth:`_fetch` behind the Overpass slot semaphore, within the request budget."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.request_budget_seconds
        wait = min(self.slot_wait_seconds, deadline - loop.time() - MIN_ATTEMPT_SECONDS)
        busy = OverpassBusyError("OpenStreetMap (Overpass) is busy. Please retry in a moment.")
        if wait <= 0 and self._slots.locked():
            raise busy
        try:
            async with asyncio.timeout(max(0.0, wait)):
                await self._slots.acquire()
        except TimeoutError as exc:
            logger.warning("No free Overpass slot within %.1fs", max(0.0, wait))
            raise busy from exc
        try:
            try:
                return await self._fetch(lat, lon, radius_m, deadline)
            except OverpassBusyError:
                left = deadline - loop.time() - self.retry_delay_seconds
                if left < MIN_ATTEMPT_SECONDS:
                    raise
                logger.info("Overpass busy; retrying once")
                await asyncio.sleep(self.retry_delay_seconds)
                return await self._fetch(lat, lon, radius_m, deadline)
        finally:
            self._slots.release()

    async def _fetch(self, lat: float, lon: float, radius_m: int, deadline: float) -> _View:
        remaining = deadline - asyncio.get_running_loop().time()
        timeout = max(1.0, min(self._request_timeout_s, remaining))
        server_timeout = overpass_server_timeout(timeout, self._server_timeout_s)
        query = build_overpass_view_query(lat, lon, radius_m, server_timeout)
        too_slow = UpstreamError(
            "OpenStreetMap (Overpass) took too long to answer. Please retry shortly."
        )
        try:
            # httpx bounds each phase and each read separately; this bounds the whole
            # request, including an answer that keeps trickling in.
            async with asyncio.timeout_at(deadline):
                response = await self.http.post(
                    self.url, data={"data": query}, timeout=httpx.Timeout(timeout)
                )
        except TimeoutError as exc:
            logger.warning("Overpass exceeded the request budget (radius=%dm)", radius_m)
            raise too_slow from exc
        except httpx.TimeoutException as exc:
            logger.warning("Overpass timed out (radius=%dm): %s", radius_m, type(exc).__name__)
            raise too_slow from exc
        except httpx.HTTPError as exc:
            logger.warning("Overpass request failed: %s", type(exc).__name__)
            raise UpstreamError("OpenStreetMap (Overpass) is unreachable.") from exc

        if response.status_code != 200:
            logger.warning("Overpass returned HTTP %d (radius=%dm)", response.status_code, radius_m)
            if response.status_code == 429:
                raise OverpassBusyError(
                    "OpenStreetMap (Overpass) is busy. Please retry in a moment."
                )
            raise UpstreamError(f"OpenStreetMap (Overpass) error (HTTP {response.status_code}).")

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning("Overpass returned a non-JSON body")
            raise UpstreamError("OpenStreetMap (Overpass) returned an invalid response.") from exc

        places, complete = parse_overpass_view(payload)
        logger.debug(
            "Overpass view @ (%.2f, %.2f) r=%dm -> %s%s",
            lat,
            lon,
            radius_m,
            {kind: len(items) for kind, items in places.items()},
            "" if complete else " (partial)",
        )
        return _View(places=places, complete=complete)


# ---------------------------------------------------------------------------------------------
# Query building & parsing (pure functions, unit tested)
# ---------------------------------------------------------------------------------------------
def clamp_radius(radius_m: float) -> int:
    """Clamp a radius in metres to [:data:`MIN_PLACES_RADIUS_M`, :data:`MAX_PLACES_RADIUS_M`]."""
    if not isinstance(radius_m, int | float) or not math.isfinite(radius_m):
        return DEFAULT_PLACES_RADIUS_M
    return int(clamp(round(radius_m), MIN_PLACES_RADIUS_M, MAX_PLACES_RADIUS_M))


def overpass_server_timeout(http_timeout: float, configured: int) -> int:
    """Overpass ``[timeout:N]`` for a request allowed ``http_timeout`` seconds in total.

    Leaves up to :data:`TRANSFER_MARGIN_SECONDS` (at most half the time) for the transfer, so
    the server-side limit never exceeds what is left of the request budget.
    """
    transfer = min(TRANSFER_MARGIN_SECONDS, http_timeout / 2)
    return max(1, min(configured, math.floor(http_timeout - transfer)))


def radius_tier(radius_m: int) -> int:
    """Smallest :data:`RADIUS_TIERS_M` entry covering ``radius_m`` (already clamped)."""
    for tier in RADIUS_TIERS_M:
        if radius_m <= tier:
            return tier
    return RADIUS_TIERS_M[-1]


def _statements(place_type: str, around: str) -> str:
    return "\n".join(f"  nwr{tag_filter}{around};" for tag_filter in PLACE_FILTERS[place_type])


def build_overpass_query(
    place_type: str, lat: float, lon: float, radius_m: int, timeout_s: int = 25
) -> str:
    """Overpass QL union of every tag filter of ``place_type`` around (lat, lon).

    ``nwr`` covers nodes, ways and relations; ``out center`` gives ways/relations a centroid.
    """
    around = f"(around:{int(radius_m)},{lat:.6f},{lon:.6f})"
    return (
        f"[out:json][timeout:{int(timeout_s)}];\n"
        f"(\n{_statements(place_type, around)}\n);\n"
        f"out tags center {OVERPASS_MAX_ELEMENTS};"
    )


def build_overpass_view_query(lat: float, lon: float, radius_m: int, timeout_s: int = 25) -> str:
    """One Overpass QL query returning every place type around (lat, lon).

    Each type is a separate union followed by its own ``out`` (so each type has its own
    :data:`OVERPASS_MAX_ELEMENTS` cap) and an ``out count;`` marker that shows the type was
    searched completely; the answers are concatenated in one ``elements`` list (types in
    :data:`PLACE_FILTERS` order) and sorted back into types by :func:`parse_overpass_view`.
    """
    around = f"(around:{int(radius_m)},{lat:.6f},{lon:.6f})"
    blocks = "\n".join(
        f"(\n{_statements(place_type, around)}\n);\n"
        f"out tags center {OVERPASS_MAX_ELEMENTS};\nout count;"
        for place_type in PLACE_FILTERS
    )
    return f"[out:json][timeout:{int(timeout_s)}];\n{blocks}"


def place_types_of(tags: Mapping[str, Any]) -> list[str]:
    """Place types whose filters match ``tags`` (usually one)."""
    return [
        place_type
        for place_type, matchers in PLACE_MATCHERS.items()
        if any(tags.get(key) in values for key, values in matchers)
    ]


def _elements(payload: Any, context: str) -> tuple[list[Any], bool]:
    """``(elements, complete)`` of an Overpass JSON answer; raises when it is unusable.

    A server-side runtime error (reported in ``remark`` with HTTP 200) without elements, or
    a malformed payload, raises :class:`UpstreamError`; with elements the answer is kept
    but flagged incomplete.
    """
    if not isinstance(payload, Mapping):
        raise UpstreamError("OpenStreetMap (Overpass) returned an invalid response.")
    elements = payload.get("elements")
    remark = payload.get("remark")
    complete = True
    if isinstance(remark, str) and "error" in remark.lower():
        # e.g. "runtime error: Query timed out in "query" at line 3 after 26 seconds."
        logger.warning("Overpass runtime error for %s: %s", context, remark[:200])
        if not elements:
            raise UpstreamError("OpenStreetMap (Overpass) could not complete the search.")
        complete = False
    if not isinstance(elements, list):
        raise UpstreamError("OpenStreetMap (Overpass) returned an invalid response.")
    return elements, complete


def parse_overpass_elements(payload: Any, place_type: str) -> list[RawPlace]:
    """Parse an Overpass JSON answer into :class:`RawPlace` objects (unsorted, de-duplicated).

    Every element is taken as ``place_type`` (single-type query). Elements without usable
    coordinates are skipped. A server-side runtime error (reported in ``remark`` with HTTP
    200) or a malformed payload raises :class:`UpstreamError`.
    """
    elements, _ = _elements(payload, place_type)
    label = PLACE_LABELS.get(place_type, place_type.replace("_", " "))
    seen: set[str] = set()
    places: list[RawPlace] = []
    for element in elements:
        place = _parse_element(element, label)
        if place is None or place.id in seen:
            continue
        seen.add(place.id)
        places.append(place)
    return places


def parse_overpass_view(payload: Any) -> tuple[PlacesByType, bool]:
    """Parse the answer of :func:`build_overpass_view_query`: ``(places per type, complete)``.

    Elements are sorted into types by their tags (:func:`place_types_of`); an element that
    matches no type is skipped, one that matches several is listed under each.

    In a partial answer (runtime-error ``remark``) only the types whose ``out count`` marker
    arrived are included; a missing key means "unknown", never "nothing found". A partial
    answer that did not finish a single type raises :class:`UpstreamError`.
    """
    elements, complete = _elements(payload, "places view")
    found: dict[str, dict[str, RawPlace]] = {place_type: {} for place_type in PLACE_FILTERS}
    finished = 0  # type blocks (in PLACE_FILTERS order) whose count marker arrived
    for element in elements:
        if not isinstance(element, Mapping):
            continue
        if element.get("type") == "count":
            finished += 1
            continue
        tags = element.get("tags")
        for place_type in place_types_of(tags if isinstance(tags, Mapping) else {}):
            bucket = found[place_type]
            place = _parse_element(element, PLACE_LABELS[place_type])
            if place is not None and place.id not in bucket:
                bucket[place.id] = place
    known = list(PLACE_FILTERS) if complete else list(PLACE_FILTERS)[:finished]
    if not known:
        raise UpstreamError("OpenStreetMap (Overpass) could not complete the search.")
    if not complete:
        logger.warning("Partial Overpass view: only %s searched completely", ", ".join(known))
    return {place_type: tuple(found[place_type].values()) for place_type in known}, complete


def _parse_element(element: Any, label: str) -> RawPlace | None:
    if not isinstance(element, Mapping):
        return None
    kind = element.get("type")
    osm_id = element.get("id")
    if kind not in {"node", "way", "relation"} or osm_id is None:
        return None
    coords = _coordinates(element)
    if coords is None:
        return None
    tags = element.get("tags")
    tags = tags if isinstance(tags, Mapping) else {}
    return RawPlace(
        id=f"{kind}/{osm_id}",
        name=_first_tag(tags, _NAME_TAGS) or f"Unnamed {label}",
        lat=coords[0],
        lon=coords[1],
        address=format_address(tags),
        phone=_phone(tags),
    )


def _coordinates(element: Mapping[str, Any]) -> tuple[float, float] | None:
    """Node ``lat``/``lon`` or the ``center`` of a way/relation, validated."""
    source: Any = element
    if element.get("lat") is None or element.get("lon") is None:
        source = element.get("center")
    if not isinstance(source, Mapping):
        return None
    try:
        lat = float(source["lat"])
        lon = float(source["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon


def format_address(tags: Mapping[str, Any]) -> str | None:
    """Human-readable address from ``addr:*`` tags (``None`` when there are none).

    ``{"addr:housenumber": "12", "addr:street": "MG Road", "addr:city": "Pune",
    "addr:postcode": "411001"}`` -> ``"12 MG Road, Pune 411001"``.
    """
    full = _tag(tags, "addr:full")
    if full:
        return full
    street = " ".join(
        part for part in (_tag(tags, "addr:housenumber"), _tag(tags, "addr:street")) if part
    ) or _tag(tags, "addr:place")
    city = _first_tag(tags, _CITY_TAGS)
    postcode = _tag(tags, "addr:postcode")
    locality = " ".join(part for part in (city, postcode) if part) or None
    parts = _unique(
        part for part in (street, _tag(tags, "addr:suburb"), locality, _tag(tags, "addr:state"))
    )
    return ", ".join(parts) if parts else None


def _phone(tags: Mapping[str, Any]) -> str | None:
    value = _first_tag(tags, _PHONE_TAGS)
    if not value:
        return None
    # Multiple numbers are separated by ';' in OSM — the first one is the main line.
    first = value.split(";")[0].strip()
    return first[:40] or None


def _tag(tags: Mapping[str, Any], key: str) -> str | None:
    value = tags.get(key)
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:200] or None


def _first_tag(tags: Mapping[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = _tag(tags, key)
        if value:
            return value
    return None


def _unique(values: Iterable[str | None]) -> list[str]:
    out: list[str] = []
    for value in values:
        if value and value not in out:
            out.append(value)
    return out


__all__ = [
    "DEFAULT_PLACES_LIMIT",
    "MAX_PLACES_LIMIT",
    "OVERPASS_URL",
    "PLACE_FILTERS",
    "PLACE_MATCHERS",
    "RADIUS_TIERS_M",
    "OverpassBusyError",
    "PlacesService",
    "RawPlace",
    "build_overpass_query",
    "build_overpass_view_query",
    "clamp_radius",
    "format_address",
    "overpass_server_timeout",
    "parse_overpass_elements",
    "parse_overpass_view",
    "place_types_of",
    "radius_tier",
]
