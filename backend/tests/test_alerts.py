"""Disaster alerts & news: GDACS parsing / filtering / sorting, ReliefWeb parsing, the GDACS
news fallback, caching + stale handling, and ``GET /api/alerts/{disasters,news}``.

Upstream calls are mocked with respx using realistic payloads from ``tests/fixtures``
(``gdacs_events.json`` / ``reliefweb_reports.json``).
"""

from __future__ import annotations

import copy
import dataclasses
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.errors import InvalidInputError
from app.main import create_app
from app.services.disaster_feed import (
    GDACS_EVENTS_URL,
    RELIEFWEB_FIELDS,
    RELIEFWEB_REPORTS_URL,
    DisasterFeedService,
    normalize_event_types,
    normalize_iso3,
    normalize_query,
    parse_datetime,
    parse_gdacs_events,
    parse_reliefweb_reports,
    select_events,
)
from app.services.geo import haversine_km

FIXTURES = Path(__file__).parent / "fixtures"
RELIEFWEB_APPNAME = "resq-ai-test"
DELHI = {"lat": 28.6139, "lon": 77.2090}

#: Fixture events, most severe first then most recent activity (no location given).
EXPECTED_DEFAULT_ORDER = [
    "TC-1001214",  # red
    "EQ-1502861",  # orange, 2026-11-01 14:12
    "FL-1103377",  # orange, until 2026-11-01 00:00
    "DR-1017020",  # orange, until 2026-10-31
    "VO-1000094",  # green, until 2026-10-31 03:00
    "WF-1024788",  # green, until 2026-10-24
]


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def mock_gdacs(respx_mock: respx.MockRouter) -> respx.Route:
    return respx_mock.get(GDACS_EVENTS_URL).respond(json=load_fixture("gdacs_events.json"))


def mock_reliefweb(respx_mock: respx.MockRouter, payload: Any = None) -> respx.Route:
    body = load_fixture("reliefweb_reports.json") if payload is None else payload
    return respx_mock.post(RELIEFWEB_REPORTS_URL).respond(json=body)


def event_ids(body: dict[str, Any]) -> list[str]:
    return [event["id"] for event in body["events"]]


@pytest.fixture
def reliefweb_client(settings_factory: Callable[..., Settings]) -> Iterator[TestClient]:
    """App with ReliefWeb enabled (an approved appname is configured)."""
    with TestClient(create_app(settings_factory(reliefweb_appname=RELIEFWEB_APPNAME))) as client:
        yield client


