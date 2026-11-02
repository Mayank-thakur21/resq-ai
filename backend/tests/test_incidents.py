"""Tests for community incidents: :mod:`app.services.incidents` and ``/api/incidents``."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from datetime import datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import CurrentUser
from app.db.models import Incident, IncidentVote, PushSubscription
from app.main import create_app
from app.services import incidents as incident_service
from app.services import push as push_module

DELHI = (28.6139, 77.2090)
NOIDA = (28.5355, 77.3910)  # ~19.7 km from Delhi
MUMBAI = (19.0760, 72.8777)  # ~1150 km from Delhi

Headers = Callable[..., dict[str, str]]


# ---------------------------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------------------------
class FakePush:
    """Stands in for :class:`app.services.push.PushService` (records fan-outs)."""

    def __init__(self, *, enabled: bool = True, error: Exception | None = None) -> None:
        self.enabled = enabled
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def notify_nearby(
        self,
        session: AsyncSession,
        lat: float,
        lon: float,
        payload: dict[str, Any],
        topic: str,
        **kwargs: Any,
    ) -> int:
        self.calls.append(
            {"session": session, "lat": lat, "lon": lon, "payload": payload, "topic": topic}
            | kwargs
        )
        if self.error is not None:
            raise self.error
        return 3


@pytest.fixture
def push(client: TestClient) -> FakePush:
    fake = FakePush()
    client.app.state.push = fake  # type: ignore[attr-defined]
    return fake


def incident_body(point: tuple[float, float] = DELHI, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "lat": point[0],
        "lon": point[1],
        "disaster_type": "flood",
        "severity": "high",
        "description": "Water is rising quickly near the metro station.",
    }
    body.update(overrides)
    return body


def create(
    client: TestClient, headers: dict[str, str], point: tuple[float, float] = DELHI, **kw: Any
) -> dict[str, Any]:
    response = client.post("/api/incidents", json=incident_body(point, **kw), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def assert_envelope(response: Any, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    error = response.json()["error"]
    assert error["code"] == code
    assert error["message"]
    assert "request_id" in error


# ---------------------------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------------------------
def test_create_requires_auth(client: TestClient, push: FakePush) -> None:
    response = client.post("/api/incidents", json=incident_body())
    assert_envelope(response, 401, "unauthorized")
    assert push.calls == []


def test_create_rejects_expired_token(client: TestClient, auth_headers: Headers) -> None:
    response = client.post(
        "/api/incidents", json=incident_body(), headers=auth_headers(expires_in=-120)
    )
    assert_envelope(response, 401, "unauthorized")


def test_create_incident(client: TestClient, auth_headers: Headers, push: FakePush) -> None:
    body = create(client, auth_headers("u1", "Asha"), image_url="https://img.example/f.jpg")

    assert body["disaster_type"] == "flood"
    assert body["severity"] == "high"
    assert body["status"] == "open"
    assert body["reporter"] == {"id": "u1", "name": "Asha"}
    assert body["upvotes"] == 0
    assert body["verified"] is False
    assert body["upvoted_by_me"] is False
    assert body["distance_km"] is None
    assert body["image_url"] == "https://img.example/f.jpg"
    created = datetime.fromisoformat(body["created_at"])
    assert created.tzinfo is not None

    # Push fan-out ran as a background task with its own session.
    assert len(push.calls) == 1
    call = push.calls[0]
    assert call["topic"] == "incidents"
    assert (call["lat"], call["lon"]) == DELHI
    assert call["exclude_user_id"] == "u1"
    assert isinstance(call["session"], AsyncSession)
    assert call["payload"] == {
        "title": "High flood reported nearby",
        "body": "Water is rising quickly near the metro station.",
        "url": f"/incidents?focus={body['id']}",
        "tag": f"incident-{body['id']}",
        "severity": "high",
    }


def test_create_maps_critical_severity_and_truncates_push_body(
    client: TestClient, auth_headers: Headers, push: FakePush
) -> None:
    long_text = "Building collapsed after the tremor, people trapped. " * 10
    create(
        client,
        auth_headers(),
        disaster_type="earthquake",
        severity="critical",
        description=long_text,
    )
    payload = push.calls[0]["payload"]
    assert payload["title"] == "Critical earthquake reported nearby"
    assert payload["severity"] == "high"
    assert len(payload["body"]) <= incident_service.PUSH_BODY_CHARS
    assert payload["body"].endswith("…")


def test_create_without_name_is_anonymous(client: TestClient, auth_headers: Headers) -> None:
    body = create(client, auth_headers("oauth-user", None))
    assert body["reporter"] == {"id": "oauth-user", "name": "Anonymous"}


@pytest.mark.parametrize(
    "overrides",
    [
        {"description": "too short"},
        {"disaster_type": "alien_invasion"},
        {"severity": "extreme"},
        {"image_url": "ftp://example.com/x.jpg"},
        {"image_url": "https://example.com/" + "a" * 500},
        {"lat": 91.0},
        {"lon": -181.0},
    ],
)
def test_create_validation(
    client: TestClient, auth_headers: Headers, push: FakePush, overrides: dict[str, Any]
) -> None:
    response = client.post(
        "/api/incidents", json=incident_body(**overrides), headers=auth_headers()
    )
    assert_envelope(response, 422, "validation_error")
    assert push.calls == []


def test_push_disabled_skips_fan_out(client: TestClient, auth_headers: Headers) -> None:
    fake = FakePush(enabled=False)
    client.app.state.push = fake  # type: ignore[attr-defined]
    create(client, auth_headers())
    assert fake.calls == []


def test_push_failure_does_not_break_creation(client: TestClient, auth_headers: Headers) -> None:
    fake = FakePush(error=RuntimeError("push exploded"))
    client.app.state.push = fake  # type: ignore[attr-defined]

    body = create(client, auth_headers())

    assert len(fake.calls) == 1
    assert client.get(f"/api/incidents/{body['id']}").status_code == 200


def test_create_notifies_nearby_subscribers_through_real_push_service(
    client: TestClient,
    auth_headers: Headers,
    run_db: Callable[..., Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deliveries: list[dict[str, Any]] = []
    lock = threading.Lock()

    def fake_webpush(**kwargs: Any) -> Any:
        with lock:
            deliveries.append(kwargs)
        return SimpleNamespace(status_code=201, text="", headers={})

    monkeypatch.setattr(push_module, "webpush", fake_webpush)

    def sub(endpoint: str, point: tuple[float, float], user_id: str | None) -> PushSubscription:
        return PushSubscription(
            endpoint=endpoint,
            p256dh="p256dh-key",
            auth="auth-secret",
            user_id=user_id,
            lat=point[0],
            lon=point[1],
            radius_km=50.0,
            topics="incidents,disasters",
        )

    async def seed(session: AsyncSession) -> None:
        session.add_all(
            [
                sub("https://fcm.googleapis.com/fcm/send/neighbour", NOIDA, "u2"),
                sub(
                    "https://fcm.googleapis.com/fcm/send/reporter", DELHI, "u1"
                ),  # reporter: skipped
                sub("https://fcm.googleapis.com/fcm/send/far", MUMBAI, None),  # out of range
            ]
        )
        await session.commit()

    run_db(seed)
    body = create(client, auth_headers("u1"), severity="medium")

    assert [d["subscription_info"]["endpoint"] for d in deliveries] == [
        "https://fcm.googleapis.com/fcm/send/neighbour"
    ]
    data = json.loads(deliveries[0]["data"])
    assert data["title"] == "Medium flood reported nearby"
    assert data["url"] == f"/incidents?focus={body['id']}"
    assert data["severity"] == "medium"


def test_incident_creation_is_limited_per_user(
    settings_factory: Callable[..., Settings], auth_headers: Headers
) -> None:
    """INCIDENT_RATE_LIMIT stops one (free) account from flooding reports and pushes."""
    with TestClient(create_app(settings_factory(incident_rate_limit="2/hour"))) as limited:
        limited.app.state.push = FakePush()  # type: ignore[attr-defined]
        statuses = [
            limited.post(
                "/api/incidents", json=incident_body(), headers=auth_headers("spammer")
            ).status_code
            for _ in range(3)
        ]
        assert statuses == [201, 201, 429]
        other = limited.post("/api/incidents", json=incident_body(), headers=auth_headers("u2"))
        assert other.status_code == 201


def test_incident_pushes_are_throttled_per_reporter_and_device(
    client: TestClient, auth_headers: Headers, push: FakePush
) -> None:
    for _ in range(5):
        create(client, auth_headers("u1"))
    # Only the first PUSH_PER_REPORTER_LIMIT reports of one reporter fan out at all ...
    allowed = int(incident_service.PUSH_PER_REPORTER_LIMIT.split("/", 1)[0])
    assert len(push.calls) == allowed
    # ... and each fan-out caps how often one device is notified.
    assert {call["per_subscription_limit"] for call in push.calls} == {
        incident_service.PUSH_PER_SUBSCRIPTION_LIMIT
    }
    create(client, auth_headers("u2"))  # other reporters are unaffected
    assert len(push.calls) == allowed + 1


def test_devices_get_at_most_one_incident_push_per_cooldown(
    client: TestClient,
    auth_headers: Headers,
    run_db: Callable[..., Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deliveries: list[str] = []

    def fake_webpush(**kwargs: Any) -> Any:
        deliveries.append(kwargs["subscription_info"]["endpoint"])
        return SimpleNamespace(status_code=201, text="", headers={})

    monkeypatch.setattr(push_module, "webpush", fake_webpush)

    async def seed(session: AsyncSession) -> None:
        session.add(
            PushSubscription(
                endpoint="https://fcm.googleapis.com/fcm/send/neighbour",
                p256dh="k",
                auth="a",
                lat=NOIDA[0],
                lon=NOIDA[1],
                radius_km=50.0,
                topics="incidents",
            )
        )
        await session.commit()

    run_db(seed)
    create(client, auth_headers("u1"))
    create(client, auth_headers("u2"))  # different reporter, same area, minutes later
    assert deliveries == ["https://fcm.googleapis.com/fcm/send/neighbour"]


# ---------------------------------------------------------------------------------------------
# List / get
# ---------------------------------------------------------------------------------------------
def test_list_near_filters_by_radius_and_sorts_newest_first(
    client: TestClient, auth_headers: Headers, push: FakePush
) -> None:
    headers = auth_headers()
    delhi = create(client, headers, DELHI)
    noida = create(client, headers, NOIDA)
    mumbai = create(client, headers, MUMBAI)

    near = client.get(
        "/api/incidents", params={"lat": DELHI[0], "lon": DELHI[1], "radius_km": 30}
    ).json()["incidents"]
    assert [i["id"] for i in near] == [noida["id"], delhi["id"]]
    assert near[0]["distance_km"] == pytest.approx(19.7, abs=0.5)
    assert near[1]["distance_km"] == 0.0

    close = client.get(
        "/api/incidents", params={"lat": DELHI[0], "lon": DELHI[1], "radius_km": 5}
    ).json()["incidents"]
    assert [i["id"] for i in close] == [delhi["id"]]

    everywhere = client.get("/api/incidents").json()["incidents"]
    assert [i["id"] for i in everywhere] == [mumbai["id"], noida["id"], delhi["id"]]
    assert all(i["distance_km"] is None for i in everywhere)


def test_list_default_radius_is_50_km(client: TestClient, auth_headers: Headers) -> None:
    create(client, auth_headers(), NOIDA)
    create(client, auth_headers(), MUMBAI)
    found = client.get("/api/incidents", params={"lat": DELHI[0], "lon": DELHI[1]}).json()
    assert len(found["incidents"]) == 1


def test_list_across_the_antimeridian(client: TestClient, auth_headers: Headers) -> None:
    fiji = create(client, auth_headers(), (-16.5, 179.95))
    found = client.get(
        "/api/incidents", params={"lat": -16.5, "lon": -179.95, "radius_km": 20}
    ).json()["incidents"]
    assert [i["id"] for i in found] == [fiji["id"]]
    assert found[0]["distance_km"] == pytest.approx(10.7, abs=0.3)


def test_list_status_type_and_limit_filters(client: TestClient, auth_headers: Headers) -> None:
    headers = auth_headers()
    flood = create(client, headers)
    fire = create(client, headers, disaster_type="fire", severity="low")
    third = create(client, headers, disaster_type="fire")
    resolved = client.patch(
        f"/api/incidents/{flood['id']}", json={"status": "resolved"}, headers=headers
    )
    assert resolved.status_code == 200

    def ids(**params: Any) -> list[str]:
        response = client.get("/api/incidents", params=params)
        assert response.status_code == 200, response.text
        return [i["id"] for i in response.json()["incidents"]]

    assert ids() == [third["id"], fire["id"]]  # default: open only
    assert ids(status="resolved") == [flood["id"]]
    assert ids(status="all") == [third["id"], fire["id"], flood["id"]]
    assert ids(type="fire", status="all") == [third["id"], fire["id"]]
    assert ids(type="flood") == []
    assert ids(status="all", limit=1) == [third["id"]]
    assert ids(status="all", lat=DELHI[0], lon=DELHI[1], limit=2) == [third["id"], fire["id"]]


@pytest.mark.parametrize(
    "params",
    [
        {"lat": DELHI[0]},
        {"lon": DELHI[1]},
        {"lat": DELHI[0], "lon": DELHI[1], "radius_km": 0},
        {"lat": DELHI[0], "lon": DELHI[1], "radius_km": 5000},
        {"status": "closed"},
        {"type": "volcano"},
        {"limit": 0},
        {"limit": 1000},
    ],
)
def test_list_validation(client: TestClient, params: dict[str, Any]) -> None:
    response = client.get("/api/incidents", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] in {"validation_error", "invalid_input"}


def test_get_incident_and_404(client: TestClient, auth_headers: Headers) -> None:
    created = create(client, auth_headers())

    response = client.get(f"/api/incidents/{created['id']}")
    assert response.status_code == 200
    assert response.json() == created

    missing = client.get("/api/incidents/does-not-exist")
    assert_envelope(missing, 404, "not_found")


# ---------------------------------------------------------------------------------------------
# Upvotes
# ---------------------------------------------------------------------------------------------
def test_upvote_is_idempotent_and_verifies_at_threshold(
    client: TestClient, auth_headers: Headers, settings: Settings
) -> None:
    assert settings.incident_verify_threshold == 3
    incident = create(client, auth_headers("reporter"))
    url = f"/api/incidents/{incident['id']}/upvote"

    first = client.post(url, headers=auth_headers("u2"))
    again = client.post(url, headers=auth_headers("u2"))
    assert first.status_code == again.status_code == 200
    assert again.json()["upvotes"] == 1
    assert again.json()["upvoted_by_me"] is True
    assert again.json()["verified"] is False

    assert client.post(url, headers=auth_headers("u3")).json()["verified"] is False
    third = client.post(url, headers=auth_headers("u4")).json()
    assert third["upvotes"] == 3
    assert third["verified"] is True

    # upvoted_by_me reflects the caller on every read endpoint.
    detail = f"/api/incidents/{incident['id']}"
    assert client.get(detail, headers=auth_headers("u2")).json()["upvoted_by_me"] is True
    assert client.get(detail, headers=auth_headers("u9")).json()["upvoted_by_me"] is False
    assert client.get(detail).json()["upvoted_by_me"] is False
    listed = client.get("/api/incidents", headers=auth_headers("u3")).json()["incidents"]
    assert listed[0]["upvoted_by_me"] is True
    assert listed[0]["verified"] is True


def test_verify_threshold_is_configurable(
    settings_factory: Callable[..., Settings], auth_headers: Headers
) -> None:
    app = create_app(settings_factory(incident_verify_threshold=1))
    with TestClient(app) as client:
        incident = create(client, auth_headers("reporter"))
        voted = client.post(
            f"/api/incidents/{incident['id']}/upvote", headers=auth_headers("u2")
        ).json()
    assert voted["verified"] is True


def test_reporter_cannot_upvote_own_report(client: TestClient, auth_headers: Headers) -> None:
    incident = create(client, auth_headers("u1"))
    response = client.post(f"/api/incidents/{incident['id']}/upvote", headers=auth_headers("u1"))
    assert_envelope(response, 403, "forbidden")


def test_upvote_requires_auth_and_existing_incident(
    client: TestClient, auth_headers: Headers
) -> None:
    incident = create(client, auth_headers("u1"))
    assert_envelope(client.post(f"/api/incidents/{incident['id']}/upvote"), 401, "unauthorized")
    assert_envelope(
        client.post("/api/incidents/nope/upvote", headers=auth_headers("u2")), 404, "not_found"
    )


def test_concurrent_duplicate_upvote_is_ignored(
    client: TestClient,
    auth_headers: Headers,
    run_db: Callable[..., Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The UNIQUE(incident_id, user_id) constraint resolves a lost race without double counting."""
    incident = create(client, auth_headers("reporter"))
    client.post(f"/api/incidents/{incident['id']}/upvote", headers=auth_headers("u2"))

    async def never_voted(*_: Any) -> bool:
        return False  # simulate the race: the check ran before the other request committed

    monkeypatch.setattr(incident_service, "_has_voted", never_voted)

    async def vote_again(session: AsyncSession) -> tuple[Any, int]:
        out = await incident_service.upvote(session, incident["id"], CurrentUser(id="u2"))
        votes = await session.scalar(
            select(func.count()).select_from(IncidentVote).where(IncidentVote.user_id == "u2")
        )
        return out, int(votes or 0)

    out, votes = run_db(vote_again)
    assert out.upvotes == 1
    assert out.upvoted_by_me is True
    assert votes == 1


