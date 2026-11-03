"""Tests for nearby places: :mod:`app.services.places` and ``/api/places`` (+ legacy routes).

Overpass is mocked with respx; no test reaches the network.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.errors import InvalidInputError, UpstreamError
from app.main import create_app
from app.services import places as places_module
from app.services.cache import TTLCache
from app.services.geo import haversine_km
from app.services.places import (
    OVERPASS_URL,
    PlacesService,
    build_overpass_query,
    clamp_radius,
    format_address,
    parse_overpass_elements,
    parse_overpass_view,
    radius_tier,
)

DELHI = (28.6139, 77.2090)

OVERPASS_HOSPITALS: dict[str, Any] = {
    "version": 0.6,
    "generator": "Overpass API 0.7.62",
    "elements": [
        {
            "type": "node",
            "id": 101,
            "lat": 28.6200,
            "lon": 77.2100,
            "tags": {
                "amenity": "hospital",
                "name": "City Hospital",
                "addr:housenumber": "12",
                "addr:street": "Ring Road",
                "addr:city": "New Delhi",
                "addr:postcode": "110001",
                "phone": "+91 11 2345 6789;+91 11 2345 0000",
            },
        },
        # Way with a centroid and no name -> "Unnamed hospital", nearest of all.
        {
            "type": "way",
            "id": 202,
            "center": {"lat": 28.6140, "lon": 77.2092},
            "tags": {"amenity": "clinic"},
        },
        # ~5.7 km away: outside a 5 km radius, inside 10 km.
        {
            "type": "relation",
            "id": 303,
            "center": {"lat": 28.65, "lon": 77.25},
            "tags": {"amenity": "hospital", "name:en": "Far Hospital", "contact:phone": "011-555"},
        },
        {"type": "node", "id": 404, "tags": {"name": "No coordinates"}},
        {"type": "node", "id": 101, "lat": 28.6200, "lon": 77.2100, "tags": {"name": "Dup"}},
        {"type": "node", "id": 505, "lat": 95.0, "lon": 77.0, "tags": {"name": "Bad lat"}},
        "garbage",
    ],
}


#: One element of every type (two shelters, one unnamed) around DELHI, plus noise.
MIXED_VIEW: dict[str, Any] = {
    "elements": [
        {
            "type": "node",
            "id": 1,
            "lat": 28.615,
            "lon": 77.21,
            "tags": {"amenity": "hospital", "name": "H"},
        },
        {
            "type": "node",
            "id": 2,
            "lat": 28.616,
            "lon": 77.21,
            "tags": {"amenity": "shelter", "name": "S"},
        },
        {
            "type": "node",
            "id": 3,
            "lat": 28.617,
            "lon": 77.21,
            "tags": {"emergency": "assembly_point"},
        },
        {
            "type": "node",
            "id": 4,
            "lat": 28.618,
            "lon": 77.21,
            "tags": {"amenity": "police", "name": "P"},
        },
        {"type": "node", "id": 5, "lat": 28.619, "lon": 77.21, "tags": {"amenity": "fire_station"}},
        {"type": "node", "id": 6, "lat": 28.62, "lon": 77.21, "tags": {"amenity": "pharmacy"}},
        {"type": "node", "id": 7, "lat": 28.62, "lon": 77.21, "tags": {"amenity": "school"}},
        {"type": "node", "id": 1, "lat": 28.615, "lon": 77.21, "tags": {"amenity": "hospital"}},
    ]
}


def _query_of(call: Any) -> str:
    """The Overpass QL sent in a respx call (form-encoded ``data=``)."""
    return parse_qs(call.request.content.decode())["data"][0]


# ---------------------------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------------------------
def test_parse_overpass_elements_normalises_and_skips_bad_entries() -> None:
    places = parse_overpass_elements(OVERPASS_HOSPITALS, "hospital")
    by_id = {place.id: place for place in places}

    assert set(by_id) == {"node/101", "way/202", "relation/303"}
    city = by_id["node/101"]
    assert city.name == "City Hospital"
    assert city.address == "12 Ring Road, New Delhi 110001"
    assert city.phone == "+91 11 2345 6789"
    assert by_id["way/202"].name == "Unnamed hospital"
    assert (by_id["way/202"].lat, by_id["way/202"].lon) == (28.6140, 77.2092)
    assert by_id["relation/303"].name == "Far Hospital"
    assert by_id["relation/303"].phone == "011-555"


def test_unnamed_label_uses_readable_type() -> None:
    payload = {"elements": [{"type": "node", "id": 1, "lat": 1.0, "lon": 2.0}]}
    assert parse_overpass_elements(payload, "fire_station")[0].name == "Unnamed fire station"
    assert parse_overpass_elements(payload, "police")[0].name == "Unnamed police station"


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"elements": "nope"},
        {"remark": 'runtime error: Query timed out in "query" at line 3', "elements": []},
    ],
)
def test_parse_overpass_rejects_unusable_payloads(payload: Any) -> None:
    with pytest.raises(UpstreamError):
        parse_overpass_elements(payload, "hospital")


def test_parse_overpass_keeps_partial_results_with_remark() -> None:
    payload = {
        "remark": "runtime error: out of memory",
        "elements": [{"type": "node", "id": 9, "lat": 1.0, "lon": 1.0, "tags": {"name": "X"}}],
    }
    assert [p.id for p in parse_overpass_elements(payload, "pharmacy")] == ["node/9"]


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"addr:full": "Plot 4, Sector 62, Noida"}, "Plot 4, Sector 62, Noida"),
        ({"addr:street": "MG Road", "addr:town": "Kochi"}, "MG Road, Kochi"),
        ({"addr:city": "Pune", "addr:postcode": "411001"}, "Pune 411001"),
        (
            {"addr:place": "Old Market", "addr:suburb": "Karol Bagh", "addr:state": "Delhi"},
            "Old Market, Karol Bagh, Delhi",
        ),
        ({"name": "No address"}, None),
        ({"addr:street": "   "}, None),
    ],
)
def test_format_address(tags: dict[str, str], expected: str | None) -> None:
    assert format_address(tags) == expected


def test_build_overpass_query_per_type() -> None:
    hospital = build_overpass_query("hospital", 28.6, 77.2, 5000, 10)
    assert hospital.startswith("[out:json][timeout:10];")
    assert 'nwr["amenity"~"^(hospital|clinic)$"](around:5000,28.600000,77.200000);' in hospital
    assert "out tags center" in hospital

    shelter = build_overpass_query("shelter", 1.0, 2.0, 800)
    for tag_filter in (
        '["amenity"="shelter"]',
        '["emergency"="assembly_point"]',
        '["social_facility"="shelter"]',
    ):
        assert f"nwr{tag_filter}(around:800," in shelter

    assert '["amenity"="fire_station"]' in build_overpass_query("fire_station", 0, 0, 500)
    assert '["amenity"="police"]' in build_overpass_query("police", 0, 0, 500)
    assert '["amenity"="pharmacy"]' in build_overpass_query("pharmacy", 0, 0, 500)


@pytest.mark.parametrize(
    ("radius", "expected"),
    [(100, 500), (500, 500), (5000, 5000), (50_000, 20_000), (float("nan"), 5000)],
)
def test_clamp_radius(radius: float, expected: int) -> None:
    assert clamp_radius(radius) == expected


# ---------------------------------------------------------------------------------------------
# Service (respx-mocked Overpass)
# ---------------------------------------------------------------------------------------------
@pytest.fixture
async def service(settings: Settings) -> AsyncIterator[PlacesService]:
    async with httpx.AsyncClient() as http:
        places = PlacesService(http, TTLCache(), settings)
        places.retry_delay_seconds = 0.0
        yield places


async def test_get_places_filters_sorts_and_measures(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, json=OVERPASS_HOSPITALS)
    )

    places = await service.get_places(*DELHI, "hospital", 5000)

    assert [p.id for p in places] == ["way/202", "node/101"]
    assert all(p.type == "hospital" for p in places)
    assert places[0].distance_km < places[1].distance_km
    assert places[1].distance_km == pytest.approx(0.685, abs=0.01)
    query = _query_of(route.calls.last)
    # Centred on the ~1.1 km cache cell, radius tier widened by the cell slack.
    assert "(around:5800,28.610000,77.210000)" in query
    assert route.calls.last.request.headers["content-type"].startswith(
        "application/x-www-form-urlencoded"
    )


async def test_get_places_larger_radius_and_limit(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=OVERPASS_HOSPITALS))

    places = await service.get_places(*DELHI, "hospital", 10_000)
    assert [p.id for p in places] == ["way/202", "node/101", "relation/303"]

    nearest = await service.get_places(*DELHI, "hospital", 10_000, limit=1)
    assert [p.id for p in nearest] == ["way/202"]


async def test_get_places_is_cached_per_cell(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, json=OVERPASS_HOSPITALS)
    )

    first = await service.get_places(28.61391, 77.20901, "hospital")
    second = await service.get_places(28.61389, 77.20899, "hospital")

    assert route.call_count == 1
    assert [p.id for p in first] == [p.id for p in second]
    # Distances are computed against each caller's exact point, not the cached cell.
    assert first[1].distance_km == round(haversine_km(28.61391, 77.20901, 28.62, 77.21), 3)
    assert second[1].distance_km == round(haversine_km(28.61389, 77.20899, 28.62, 77.21), 3)


async def test_radius_is_clamped_in_query(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, json={"elements": []})
    )

    assert await service.get_places(*DELHI, "pharmacy", 50) == []
    assert "(around:1800," in _query_of(route.calls.last)  # 500 m -> 1 km tier + 800 m slack
    await service.get_places(*DELHI, "pharmacy", 99_000)
    assert "(around:20800," in _query_of(route.calls.last)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(504, text="Gateway Timeout"),
        httpx.Response(429, text="Too Many Requests"),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={"remark": "runtime error: timeout", "elements": []}),
    ],
)
async def test_upstream_failures_raise(
    service: PlacesService, respx_mock: respx.MockRouter, response: httpx.Response
) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=response)
    with pytest.raises(UpstreamError):
        await service.get_places(*DELHI, "police")


@pytest.mark.parametrize(
    "error", [httpx.ConnectError("refused"), httpx.ReadTimeout("slow")], ids=["connect", "timeout"]
)
async def test_transport_errors_raise_and_are_briefly_remembered(
    service: PlacesService, respx_mock: respx.MockRouter, error: Exception
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(side_effect=error)

    with pytest.raises(UpstreamError):
        await service.get_places(*DELHI, "shelter")
    # A retry right away is answered from the failure cache without hitting Overpass again.
    with pytest.raises(UpstreamError):
        await service.get_places(*DELHI, "shelter")
    assert route.call_count == 1


async def test_invalid_input(service: PlacesService) -> None:
    with pytest.raises(InvalidInputError):
        await service.get_places(91.0, 0.0, "hospital")
    with pytest.raises(InvalidInputError):
        await service.get_places(0.0, 0.0, "school")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------------------------
def test_places_endpoint(client: TestClient, respx_mock: respx.MockRouter) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=OVERPASS_HOSPITALS))

    response = client.get(
        "/api/places", params={"lat": DELHI[0], "lon": DELHI[1], "type": "hospital"}
    )

    assert response.status_code == 200
    body = response.json()
    assert list(body) == ["places"]
    first = body["places"][0]
    assert set(first) == {"id", "name", "type", "lat", "lon", "distance_km", "address", "phone"}
    assert first["id"] == "way/202"
    assert first["address"] is None
    assert [p["name"] for p in body["places"]] == ["Unnamed hospital", "City Hospital"]


def test_places_endpoint_limit(client: TestClient, respx_mock: respx.MockRouter) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=OVERPASS_HOSPITALS))
    response = client.get(
        "/api/places",
        params={"lat": DELHI[0], "lon": DELHI[1], "type": "hospital", "radius": 10_000, "limit": 2},
    )
    assert response.status_code == 200
    assert len(response.json()["places"]) == 2


@pytest.mark.parametrize(
    "params",
    [
        {"lat": DELHI[0], "lon": DELHI[1], "type": "school"},
        {"lat": DELHI[0], "lon": DELHI[1]},
        {"lat": 100, "lon": DELHI[1], "type": "hospital"},
        {"lat": DELHI[0], "lon": DELHI[1], "type": "hospital", "radius": 0},
        {"lon": DELHI[1], "type": "hospital"},
    ],
)
def test_places_endpoint_validation(client: TestClient, params: dict[str, Any]) -> None:
    response = client.get("/api/places", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_places_endpoint_upstream_error(client: TestClient, respx_mock: respx.MockRouter) -> None:
    respx_mock.post(OVERPASS_URL).mock(side_effect=httpx.ConnectError("down"))

    response = client.get(
        "/api/places", params={"lat": DELHI[0], "lon": DELHI[1], "type": "pharmacy"}
    )

    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "upstream_error"
    assert error["request_id"]


@pytest.mark.parametrize(
    ("path", "key", "tags", "tag_filter"),
    [
        ("/api/hospitals", "hospitals", {"amenity": "clinic"}, '"amenity"~"^(hospital|clinic)$"'),
        (
            "/api/shelters",
            "shelters",
            {"emergency": "assembly_point"},
            '"emergency"="assembly_point"',
        ),
        ("/api/police", "police", {"amenity": "police"}, '"amenity"="police"'),
        (
            "/api/fire-stations",
            "fire_stations",
            {"amenity": "fire_station"},
            '"amenity"="fire_station"',
        ),
    ],
)
def test_legacy_endpoints(
    client: TestClient,
    respx_mock: respx.MockRouter,
    path: str,
    key: str,
    tags: dict[str, str],
    tag_filter: str,
) -> None:
    payload = {
        "elements": [
            {"type": "node", "id": 101, "lat": 28.62, "lon": 77.21, "tags": {**tags, "name": "A"}},
            {"type": "way", "id": 202, "center": {"lat": 28.614, "lon": 77.2092}, "tags": tags},
            # Another type in the same answer is not listed under this endpoint.
            {
                "type": "node",
                "id": 9,
                "lat": 28.614,
                "lon": 77.209,
                "tags": {"amenity": "pharmacy"},
            },
        ]
    }
    route = respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=payload))

    response = client.get(path, params={"lat": DELHI[0], "lon": DELHI[1], "radius": 2000})

    assert response.status_code == 200
    body = response.json()
    assert list(body) == [key]
    assert {p["id"] for p in body[key]} == {"way/202", "node/101"}
    query = _query_of(route.calls.last)
    assert tag_filter in query
    assert "(around:2800," in query


# ---------------------------------------------------------------------------------------------
# Overpass concurrency (the public instance allows ~2 queries per client IP)
# ---------------------------------------------------------------------------------------------
async def test_overpass_queries_are_bounded_per_process(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    active = 0
    peak = 0

    async def slow(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        return httpx.Response(200, json={"elements": []})

    route = respx_mock.post(OVERPASS_URL).mock(side_effect=slow)
    # Five map views far apart: five upstream queries, at most two at a time.
    points = [(10.0 + i, 70.0 + i) for i in range(5)]
    results = await asyncio.gather(
        *(service.get_places(lat, lon, "hospital") for lat, lon in points)
    )
    assert results == [[]] * 5
    assert route.call_count == 5
    assert peak == places_module.MAX_CONCURRENT_OVERPASS == 2


async def test_all_layers_of_one_view_share_one_overpass_query(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    """Regression: every layer was its own query, so a 5-layer map (or two users opening the
    map at once) queued behind the 2 Overpass slots and lost layers with 502 "busy"."""

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=MIXED_VIEW)

    route = respx_mock.post(OVERPASS_URL).mock(side_effect=slow)
    types = ["hospital", "shelter", "police", "fire_station", "pharmacy"]
    results = await asyncio.gather(*(service.get_places(*DELHI, t, 5000) for t in types))
    assert route.call_count == 1
    by_type = {t: [p.id for p in places] for t, places in zip(types, results, strict=True)}
    assert by_type == {
        "hospital": ["node/1"],
        "shelter": ["node/2", "node/3"],
        "police": ["node/4"],
        "fire_station": ["node/5"],
        "pharmacy": ["node/6"],
    }
    query = _query_of(route.calls.last)
    for tag_filter in (
        '"amenity"="police"',
        '"amenity"="pharmacy"',
        '"emergency"="assembly_point"',
    ):
        assert tag_filter in query
    assert query.count("out tags center") == 5  # one element cap per type

    # Any radius up to the tier, and any point in the same ~1 km cell, reuse that answer.
    for radius in (2500, 4999):
        await service.get_places(DELHI[0] - 0.002, DELHI[1] - 0.002, "hospital", radius)
    await service.get_places(*DELHI, "hospital", 1000)  # 1 km tier: one more query
    assert route.call_count == 2


async def test_second_user_in_another_area_is_not_starved(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    """Two users opening the map at once (4 layers each) need only two queries."""

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=MIXED_VIEW)

    route = respx_mock.post(OVERPASS_URL).mock(side_effect=slow)
    service.slot_wait_seconds = 0.08  # less than two queued queries would need
    types = ["hospital", "shelter", "police", "fire_station"]
    calls = [service.get_places(*DELHI, t) for t in types] + [
        service.get_places(19.076, 72.8777, t) for t in types
    ]
    results = await asyncio.gather(*calls, return_exceptions=True)
    assert not [r for r in results if isinstance(r, BaseException)]
    assert route.call_count == 2


async def test_slot_wait_never_exceeds_the_request_budget(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, json={"elements": []})
    )
    service.request_budget_seconds = places_module.MIN_ATTEMPT_SECONDS + 0.05
    for _ in range(places_module.MAX_CONCURRENT_OVERPASS):
        await service._slots.acquire()
    try:
        started = asyncio.get_running_loop().time()
        with pytest.raises(places_module.OverpassBusyError):
            await service.get_places(*DELHI, "pharmacy")
        assert asyncio.get_running_loop().time() - started < 1  # not the 8 s slot wait
    finally:
        for _ in range(places_module.MAX_CONCURRENT_OVERPASS):
            service._slots.release()
    assert route.call_count == 0


#: ``out count;`` element Overpass writes after each type's block of a view query.
COUNT_MARKER: dict[str, Any] = {
    "type": "count",
    "id": 0,
    "tags": {"nodes": "1", "ways": "0", "relations": "0", "total": "1"},
}
#: Overpass ran out of time after the hospital block (shelter, police, ... never ran).
PARTIAL_VIEW: dict[str, Any] = {
    "remark": 'runtime error: Query timed out in "query" at line 9 after 10 seconds.',
    "elements": [*MIXED_VIEW["elements"][:1], COUNT_MARKER],
}


async def test_partial_answers_are_cached_briefly(
    service: PlacesService, respx_mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=PARTIAL_VIEW))
    stored: list[float] = []
    real_set = service.cache.set

    def recording_set(key: Any, value: Any, ttl: float) -> None:
        if key[0] == "places-view":
            stored.append(ttl)
        real_set(key, value, ttl)

    monkeypatch.setattr(service.cache, "set", recording_set)
    assert [p.id for p in await service.get_places(*DELHI, "hospital")] == ["node/1"]
    assert stored == [places_module.PARTIAL_RESULT_TTL_SECONDS]


def test_configurable_overpass_endpoint_and_concurrency(
    settings_factory: Any, respx_mock: respx.MockRouter
) -> None:
    custom = "https://overpass.internal.example/api/interpreter"
    settings = settings_factory(overpass_url=custom, overpass_max_concurrency=8)
    route = respx_mock.post(custom).mock(return_value=httpx.Response(200, json=MIXED_VIEW))
    with TestClient(create_app(settings)) as client:
        assert client.app.state.places._slots._value == 8  # type: ignore[attr-defined]
        response = client.get(
            "/api/places", params={"lat": DELHI[0], "lon": DELHI[1], "type": "police"}
        )
    assert response.status_code == 200
    assert [p["id"] for p in response.json()["places"]] == ["node/4"]
    assert route.call_count == 1


def test_parse_overpass_view_sorts_elements_into_types() -> None:
    places, complete = parse_overpass_view(MIXED_VIEW)
    assert complete
    assert {t: [p.id for p in items] for t, items in places.items()} == {
        "hospital": ["node/1"],
        "shelter": ["node/2", "node/3"],
        "police": ["node/4"],
        "fire_station": ["node/5"],
        "pharmacy": ["node/6"],
    }
    assert places["shelter"][1].name == "Unnamed shelter"
    assert radius_tier(500) == 1000 and radius_tier(5000) == 5000 and radius_tier(5001) == 10_000


async def test_overpass_429_is_retried_once(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        side_effect=[
            httpx.Response(429, text="Too Many Requests"),
            httpx.Response(200, json=OVERPASS_HOSPITALS),
        ]
    )
    places = await service.get_places(*DELHI, "hospital")
    assert places
    assert route.call_count == 2


async def test_busy_overpass_is_remembered_only_briefly(
    service: PlacesService, respx_mock: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(429))
    with pytest.raises(places_module.OverpassBusyError):
        await service.get_places(*DELHI, "police")
    stored: list[float] = []
    real_set = service.cache.set

    def recording_set(key: Any, value: Any, ttl: float) -> None:
        if key[0] == "places-failed":
            stored.append(ttl)
        real_set(key, value, ttl)

    monkeypatch.setattr(service.cache, "set", recording_set)
    # Same view: answered from the (short) failure memory, still reported as "busy".
    with pytest.raises(places_module.OverpassBusyError):
        await service.get_places(*DELHI, "fire_station")
    assert stored == []
    # Another view queries Overpass and remembers its busy answer only briefly.
    with pytest.raises(places_module.OverpassBusyError):
        await service.get_places(19.076, 72.8777, "fire_station")
    assert stored == [places_module.BUSY_FAILURE_TTL_SECONDS]


async def test_waiting_too_long_for_a_slot_fails_fast(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, json={"elements": []})
    )
    service.slot_wait_seconds = 0.05
    for _ in range(places_module.MAX_CONCURRENT_OVERPASS):
        await service._slots.acquire()
    try:
        with pytest.raises(places_module.OverpassBusyError):
            await service.get_places(*DELHI, "pharmacy")
    finally:
        for _ in range(places_module.MAX_CONCURRENT_OVERPASS):
            service._slots.release()
    assert route.call_count == 0


# ---------------------------------------------------------------------------------------------
# Review round 3: partial views never serve unreached types as empty; overall deadline
# ---------------------------------------------------------------------------------------------
def test_view_query_marks_every_type_with_a_count() -> None:
    query = places_module.build_overpass_view_query(*DELHI, 5800, 10)
    assert query.count("out count;") == len(places_module.PLACE_FILTERS)
    # One marker right after each type's own ``out``, in PLACE_FILTERS order.
    assert query.count(f"out tags center {places_module.OVERPASS_MAX_ELEMENTS};\nout count;") == 5


def test_parse_partial_view_keeps_only_types_searched_completely() -> None:
    elements = MIXED_VIEW["elements"]
    payload = {
        "remark": "runtime error: Query run out of memory",
        # hospital block + marker, shelter block + marker, police element without marker
        "elements": [
            *(elements[0], COUNT_MARKER),
            *(elements[1], elements[2], COUNT_MARKER),
            elements[3],
        ],
    }
    places, complete = parse_overpass_view(payload)
    assert not complete
    assert {t: [p.id for p in items] for t, items in places.items()} == {
        "hospital": ["node/1"],
        "shelter": ["node/2", "node/3"],
    }
    # Not even the first type finished: nothing is known.
    with pytest.raises(UpstreamError):
        parse_overpass_view({"remark": "runtime error: timeout", "elements": elements[:1]})
    # A complete answer does not depend on the markers.
    places, complete = parse_overpass_view({"elements": [*elements[:1], COUNT_MARKER]})
    assert complete and set(places) == set(places_module.PLACE_FILTERS)
    assert places["police"] == ()


def test_partial_view_does_not_report_unreached_types_as_empty(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    """Regression: a timed-out view answered police/fire_station/shelter/pharmacy with
    200 {"places": []} for 60 s, i.e. "no shelters near you" during a flood."""
    route = respx_mock.post(OVERPASS_URL).mock(return_value=httpx.Response(200, json=PARTIAL_VIEW))
    params = {"lat": DELHI[0], "lon": DELHI[1]}
    hospital = client.get("/api/places", params={**params, "type": "hospital"})
    assert hospital.status_code == 200
    assert [p["id"] for p in hospital.json()["places"]] == ["node/1"]
    for place_type in ("shelter", "police", "fire_station", "pharmacy"):
        response = client.get("/api/places", params={**params, "type": place_type})
        assert response.status_code == 502, place_type
        assert response.json()["error"]["code"] == "upstream_error"
    assert route.call_count == 1  # the partial view itself is still cached briefly


class _TrickleStream(httpx.AsyncByteStream):
    """A valid but slowly streamed body: one byte every ``delay`` seconds."""

    def __init__(self, body: bytes, delay: float) -> None:
        self.body = body
        self.delay = delay

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for index in range(len(self.body)):
            await asyncio.sleep(self.delay)
            yield self.body[index : index + 1]


async def test_slowly_streamed_answer_is_cut_at_the_request_budget(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    """Regression: httpx timeouts bound each read, not the request, so an answer trickling in
    (headers at once, then a byte every 0.8 s) ran 24.9 s against a 17 s budget."""
    body = b'{"elements": []}' + b" " * 8  # 24 bytes, ~4.8 s at 0.2 s per byte
    respx_mock.post(OVERPASS_URL).mock(
        return_value=httpx.Response(200, stream=_TrickleStream(body, 0.2))
    )
    service.request_budget_seconds = 1.5
    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(UpstreamError, match="took too long"):
        await service.get_places(*DELHI, "hospital")
    assert loop.time() - started < 2.5
    assert not service._slots.locked()  # the slot was given back


async def test_overpass_server_timeout_stays_inside_the_budget(
    service: PlacesService, respx_mock: respx.MockRouter
) -> None:
    """Regression: the 429 retry sent ``[timeout:5]`` with a 4 s HTTP timeout."""
    route = respx_mock.post(OVERPASS_URL).mock(
        side_effect=[httpx.Response(429), httpx.Response(200, json=MIXED_VIEW)]
    )
    service.request_budget_seconds = places_module.MIN_ATTEMPT_SECONDS + 0.5
    assert [p.id for p in await service.get_places(*DELHI, "police")] == ["node/4"]
    for call in route.calls:
        server_timeout = int(_query_of(call).split("[timeout:", 1)[1].split("]", 1)[0])
        assert server_timeout < service.request_budget_seconds
    assert places_module.overpass_server_timeout(15.0, 10) == 10  # the normal case
    assert places_module.overpass_server_timeout(4.0, 10) == 2