# ---------------------------------------------------------------------------------------------
# GET /api/alerts/disasters
# ---------------------------------------------------------------------------------------------
def test_disasters_are_normalised_and_sorted_by_level_then_recency(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    route = mock_gdacs(respx_mock)

    response = client.get("/api/alerts/disasters")

    assert response.status_code == 200, response.text
    body = response.json()
    # Duplicate episode de-duplicated; features without type / with corrupt coordinates skipped.
    assert event_ids(body) == EXPECTED_DEFAULT_ORDER
    assert body["events"][0] == {
        "id": "TC-1001214",
        "source": "gdacs",
        "event_type": "TC",
        "event_type_label": "Tropical Cyclone",
        "title": "Tropical Cyclone NAKRI-26",
        # ``description`` equals the title, so the informative htmldescription is used.
        "description": (
            "Red Tropical Cyclone Alert for NAKRI-26 in Philippines, Viet Nam from "
            "29 Oct 2026 00:00 UTC to 02 Nov 2026 06:00 UTC"
        ),
        "alert_level": "red",
        "severity_text": "Typhoon (maximum wind speed of 213 km/h)",
        "country": "Philippines, Viet Nam",
        "lat": 13.1,
        "lon": 125.6,
        "from_date": "2026-10-29T00:00:00Z",  # GDACS dates are UTC without an offset
        "to_date": "2026-11-02T06:00:00Z",
        "is_current": True,
        "url": "https://www.gdacs.org/report.aspx?eventid=1001214&episodeid=18&eventtype=TC",
        "distance_km": None,
    }
    events = {event["id"]: event for event in body["events"]}
    # The newest episode of the earthquake wins (Orange, M6.8), not the older Green one.
    assert events["EQ-1502861"]["alert_level"] == "orange"
    assert events["EQ-1502861"]["severity_text"] == "Magnitude 6.8M, Depth:35km"
    # Polygon geometry: location is the bbox centre.
    assert (events["DR-1017020"]["lat"], events["DR-1017020"]["lon"]) == (0.15, 37.9)
    # No name/description: title from type label + eventname, htmldescription used.
    assert events["VO-1000094"]["title"] == "Volcano Lewotobi Laki-laki"
    assert events["VO-1000094"]["description"].startswith("Green alert for volcanic eruption")
    # No url block: report URL fallback; "iscurrent": "false" string parsed.
    assert events["WF-1024788"]["url"] == (
        "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1024788"
    )
    assert events["WF-1024788"]["is_current"] is False

    updated_at = datetime.fromisoformat(body["updated_at"])
    assert datetime.now(UTC) - updated_at < timedelta(minutes=1)
    assert route.calls.last.request.headers["user-agent"].startswith("ResQ-AI/2.0")


def test_disasters_near_a_point_are_sorted_by_level_then_distance(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    mock_gdacs(respx_mock)

    body = client.get("/api/alerts/disasters", params=DELHI).json()

    assert event_ids(body) == [
        "TC-1001214",  # red (5,275 km)
        "FL-1103377",  # orange, 1,461 km
        "DR-1017020",  # orange, 5,239 km
        "EQ-1502861",  # orange, 6,017 km
        "VO-1000094",  # green, 6,398 km
        "WF-1024788",  # green, 12,825 km
    ]
    flood = body["events"][1]
    expected = haversine_km(DELHI["lat"], DELHI["lon"], 26.14, 91.75)
    assert flood["distance_km"] == pytest.approx(expected, abs=0.1)
    assert all(event["distance_km"] is not None for event in body["events"])


def test_disasters_radius_filter(client: TestClient, respx_mock: respx.MockRouter) -> None:
    mock_gdacs(respx_mock)

    body = client.get("/api/alerts/disasters", params={**DELHI, "radius_km": 2000}).json()

    assert event_ids(body) == ["FL-1103377"]
    assert body["events"][0]["distance_km"] <= 2000


def test_disaster_filters_are_applied_after_the_cache(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    route = mock_gdacs(respx_mock)

    def ids(**params: Any) -> list[str]:
        response = client.get("/api/alerts/disasters", params=params)
        assert response.status_code == 200, response.text
        return event_ids(response.json())

    assert ids(types="EQ,TC") == ["TC-1001214", "EQ-1502861"]
    assert ids(types=["eq", "fl"]) == ["EQ-1502861", "FL-1103377"]  # repeated + lower-case
    assert ids(min_level="orange") == EXPECTED_DEFAULT_ORDER[:4]
    assert ids(min_level="red") == ["TC-1001214"]
    assert ids(types="FL", min_level="red") == []
    assert ids(limit=2) == EXPECTED_DEFAULT_ORDER[:2]
    assert ids(types="EQ,TC,FL,VO,DR,WF") == EXPECTED_DEFAULT_ORDER
    assert route.call_count == 1  # one upstream request served every query


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"lat": 28.6}, "invalid_input"),  # lat without lon
        ({"lon": 77.2}, "invalid_input"),
        ({"radius_km": 100}, "invalid_input"),  # radius without a point
        ({"types": "EQ;DROP TABLE"}, "invalid_input"),
        ({"types": "earthquake"}, "invalid_input"),
        ({**DELHI, "radius_km": 0}, "validation_error"),
        ({**DELHI, "radius_km": -5}, "validation_error"),
        ({"lat": 95, "lon": 0}, "validation_error"),
        ({"min_level": "purple"}, "validation_error"),
        ({"limit": 0}, "validation_error"),
        ({"limit": 501}, "validation_error"),
    ],
)
def test_disaster_query_validation(
    client: TestClient, respx_mock: respx.MockRouter, params: dict[str, Any], code: str
) -> None:
    # No route is mocked: respx fails the test if GDACS were contacted before validation.
    response = client.get("/api/alerts/disasters", params=params)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == code