# ---------------------------------------------------------------------------------------------
# Status updates
# ---------------------------------------------------------------------------------------------
def test_patch_status_reporter_only(client: TestClient, auth_headers: Headers) -> None:
    incident = create(client, auth_headers("u1"))
    url = f"/api/incidents/{incident['id']}"

    assert_envelope(
        client.patch(url, json={"status": "resolved"}, headers=auth_headers("intruder")),
        403,
        "forbidden",
    )
    assert_envelope(client.patch(url, json={"status": "resolved"}), 401, "unauthorized")
    assert_envelope(
        client.patch(url, json={"status": "closed"}, headers=auth_headers("u1")),
        422,
        "validation_error",
    )

    resolved = client.patch(url, json={"status": "resolved"}, headers=auth_headers("u1"))
    assert resolved.status_code == 200
    body = resolved.json()
    assert body["status"] == "resolved"
    assert datetime.fromisoformat(body["updated_at"]) >= datetime.fromisoformat(body["created_at"])

    # Re-opening works; repeating the current status is a harmless no-op.
    assert (
        client.patch(url, json={"status": "open"}, headers=auth_headers("u1")).json()["status"]
        == "open"
    )
    assert client.patch(url, json={"status": "open"}, headers=auth_headers("u1")).status_code == 200


def test_patch_unknown_incident(client: TestClient, auth_headers: Headers) -> None:
    response = client.patch(
        "/api/incidents/missing", json={"status": "resolved"}, headers=auth_headers()
    )
    assert_envelope(response, 404, "not_found")


# ---------------------------------------------------------------------------------------------
# Service helpers
# ---------------------------------------------------------------------------------------------
def test_reporter_display_name() -> None:
    assert (
        incident_service.reporter_display_name(CurrentUser(id="a", name="  Ravi  K ")) == "Ravi K"
    )
    assert incident_service.reporter_display_name(CurrentUser(id="a", email="x@y.z")) == "Anonymous"


def test_incidents_are_persisted(
    client: TestClient, auth_headers: Headers, run_db: Callable[..., Any]
) -> None:
    created = create(client, auth_headers("u7", "Meera"))

    async def load(session: AsyncSession) -> Incident | None:
        return await session.get(Incident, created["id"])

    row = run_db(load)
    assert row is not None
    assert (row.reporter_id, row.reporter_name, row.status) == ("u7", "Meera", "open")
