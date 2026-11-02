"""Tests for the web push API (``/api/push/*``) and :mod:`app.services.push`."""

from __future__ import annotations

import base64
import json
import os
import threading
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
import pywebpush
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from py_vapid import Vapid01
from pywebpush import WebPushException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.db.models import PushSubscription
from app.main import create_app
from app.services import push as push_module
from app.services.push import PushHTTPSession, PushService, normalise_payload
from conftest import browser_push_keys

DELHI = (28.6139, 77.2090)
NEAR_DELHI = (28.70, 77.10)  # ~15 km
JAIPUR = (26.9124, 75.7873)  # ~235 km
MUMBAI = (19.0760, 72.8777)  # ~1150 km

PAYLOAD = {
    "title": "High flood reported nearby",
    "body": "Water rising near the station",
    "url": "/incidents?focus=abc",
    "tag": "incident-abc",
    "severity": "high",
}


# ----------------------------------------------------------------------------------------------
# Fakes / helpers
# ----------------------------------------------------------------------------------------------
class FakeSender:
    """Stands in for :func:`pywebpush.webpush`; outcome configurable per endpoint."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.status_by_endpoint: dict[str, int] = {}
        self.error_by_endpoint: dict[str, BaseException] = {}
        self._lock = threading.Lock()

    @property
    def endpoints(self) -> set[str]:
        return {call["subscription_info"]["endpoint"] for call in self.calls}

    def __call__(self, **kwargs: Any) -> Any:
        with self._lock:
            self.calls.append({**kwargs, "vapid_claims": dict(kwargs["vapid_claims"])})
        # Like the real webpush(), mutate the claims dict we were given.
        kwargs["vapid_claims"]["aud"] = "https://push.example"
        endpoint = kwargs["subscription_info"]["endpoint"]
        if endpoint in self.error_by_endpoint:
            raise self.error_by_endpoint[endpoint]
        status = self.status_by_endpoint.get(endpoint)
        if status is not None:
            response = SimpleNamespace(status_code=status, text="gone", headers={})
            raise WebPushException(f"Push failed: {status}", response=response)
        return SimpleNamespace(status_code=201, text="", headers={})


@pytest.fixture
def sender(monkeypatch: pytest.MonkeyPatch) -> FakeSender:
    fake = FakeSender()
    monkeypatch.setattr(push_module, "webpush", fake)
    return fake


def endpoint(name: str) -> str:
    return f"https://fcm.googleapis.com/fcm/send/{name}"


_KEYS: dict[str, tuple[str, str]] = {}


def keys_for(name: str) -> tuple[str, str]:
    """Stable, valid browser keys per device name (subscribe validates them)."""
    if name not in _KEYS:
        _KEYS[name] = browser_push_keys()
    return _KEYS[name]


def subscribe_body(name: str = "dev1", **overrides: Any) -> dict[str, Any]:
    p256dh, auth = keys_for(name)
    body: dict[str, Any] = {
        "subscription": {
            "endpoint": endpoint(name),
            "keys": {"p256dh": p256dh, "auth": auth},
            "expirationTime": None,
        },
        "lat": DELHI[0],
        "lon": DELHI[1],
        "radius_km": 25,
        "topics": ["incidents", "disasters"],
    }
    body.update(overrides)
    return body


def make_sub(
    name: str,
    location: tuple[float, float] | None = DELHI,
    *,
    radius_km: float = 50.0,
    topics: str = "incidents,disasters",
    user_id: str | None = None,
) -> PushSubscription:
    return PushSubscription(
        endpoint=endpoint(name),
        p256dh=f"p256dh-{name}",
        auth=f"auth-{name}",
        lat=location[0] if location else None,
        lon=location[1] if location else None,
        radius_km=radius_km,
        topics=topics,
        user_id=user_id,
    )


def add_subs(run_db: Callable[..., Any], *subs: PushSubscription) -> None:
    async def _add(session: AsyncSession) -> None:
        session.add_all(subs)
        await session.commit()

    run_db(_add)


def all_subs(run_db: Callable[..., Any]) -> dict[str, PushSubscription]:
    async def _query(session: AsyncSession) -> dict[str, PushSubscription]:
        rows = await session.scalars(select(PushSubscription))
        return {row.endpoint.rsplit("/", 1)[-1]: row for row in rows}

    return run_db(_query)


def notify(
    client: TestClient,
    run_db: Callable[..., Any],
    point: tuple[float, float],
    topic: str,
    payload: dict[str, Any] | None = None,
    **kwargs: Any,
) -> int:
    push: PushService = client.app.state.push  # type: ignore[attr-defined]

    async def _notify(session: AsyncSession) -> int:
        return await push.notify_nearby(
            session, point[0], point[1], dict(payload or PAYLOAD), topic, **kwargs
        )

    return run_db(_notify)


# ----------------------------------------------------------------------------------------------
# VAPID key endpoint / configuration
# ----------------------------------------------------------------------------------------------
def test_vapid_public_key_enabled(client: TestClient, settings: Settings) -> None:
    response = client.get("/api/push/vapid-public-key")
    assert response.status_code == 200
    # The alert poller is off in the test settings, so disaster alerts are not offered.
    assert response.json() == {
        "enabled": True,
        "public_key": settings.vapid_public_key,
        "disaster_alerts": False,
    }


def test_vapid_public_key_reports_disaster_alerts_when_poller_runs(
    settings_factory: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import alert_poller

    monkeypatch.setattr(alert_poller.AlertPoller, "start", lambda self: None)
    with TestClient(create_app(settings_factory(alert_poller_enabled=True))) as client:
        assert client.get("/api/push/vapid-public-key").json()["disaster_alerts"] is True


def test_vapid_public_key_disabled(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory(vapid_public_key="", vapid_private_key="")
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/push/vapid-public-key")
    assert response.json() == {"enabled": False, "public_key": None, "disaster_alerts": False}


def test_malformed_vapid_private_key_disables_push(
    settings_factory: Callable[..., Settings], caplog: pytest.LogCaptureFixture
) -> None:
    service = PushService(settings_factory(vapid_private_key="definitely-not-a-key"))
    assert service.enabled is False
    assert service.public_key is None
    assert any("VAPID_PRIVATE_KEY could not be parsed" in r.getMessage() for r in caplog.records)


# ----------------------------------------------------------------------------------------------
# Subscribe / unsubscribe
# ----------------------------------------------------------------------------------------------
def test_subscribe_creates_then_upserts_by_endpoint(
    client: TestClient, run_db: Callable, auth_headers: Callable[..., dict[str, str]]
) -> None:
    first = client.post("/api/push/subscribe", json=subscribe_body())
    assert first.status_code == 200, first.text
    created = first.json()
    assert created == {"id": created["id"], "radius_km": 25.0, "topics": ["incidents", "disasters"]}

    row = all_subs(run_db)["dev1"]
    assert (row.lat, row.lon, row.radius_km, row.topics) == (*DELHI, 25.0, "incidents,disasters")
    assert row.user_id is None
    assert (row.p256dh, row.auth) == keys_for("dev1")

    # Same endpoint again (signed in, new keys, no location, one topic): same row, updated.
    body = subscribe_body(lat=None, lon=None, radius_km=100, topics=["disasters", "disasters"])
    new_p256dh, new_auth = browser_push_keys()
    body["subscription"]["keys"] = {"p256dh": new_p256dh, "auth": new_auth}
    second = client.post("/api/push/subscribe", json=body, headers=auth_headers("u1"))
    assert second.status_code == 200
    assert second.json() == {"id": created["id"], "radius_km": 100.0, "topics": ["disasters"]}

    rows = all_subs(run_db)
    assert list(rows) == ["dev1"]
    row = rows["dev1"]
    assert (row.lat, row.lon, row.topics, row.user_id) == (None, None, "disasters", "u1")
    assert (row.p256dh, row.auth) == (new_p256dh, new_auth)
    assert row.updated_at >= row.created_at


def test_anonymous_resubscribe_keeps_user_link(
    client: TestClient, run_db: Callable, auth_headers: Callable[..., dict[str, str]]
) -> None:
    client.post("/api/push/subscribe", json=subscribe_body(), headers=auth_headers("u1"))
    client.post("/api/push/subscribe", json=subscribe_body(radius_km=10))
    row = all_subs(run_db)["dev1"]
    assert row.user_id == "u1"
    assert row.radius_km == 10.0

    client.post("/api/push/subscribe", json=subscribe_body(), headers=auth_headers("u2"))
    assert all_subs(run_db)["dev1"].user_id == "u2"


_P256DH, _AUTH = browser_push_keys()


def _sub(url: str, p256dh: str = _P256DH, auth: str = _AUTH) -> dict[str, Any]:
    return {"subscription": {"endpoint": url, "keys": {"p256dh": p256dh, "auth": auth}}}


@pytest.mark.parametrize(
    "overrides",
    [
        _sub("http://insecure.example/x"),
        # SSRF: the server POSTs to stored endpoints, so only browser push services pass.
        _sub("https://169.254.169.254/latest/api/token"),
        _sub("https://127.0.0.1:8000/api/users/register"),
        _sub("https://localhost/x"),
        _sub("https://metadata.google.internal/computeMetadata/v1/"),
        _sub("https://user@fcm.googleapis.com/fcm/send/x"),
        _sub(endpoint("x"), p256dh="not-a-key"),
        _sub(endpoint("x"), auth="short"),
        {"subscription": {"endpoint": endpoint("x"), "keys": {"p256dh": _P256DH}}},
        {"subscription": {"endpoint": endpoint("x"), "keys": {"p256dh": "", "auth": _AUTH}}},
        {"lat": 10.0, "lon": None},
        {"lat": 91.0},
        {"radius_km": 0},
        {"radius_km": 501},
        {"topics": []},
        {"topics": ["weather"]},
    ],
)
def test_subscribe_validation(client: TestClient, overrides: dict[str, Any]) -> None:
    response = client.post("/api/push/subscribe", json=subscribe_body(**overrides))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_subscribe_when_push_disabled_is_503(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory(vapid_private_key="")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/push/subscribe", json=subscribe_body())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_unsubscribe_is_idempotent(client: TestClient, run_db: Callable) -> None:
    client.post("/api/push/subscribe", json=subscribe_body("dev1"))
    client.post("/api/push/subscribe", json=subscribe_body("dev2"))

    for _ in range(2):
        response = client.post("/api/push/unsubscribe", json={"endpoint": endpoint("dev1")})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
    assert list(all_subs(run_db)) == ["dev2"]

    assert client.post("/api/push/unsubscribe", json={"endpoint": ""}).status_code == 422


# ----------------------------------------------------------------------------------------------
# Test notification
# ----------------------------------------------------------------------------------------------
def test_push_test_requires_auth(client: TestClient) -> None:
    response = client.post("/api/push/test")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_push_test_sends_to_own_devices_and_prunes_gone(
    client: TestClient,
    run_db: Callable,
    sender: FakeSender,
    auth_headers: Callable[..., dict[str, str]],
) -> None:
    add_subs(
        run_db,
        make_sub("phone", user_id="u1"),
        make_sub("old-laptop", user_id="u1"),
        make_sub("someone-else", user_id="u2"),
        make_sub("anonymous"),
    )
    sender.status_by_endpoint[endpoint("old-laptop")] = 410

    response = client.post("/api/push/test", headers=auth_headers("u1"))
    assert response.status_code == 200
    assert response.json() == {"sent": 1}
    assert sender.endpoints == {endpoint("phone"), endpoint("old-laptop")}
    payload = json.loads(sender.calls[0]["data"])
    assert payload["title"] == "ResQ AI test notification"
    assert payload["url"] == "/profile"

    assert sorted(all_subs(run_db)) == ["anonymous", "phone", "someone-else"]


def test_push_test_without_subscriptions(
    client: TestClient, sender: FakeSender, auth_headers: Callable[..., dict[str, str]]
) -> None:
    response = client.post("/api/push/test", headers=auth_headers("lonely"))
    assert response.json() == {"sent": 0}
    assert sender.calls == []


def test_push_test_when_disabled_is_503(
    settings_factory: Callable[..., Settings], make_token: Callable[..., str]
) -> None:
    settings = settings_factory(vapid_public_key="")
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/push/test", headers={"Authorization": f"Bearer {make_token('u1')}"}
        )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


# ----------------------------------------------------------------------------------------------
# notify_nearby
# ----------------------------------------------------------------------------------------------
def test_notify_nearby_respects_each_subscription_radius_and_topic(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(
        run_db,
        make_sub("near", NEAR_DELHI, radius_km=50),
        make_sub("near-small-radius", NEAR_DELHI, radius_km=5),
        make_sub("jaipur", JAIPUR, radius_km=50),
        make_sub("jaipur-wide", JAIPUR, radius_km=500),
        make_sub("mumbai-wide", MUMBAI, radius_km=500),
        make_sub("near-disasters-only", NEAR_DELHI, topics="disasters"),
        make_sub("no-location", None),
    )
    sent = notify(client, run_db, DELHI, "incidents")
    assert sent == 2
    assert sender.endpoints == {endpoint("near"), endpoint("jaipur-wide")}

    call = sender.calls[0]
    assert json.loads(call["data"]) == PAYLOAD
    assert call["ttl"] == 3600
    assert call["vapid_claims"] == {"sub": "mailto:test@example.com"}
    assert isinstance(call["vapid_private_key"], Vapid01)
    assert call["timeout"] == 10.0


def test_unlocated_subscriptions_only_get_red_disaster_alerts(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(
        run_db,
        make_sub("no-location", None),
        make_sub("no-location-incidents-only", None, topics="incidents"),
        make_sub("near", NEAR_DELHI),
    )
    red = {**PAYLOAD, "severity": "high"}
    orange = {**PAYLOAD, "severity": "medium"}

    assert notify(client, run_db, DELHI, "disasters", red) == 2
    assert sender.endpoints == {endpoint("no-location"), endpoint("near")}

    sender.calls.clear()
    assert notify(client, run_db, DELHI, "disasters", orange) == 1
    assert sender.endpoints == {endpoint("near")}

    sender.calls.clear()
    assert notify(client, run_db, DELHI, "incidents", red) == 1  # incidents need a location
    assert sender.endpoints == {endpoint("near")}

    sender.calls.clear()
    assert notify(client, run_db, DELHI, "disasters", orange, include_unlocated=True) == 2


def test_notify_nearby_can_exclude_a_user(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(
        run_db,
        make_sub("reporter", user_id="reporter"),
        make_sub("neighbour", user_id="neighbour"),
        make_sub("anonymous"),
    )
    assert notify(client, run_db, DELHI, "incidents", exclude_user_id="reporter") == 2
    assert sender.endpoints == {endpoint("neighbour"), endpoint("anonymous")}


def test_notify_nearby_across_the_antimeridian(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(run_db, make_sub("fiji", (-17.0, -179.95), radius_km=50))
    assert notify(client, run_db, (-17.0, 179.95), "incidents") == 1


def test_notify_nearby_counts_only_successes_and_prunes_gone(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(
        run_db,
        make_sub("ok"),
        make_sub("gone-404"),
        make_sub("gone-410"),
        make_sub("rate-limited"),
        make_sub("network-error"),
    )
    sender.status_by_endpoint.update(
        {endpoint("gone-404"): 404, endpoint("gone-410"): 410, endpoint("rate-limited"): 429}
    )
    sender.error_by_endpoint[endpoint("network-error")] = ConnectionError("boom")

    assert notify(client, run_db, DELHI, "incidents") == 1
    assert sorted(all_subs(run_db)) == ["network-error", "ok", "rate-limited"]


def test_notify_nearby_when_disabled_sends_nothing(
    settings_factory: Callable[..., Settings], sender: FakeSender
) -> None:
    settings = settings_factory(vapid_public_key="")
    with TestClient(create_app(settings)) as client:
        sessionmaker = client.app.state.sessionmaker  # type: ignore[attr-defined]
        push: PushService = client.app.state.push  # type: ignore[attr-defined]

        async def _notify() -> int:
            async with sessionmaker() as session:
                session.add(make_sub("x"))
                await session.commit()
                return await push.notify_nearby(session, *DELHI, dict(PAYLOAD), "incidents")

        assert client.portal is not None
        assert client.portal.call(_notify) == 0
    assert sender.calls == []


def test_notify_nearby_never_raises(
    client: TestClient, run_db: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    push: PushService = client.app.state.push  # type: ignore[attr-defined]

    async def broken_find(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("database exploded")

    monkeypatch.setattr(push, "find_nearby", broken_find)
    assert notify(client, run_db, DELHI, "incidents") == 0


# ----------------------------------------------------------------------------------------------
# send()
# ----------------------------------------------------------------------------------------------
def test_send_single_subscription(client: TestClient, run_db: Callable, sender: FakeSender) -> None:
    add_subs(run_db, make_sub("ok"), make_sub("gone"), make_sub("broken"))
    sender.status_by_endpoint[endpoint("gone")] = 410
    sender.status_by_endpoint[endpoint("broken")] = 500
    push: PushService = client.app.state.push  # type: ignore[attr-defined]

    async def _send_all(session: AsyncSession) -> dict[str, bool]:
        subs = (await session.scalars(select(PushSubscription))).all()
        return {
            sub.endpoint.rsplit("/", 1)[-1]: await push.send(session, sub, dict(PAYLOAD))
            for sub in subs
        }

    assert run_db(_send_all) == {"ok": True, "gone": False, "broken": False}
    assert sorted(all_subs(run_db)) == ["broken", "ok"]


def test_vapid_claims_are_fresh_for_every_delivery(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(run_db, make_sub("a"), make_sub("b"), make_sub("c"))
    assert notify(client, run_db, DELHI, "incidents") == 3
    # The fake mutates every claims dict it receives (like pywebpush does); none leaked.
    assert all(call["vapid_claims"] == {"sub": "mailto:test@example.com"} for call in sender.calls)


# ----------------------------------------------------------------------------------------------
# Payload normalisation
# ----------------------------------------------------------------------------------------------
def test_normalise_payload() -> None:
    assert normalise_payload(PAYLOAD) == PAYLOAD

    result = normalise_payload(
        {
            "title": "T" * 200,
            "body": "B" * 1000,
            "url": "https://evil.example/phish",
            "severity": "critical",
            "id": "extra-keys-are-kept",
        }
    )
    assert len(result["title"]) == 120 and result["title"].endswith("…")
    assert len(result["body"]) == 400
    assert result["url"] == "/"
    assert result["tag"] == "resq"
    assert result["severity"] == "medium"
    assert result["id"] == "extra-keys-are-kept"

    assert normalise_payload({"url": "//evil.example"})["url"] == "/"
    assert normalise_payload({})["title"] == "ResQ AI"


# ----------------------------------------------------------------------------------------------
# Real pywebpush (encryption + VAPID signing); only the HTTP POST is faked
# ----------------------------------------------------------------------------------------------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _browser_keys() -> tuple[str, str]:
    """A valid ``p256dh``/``auth`` pair like a browser's ``PushSubscription``."""
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return _b64url(public), _b64url(os.urandom(16))