@pytest.mark.parametrize(
    "failure",
    [
        httpx.Response(503, text="Service Unavailable"),
        httpx.Response(200, text="<html>Server Error</html>"),
        httpx.Response(200, json={"error": "unexpected"}),
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("timed out"),
    ],
    ids=["http-503", "not-json", "not-geojson", "connect-error", "timeout"],
)
def test_gdacs_unavailable_returns_502_and_cools_down(
    client: TestClient, respx_mock: respx.MockRouter, failure: Any
) -> None:
    route = respx_mock.get(GDACS_EVENTS_URL)
    if isinstance(failure, Exception):
        route.mock(side_effect=failure)
    else:
        route.mock(return_value=failure)

    response = client.get("/api/alerts/disasters")

    assert response.status_code == 502
    assert response.json()["error"] == {
        "code": "upstream_error",
        "message": "Disaster feed (GDACS) unavailable",
        "request_id": response.headers["x-request-id"],
    }
    # The failing upstream is not hammered: the next request fails fast.
    assert client.get("/api/alerts/disasters").status_code == 502
    assert route.call_count == 1


def test_last_good_feed_is_served_while_gdacs_is_down(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    route = mock_gdacs(respx_mock)
    fresh = client.get("/api/alerts/disasters").json()

    # The cache entry expires and GDACS starts failing: the last good copy is served.
    client.app.state.cache.clear()  # type: ignore[attr-defined]
    route.mock(return_value=httpx.Response(500))
    stale = client.get("/api/alerts/disasters")
    assert stale.status_code == 200
    assert stale.json() == fresh  # same events, same updated_at (honest data age)

    # ...but not forever.
    feeds: DisasterFeedService = client.app.state.feeds  # type: ignore[attr-defined]
    assert feeds._last_gdacs is not None
    feeds._last_gdacs = dataclasses.replace(
        feeds._last_gdacs, fetched_at=datetime.now(UTC) - timedelta(hours=7)
    )
    client.app.state.cache.clear()  # type: ignore[attr-defined]
    assert client.get("/api/alerts/disasters").status_code == 502


async def test_get_events_service_api(settings: Settings, respx_mock: respx.MockRouter) -> None:
    """The plain ``get_events`` interface used by the alert poller and the chat agents."""
    from app.services.cache import TTLCache

    mock_gdacs(respx_mock)
    async with httpx.AsyncClient() as http:
        feeds = DisasterFeedService(http, TTLCache(), settings)
        events = await feeds.get_events(min_level="orange", types=["TC", "FL"])
        assert [event.id for event in events] == ["TC-1001214", "FL-1103377"]
        near = await feeds.get_events(lat=26.0, lon=92.0, radius_km=100)
        assert [event.id for event in near] == ["FL-1103377"]
        with pytest.raises(InvalidInputError):
            await feeds.get_events(min_level="purple")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------------------------
# GET /api/alerts/news
# ---------------------------------------------------------------------------------------------
def test_news_falls_back_to_gdacs_without_reliefweb(
    client: TestClient, respx_mock: respx.MockRouter
) -> None:
    mock_gdacs(respx_mock)  # no ReliefWeb route: respx fails the test if it were called

    response = client.get("/api/alerts/news")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sources"] == ["gdacs"]
    assert [item["id"] for item in body["items"]] == [
        "gdacs-TC-1001214",  # 2026-11-02 06:00
        "gdacs-EQ-1502861",  # 2026-11-01 14:12
        "gdacs-FL-1103377",  # 2026-11-01 00:00
        "gdacs-VO-1000094",  # 2026-10-31 03:00
        "gdacs-DR-1017020",  # 2026-10-31 00:00
        "gdacs-WF-1024788",  # 2026-10-24 00:00
    ]
    assert body["items"][0] == {
        "id": "gdacs-TC-1001214",
        "source": "gdacs",
        "title": "Tropical Cyclone NAKRI-26",
        "url": "https://www.gdacs.org/report.aspx?eventid=1001214&episodeid=18&eventtype=TC",
        "published_at": "2026-11-02T06:00:00Z",
        "summary": (
            "Typhoon (maximum wind speed of 213 km/h) · Red Tropical Cyclone Alert for NAKRI-26 "
            "in Philippines, Viet Nam from 29 Oct 2026 00:00 UTC to 02 Nov 2026 06:00 UTC"
        ),
        "countries": ["Philippines", "Viet Nam"],
        "disaster_types": ["Tropical Cyclone"],
        "source_name": "GDACS",
    }
    # The alert level / severity are prepended only when the description lacks them.
    flood = body["items"][2]
    assert flood["summary"].startswith("Medium impact · Orange flood alert in India")
    wildfire = body["items"][-1]
    assert wildfire["summary"] == "Green alert · Burned area 1820 ha"

    limited = client.get("/api/alerts/news", params={"limit": 2}).json()
    assert [item["id"] for item in limited["items"]] == [item["id"] for item in body["items"][:2]]


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"country": "ind"}, ["gdacs-FL-1103377"]),
        ({"country": "VNM"}, ["gdacs-TC-1001214"]),  # affected country, not only the main one
        ({"query": "japan  EARTHQUAKE"}, ["gdacs-EQ-1502861"]),
        ({"query": "typhoon", "country": "PHL"}, ["gdacs-TC-1001214"]),
        ({"query": "volcano", "country": "IND"}, []),
        ({"query": "   ", "country": ""}, None),  # blanks are ignored
    ],
)
def test_news_gdacs_fallback_filters(
    client: TestClient,
    respx_mock: respx.MockRouter,
    params: dict[str, str],
    expected: list[str] | None,
) -> None:
    mock_gdacs(respx_mock)

    response = client.get("/api/alerts/news", params=params)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sources"] == ["gdacs"]
    ids = [item["id"] for item in body["items"]]
    if expected is None:
        assert len(ids) == 6  # unfiltered
    else:
        assert ids == expected


def test_news_from_reliefweb(reliefweb_client: TestClient, respx_mock: respx.MockRouter) -> None:
    route = mock_reliefweb(respx_mock)  # no GDACS route: it must not be needed

    response = reliefweb_client.get("/api/alerts/news")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sources"] == ["reliefweb"]
    assert body["items"] == [
        {
            "id": "reliefweb-4180123",
            "source": "reliefweb",
            "title": "Philippines: Typhoon Nakri - Flash Update No. 3 (2 November 2026)",
            "url": (
                "https://reliefweb.int/report/philippines/"
                "philippines-typhoon-nakri-flash-update-no-3-2-november-2026"
            ),
            "published_at": "2026-11-02T09:41:12Z",
            "summary": (
                "Typhoon Nakri made landfall over Catanduanes on 1 November. More than 410,000 "
                "people were pre-emptively evacuated across the Bicol Region."
            ),
            "countries": ["Philippines"],
            "disaster_types": ["Tropical Cyclone", "Flood"],
            "source_name": "OCHA",
        },
        {
            "id": "reliefweb-4179950",
            "source": "reliefweb",
            "title": "Japan: Earthquake - Nov 2026",
            "url": "https://reliefweb.int/node/4179950",  # no url_alias
            "published_at": "2026-11-01T22:30:00Z",
            "summary": None,
            "countries": ["Japan"],
            "disaster_types": [],
            "source_name": "JRCS",
        },
        {
            "id": "reliefweb-4180098",
            "source": "reliefweb",
            "title": "India: Assam Floods & Landslides - Situation Report No. 2",
            "url": (
                "https://reliefweb.int/report/india/"
                "india-assam-floods-landslides-situation-report-no-2"
            ),
            "published_at": "2026-11-01T17:05:00Z",
            "summary": None,
            "countries": ["India"],
            "disaster_types": ["Flood", "Land Slide"],
            "source_name": "IFRC, IRCS",
        },
    ]

    request = route.calls.last.request
    assert request.url.params["appname"] == RELIEFWEB_APPNAME
    assert json.loads(request.content) == {
        "limit": 50,
        "preset": "latest",
        "profile": "list",
        "fields": {"include": list(RELIEFWEB_FIELDS)},
    }


def test_news_reliefweb_query_country_and_cache(
    reliefweb_client: TestClient, respx_mock: respx.MockRouter
) -> None:
    route = mock_reliefweb(respx_mock)
    params = {"query": "typhoon  nakri", "country": "phl", "limit": 5}

    first = reliefweb_client.get("/api/alerts/news", params=params)
    # A different limit within the same upstream page size reuses the cached page.
    second = reliefweb_client.get("/api/alerts/news", params={**params, "limit": 2})

    assert first.status_code == second.status_code == 200
    assert len(second.json()["items"]) == 2
    assert route.call_count == 1
    body = json.loads(route.calls.last.request.content)
    assert body["query"] == {"value": "typhoon nakri"}
    assert body["filter"] == {"field": "country.iso3", "value": "phl"}