def _no_module_level_post(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("push deliveries must use PushHTTPSession")


def test_real_webpush_encrypts_and_signs(
    client: TestClient,
    run_db: Callable,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posts: list[dict[str, Any]] = []
    statuses = {endpoint("real"): 201, endpoint("expired"): 410}

    def fake_post(url: str, **kwargs: Any) -> Any:
        posts.append({"url": url, **kwargs})
        return SimpleNamespace(
            status_code=statuses[url], reason="", text="", headers={}, content=b""
        )

    def fake_request(self: Any, method: str, url: str, **kwargs: Any) -> Any:
        assert isinstance(self, PushHTTPSession)
        assert method == "POST"
        assert kwargs["allow_redirects"] is False  # redirects could reach internal hosts
        return fake_post(url, **kwargs)

    # pywebpush posts through our per-thread PushHTTPSession (never module-level requests).
    monkeypatch.setattr(pywebpush.requests, "post", _no_module_level_post)
    monkeypatch.setattr(pywebpush.requests.Session, "request", fake_request)
    for name in ("real", "expired"):
        p256dh, auth = _browser_keys()
        sub = make_sub(name)
        sub.p256dh, sub.auth = p256dh, auth
        add_subs(run_db, sub)

    assert notify(client, run_db, DELHI, "incidents") == 1
    assert sorted(all_subs(run_db)) == ["real"]

    post = next(p for p in posts if p["url"] == endpoint("real"))
    headers = post["headers"]
    assert headers["ttl"] == "3600"
    assert headers["content-encoding"] == "aes128gcm"
    assert isinstance(post["data"], bytes) and len(post["data"]) > len(json.dumps(PAYLOAD))
    assert post["timeout"] == 10.0

    # VAPID: "vapid t=<jwt>,k=<our public key>" signed for the push service's origin.
    scheme, _, params = headers["authorization"].partition(" ")
    assert scheme == "vapid"
    parts = dict(item.strip().split("=", 1) for item in params.split(","))
    assert parts["k"] == settings.vapid_public_key
    claims = jwt.decode(parts["t"], options={"verify_signature": False})
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["sub"] == "mailto:test@example.com"


# ----------------------------------------------------------------------------------------------
# Hardening: SSRF, connection pool, failure tracking, throttles, limits
# ----------------------------------------------------------------------------------------------
def test_push_session_never_follows_redirects_and_refuses_non_push_hosts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, Any]] = []

    def fake_request(self: Any, method: str, url: str, **kwargs: Any) -> Any:
        seen.append({"url": url, **kwargs})
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(pywebpush.requests.Session, "request", fake_request)
    session = PushHTTPSession()
    assert session.max_redirects == 0
    session.post(endpoint("x"), data=b"", allow_redirects=True)
    assert seen == [{"url": endpoint("x"), "data": b"", "json": None, "allow_redirects": False}]

    for url in ("https://169.254.169.254/latest", "https://localhost/x", "http://x.example/"):
        with pytest.raises(ValueError):
            session.post(url, data=b"")
    assert len(seen) == 1