@pytest.mark.parametrize(
    "failure",
    [
        httpx.Response(500, text="Internal Server Error"),
        httpx.Response(403, json={"status": 403, "error": {"message": "appname not approved"}}),
        httpx.Response(200, json={"unexpected": True}),
        httpx.ConnectError("connection refused"),
    ],
    ids=["http-500", "http-403", "malformed", "connect-error"],
)
def test_news_reliefweb_failure_falls_back_to_gdacs(
    reliefweb_client: TestClient, respx_mock: respx.MockRouter, failure: Any
) -> None:
    reliefweb = respx_mock.post(RELIEFWEB_REPORTS_URL)
    if isinstance(failure, Exception):
        reliefweb.mock(side_effect=failure)
    else:
        reliefweb.mock(return_value=failure)
    gdacs = mock_gdacs(respx_mock)

    first = reliefweb_client.get("/api/alerts/news")
    second = reliefweb_client.get("/api/alerts/news", params={"query": "flood"})

    assert first.status_code == second.status_code == 200
    assert first.json()["sources"] == second.json()["sources"] == ["gdacs"]
    assert first.json()["items"][0]["id"] == "gdacs-TC-1001214"
    assert [item["id"] for item in second.json()["items"]] == ["gdacs-FL-1103377"]
    assert reliefweb.call_count == 1  # cooling down: not retried on the second request
    assert gdacs.call_count == 1  # GDACS feed cached


def test_news_reliefweb_bad_request_does_not_cool_down(
    reliefweb_client: TestClient, respx_mock: respx.MockRouter
) -> None:
    reliefweb = respx_mock.post(RELIEFWEB_REPORTS_URL).respond(400, json={"status": 400})
    mock_gdacs(respx_mock)

    reliefweb_client.get("/api/alerts/news", params={"query": '"unbalanced'})
    reliefweb_client.get("/api/alerts/news", params={"query": "flood"})

    assert reliefweb.call_count == 2  # a 400 is specific to that query


def test_news_merges_gdacs_when_reliefweb_has_nothing(
    reliefweb_client: TestClient, respx_mock: respx.MockRouter
) -> None:
    mock_reliefweb(respx_mock, payload={"totalCount": 0, "count": 0, "data": []})
    mock_gdacs(respx_mock)

    body = reliefweb_client.get("/api/alerts/news", params={"country": "KEN"}).json()

    assert body["sources"] == ["reliefweb", "gdacs"]
    assert [item["id"] for item in body["items"]] == ["gdacs-DR-1017020"]


def test_news_returns_502_when_every_provider_fails(
    reliefweb_client: TestClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(RELIEFWEB_REPORTS_URL).respond(502)
    respx_mock.get(GDACS_EVENTS_URL).respond(503)

    response = reliefweb_client.get("/api/alerts/news")

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_error"
    assert response.json()["error"]["message"] == "News providers unavailable"


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"country": "IN"}, "invalid_input"),
        ({"country": "I1D"}, "invalid_input"),
        ({"country": "INDIA"}, "validation_error"),
        ({"limit": 0}, "validation_error"),
        ({"limit": 101}, "validation_error"),
        ({"query": "x" * 201}, "validation_error"),
    ],
)
def test_news_query_validation(
    client: TestClient, respx_mock: respx.MockRouter, params: dict[str, Any], code: str
) -> None:
    response = client.get("/api/alerts/news", params=params)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == code


# ---------------------------------------------------------------------------------------------
# Parser / helper units
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-11-01T14:12:05", datetime(2026, 11, 1, 14, 12, 5, tzinfo=UTC)),
        ("2026-11-02T09:41:12+00:00", datetime(2026, 11, 2, 9, 41, 12, tzinfo=UTC)),
        ("2026-11-02T15:11:12+05:30", datetime(2026, 11, 2, 9, 41, 12, tzinfo=UTC)),
        ("2026-11-02T09:41:12Z", datetime(2026, 11, 2, 9, 41, 12, tzinfo=UTC)),
        ("2026-11-02 09:41:12", datetime(2026, 11, 2, 9, 41, 12, tzinfo=UTC)),
        ("02 Nov 2026 10:00:00", datetime(2026, 11, 2, 10, 0, tzinfo=UTC)),
        (1793606400, datetime(2026, 11, 2, 8, 0, tzinfo=UTC)),
        (1793606400000, datetime(2026, 11, 2, 8, 0, tzinfo=UTC)),
        ("", None),
        ("soon", None),
        (None, None),
        (True, None),
    ],
)
def test_parse_datetime(value: Any, expected: datetime | None) -> None:
    assert parse_datetime(value) == expected