def test_legacy_rows_with_non_push_endpoints_are_removed_without_a_request(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    legacy = make_sub("legacy")
    legacy.endpoint = "https://169.254.169.254/latest/api/token"
    add_subs(run_db, make_sub("ok"), legacy)

    assert notify(client, run_db, DELHI, "incidents") == 1
    assert sender.endpoints == {endpoint("ok")}
    assert len(all_subs(run_db)) == 1


def test_fan_out_releases_the_database_connection_while_delivering(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    """Regression: slow deliveries used to pin a pooled connection for the whole fan-out."""
    engine = client.app.state.engine  # type: ignore[attr-defined]
    checked_out: list[int] = []
    threads: list[str] = []
    original = sender.__call__

    def recording(**kwargs: Any) -> Any:
        checked_out.append(engine.pool.checkedout())
        threads.append(threading.current_thread().name)
        return original(**kwargs)

    sender_proxy = SimpleNamespace(calls=sender.calls)
    push: PushService = client.app.state.push  # type: ignore[attr-defined]
    push._sender = recording  # type: ignore[assignment]
    add_subs(run_db, make_sub("a"), make_sub("b"), make_sub("c", user_id="u1"))

    assert notify(client, run_db, DELHI, "incidents") == 3

    async def _notify_user(session: AsyncSession) -> int:
        return await push.notify_user(session, "u1", dict(PAYLOAD))

    assert run_db(_notify_user) == 1
    assert checked_out == [0, 0, 0, 0]
    # Deliveries run on the push service's own pool, not the loop's default executor.
    assert all(name.startswith("resq-push") for name in threads)
    assert len(sender_proxy.calls) == 4


def test_repeated_failures_delete_the_subscription_and_success_resets(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(run_db, make_sub("flaky"), make_sub("dead"))
    sender.status_by_endpoint[endpoint("flaky")] = 500
    sender.status_by_endpoint[endpoint("dead")] = 500

    for attempt in range(1, push_module.MAX_CONSECUTIVE_FAILURES):
        assert notify(client, run_db, DELHI, "incidents") == 0
        rows = all_subs(run_db)
        assert rows["flaky"].failure_count == rows["dead"].failure_count == attempt

    del sender.status_by_endpoint[endpoint("flaky")]
    assert notify(client, run_db, DELHI, "incidents") == 1
    rows = all_subs(run_db)
    assert list(rows) == ["flaky"]  # "dead" reached MAX_CONSECUTIVE_FAILURES and was deleted
    assert rows["flaky"].failure_count == 0


def test_resubscribe_resets_the_failure_count(client: TestClient, run_db: Callable) -> None:
    assert client.post("/api/push/subscribe", json=subscribe_body("dev1")).status_code == 200

    async def _fail(session: AsyncSession) -> None:
        row = (await session.scalars(select(PushSubscription))).one()
        row.failure_count = 3
        await session.commit()

    run_db(_fail)
    client.post("/api/push/subscribe", json=subscribe_body("dev1"))
    assert all_subs(run_db)["dev1"].failure_count == 0


def test_fan_out_deadline_skips_remaining_deliveries(
    settings: Settings, run_db: Callable, client: TestClient
) -> None:
    release = threading.Event()
    calls: list[str] = []

    def slow_sender(**kwargs: Any) -> Any:
        calls.append(kwargs["subscription_info"]["endpoint"])
        release.wait(2)
        return SimpleNamespace(status_code=201)

    push = PushService(settings, sender=slow_sender, fanout_seconds=0.2)
    count = push_module.MAX_CONCURRENT_DELIVERIES + 5
    add_subs(run_db, *(make_sub(f"s{i}") for i in range(count)))

    async def _notify(session: AsyncSession) -> int:
        try:
            return await push.notify_nearby(session, *DELHI, dict(PAYLOAD), "incidents")
        finally:
            release.set()
            push.close()

    assert run_db(_notify) == 0
    assert len(calls) <= push_module.MAX_CONCURRENT_DELIVERIES  # the rest were never started
    assert len(all_subs(run_db)) == count  # skipped deliveries are not failures


def test_per_subscription_limit_throttles_repeat_notifications(
    client: TestClient, run_db: Callable, sender: FakeSender
) -> None:
    add_subs(run_db, make_sub("a"), make_sub("b"))
    assert notify(client, run_db, DELHI, "incidents", per_subscription_limit="1/hour") == 2
    assert notify(client, run_db, DELHI, "incidents", per_subscription_limit="1/hour") == 0
    assert len(sender.calls) == 2
    assert notify(client, run_db, DELHI, "incidents") == 2  # unthrottled callers unaffected


def test_unlink_detaches_the_device_from_its_account(
    client: TestClient, run_db: Callable, auth_headers: Callable[..., dict[str, str]]
) -> None:
    client.post("/api/push/subscribe", json=subscribe_body("dev1"), headers=auth_headers("u1"))
    assert all_subs(run_db)["dev1"].user_id == "u1"

    for _ in range(2):  # idempotent, also for unknown endpoints
        response = client.post("/api/push/unlink", json={"endpoint": endpoint("dev1")})
        assert response.json() == {"ok": True}
    assert client.post("/api/push/unlink", json={"endpoint": endpoint("nope")}).status_code == 200

    row = all_subs(run_db)["dev1"]
    assert row.user_id is None  # still subscribed for location alerts, just anonymous
    # The next signed-in subscribe links it to whoever uses the device now.
    client.post("/api/push/subscribe", json=subscribe_body("dev1"), headers=auth_headers("u2"))
    assert all_subs(run_db)["dev1"].user_id == "u2"


def test_subscribe_and_test_have_tighter_limits(
    client: TestClient, sender: FakeSender, auth_headers: Callable[..., dict[str, str]]
) -> None:
    from app.api.routes import push as push_routes

    allowed = int(push_routes.SUBSCRIBE_RATE_LIMIT.split("/", 1)[0])
    statuses = [
        client.post("/api/push/subscribe", json=subscribe_body(f"d{i}")).status_code
        for i in range(allowed + 1)
    ]
    assert statuses == [200] * allowed + [429]

    test_allowed = int(push_routes.TEST_RATE_LIMIT.split("/", 1)[0])
    headers = auth_headers("u9")
    tests = [client.post("/api/push/test", headers=headers).status_code for _ in range(6)]
    assert tests == [200] * test_allowed + [429] * (6 - test_allowed)