def test_normalize_helpers() -> None:
    assert normalize_event_types(["eq", " TC,fl ", ""]) == frozenset({"EQ", "TC", "FL"})
    assert normalize_event_types(None) == frozenset()
    with pytest.raises(InvalidInputError):
        normalize_event_types(["E1"])
    assert normalize_iso3(" ind ") == "IND"
    assert normalize_iso3("") is None
    with pytest.raises(InvalidInputError):
        normalize_iso3("IN")
    assert normalize_query("  flood \n  assam ") == "flood assam"
    assert normalize_query("   ") is None
    assert len(normalize_query("a" * 500) or "") == 200


def test_parse_gdacs_events_edge_cases() -> None:
    with pytest.raises(ValueError):
        parse_gdacs_events({"type": "FeatureCollection"})
    with pytest.raises(ValueError):
        parse_gdacs_events(["not", "geojson"])

    feature = {
        "type": "Feature",
        # Fiji: the bbox crosses the antimeridian (west > east).
        "bbox": [177.0, -19.0, -178.0, -16.0],
        "geometry": None,
        "properties": {
            "eventtype": "tc",
            "eventid": "1001300",
            "alertlevel": "ORANGE",
            "iscurrent": True,
            "country": "Fiji",
            "fromdate": "2026-11-01T00:00:00",
        },
    }
    junk = [None, "x", {"properties": None}, {"properties": {"eventtype": "EQ"}}]
    [record] = parse_gdacs_events({"type": "FeatureCollection", "features": [feature, *junk]})
    event = record.event
    assert event.id == "TC-1001300" and event.alert_level == "orange"
    assert (event.lat, event.lon) == (-17.5, 179.5)
    assert record.is_point is False
    assert event.title == "Tropical Cyclone in Fiji"
    assert event.url == "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001300"
    assert record.countries == ("Fiji",) and record.iso3 == frozenset()


@pytest.mark.parametrize("reverse", [False, True], ids=["newest-first", "oldest-first"])
def test_duplicate_episodes_keep_the_newest_regardless_of_order(reverse: bool) -> None:
    payload = copy.deepcopy(load_fixture("gdacs_events.json"))
    episodes = [f for f in payload["features"] if f["properties"].get("eventid") == 1502861]
    assert [f["properties"]["episodeid"] for f in episodes] == [1650012, 1650001]
    payload["features"] = episodes[::-1] if reverse else episodes

    [record] = parse_gdacs_events(payload)

    assert record.episode_id == 1650012
    assert record.event.alert_level == "orange"
    assert record.event.severity_text == "Magnitude 6.8M, Depth:35km"


def test_unknown_alert_level_defaults_to_green() -> None:
    payload = copy.deepcopy(load_fixture("gdacs_events.json"))
    payload["features"] = payload["features"][:1]
    payload["features"][0]["properties"]["alertlevel"] = "Purple"
    [record] = parse_gdacs_events(payload)
    assert record.event.alert_level == "green"


def test_select_events_does_not_mutate_cached_records() -> None:
    records = parse_gdacs_events(load_fixture("gdacs_events.json"))
    near = select_events(records, point=(28.6139, 77.2090), limit=10)
    assert near[0].distance_km is not None
    assert all(record.event.distance_km is None for record in records)


def test_parse_reliefweb_reports_edge_cases() -> None:
    with pytest.raises(ValueError):
        parse_reliefweb_reports({"error": "bad request"})
    payload = {
        "data": [
            {"id": 1, "fields": {"title": "Relative alias", "url_alias": "/report/world/x"}},
            {"id": 2, "fields": {"title": "   "}},  # no title: skipped
            {"id": 3, "fields": "not-an-object"},
            "garbage",
            {"id": 4, "fields": {"title": "Odd date", "date": {"created": "yesterday"}}},
            {"id": 5, "fields": {"title": "Bad url", "url_alias": "javascript:alert(1)"}},
        ]
    }
    items = parse_reliefweb_reports(payload)
    assert [(item.id, item.url) for item in items] == [
        ("reliefweb-1", "https://reliefweb.int/report/world/x"),
        ("reliefweb-4", "https://reliefweb.int/node/4"),
        ("reliefweb-5", "https://reliefweb.int/node/5"),
    ]
    assert items[1].published_at is None
