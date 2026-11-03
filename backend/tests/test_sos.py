"""Tests for ``POST /api/sos``, ``GET /api/sos/history`` and :mod:`app.services.sms`."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from twilio.base.exceptions import TwilioRestException

from app.api.routes import sos as sos_routes
from app.api.routes.sos import (
    build_fallback_sms_uri,
    build_maps_link,
    build_sms_body,
    format_coordinate,
    numbers_needing_fallback,
)
from app.core.config import Settings
from app.db.models import SOSEvent
from app.main import create_app
from app.schemas.sos import MAX_SMS_BODY_CHARS, SMSFailed, SMSResult, SMSSent
from app.services import sms as sms_module
from app.services.sms import SMSService
from conftest import TEST_INTERNAL_KEY

IN_NUMBER = "+919876543210"
US_NUMBER = "+14155550123"
BAD_NUMBER = "+15005550001"  # Twilio's magic "invalid number"

TWILIO_SETTINGS: dict[str, Any] = {
    "twilio_account_sid": "AC" + "0" * 32,
    "twilio_auth_token": "test-auth-token",
    "twilio_from_number": "+15005550006",
}


# ----------------------------------------------------------------------------------------------
# Fake Twilio
# ----------------------------------------------------------------------------------------------
@dataclass
class FakeMessage:
    sid: str
    status: str = "queued"


@dataclass
class FakeTwilio:
    """Records ``messages.create`` calls; behaviour per destination number."""

    fail_with: dict[str, BaseException] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def messages(self) -> FakeTwilio:
        return self

    def create(self, **kwargs: Any) -> FakeMessage:
        with self.lock:
            self.calls.append(kwargs)
            index = len(self.calls)
        error = self.fail_with.get(kwargs["to"])
        if error is not None:
            raise error
        return FakeMessage(sid=f"SM{index:032d}")


def invalid_number_error(number: str) -> TwilioRestException:
    return TwilioRestException(
        400,
        "https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json",
        msg=f"The 'To' number {number} is not a valid phone number.",
        code=21211,
        method="POST",
    )


@pytest.fixture
def fake_twilio() -> FakeTwilio:
    return FakeTwilio(fail_with={BAD_NUMBER: invalid_number_error(BAD_NUMBER)})


@pytest.fixture
def twilio_client(
    settings_factory: Callable[..., Settings],
    fake_twilio: FakeTwilio,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    """App with Twilio configured; the real SDK client class is replaced by the fake."""
    created: list[dict[str, Any]] = []

    def fake_client_class(*args: Any, **kwargs: Any) -> FakeTwilio:
        created.append({"args": args, "kwargs": kwargs})
        return fake_twilio

    monkeypatch.setattr(sms_module, "TwilioClient", fake_client_class)
    settings = settings_factory(**TWILIO_SETTINGS)
    with TestClient(create_app(settings)) as client:
        client.created_twilio_clients = created  # type: ignore[attr-defined]
        yield client


def sos_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "lat": 28.6139,
        "lon": 77.209,
        "message": "Trapped by flood water",
        "contact_numbers": [IN_NUMBER, US_NUMBER],
        "user_name": "Asha",
    }
    payload.update(overrides)
    return payload


def all_events(run_db: Callable[..., Any]) -> list[SOSEvent]:
    async def _query(session: AsyncSession) -> list[SOSEvent]:
        return list(await session.scalars(select(SOSEvent).order_by(SOSEvent.created_at)))

    return run_db(_query)


# ----------------------------------------------------------------------------------------------
# Pure helpers
# ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (28.6139, "28.6139"),
        (77.0, "77"),
        (77.209, "77.209"),
        (0.00001, "0.00001"),
        (-0.0, "0"),
        (0.0, "0"),
        (-33.8688197, "-33.86882"),
        (12.1234567, "12.123457"),
        (-0.0000001, "0"),
        (10.5, "10.5"),
    ],
)
def test_format_coordinate(value: float, expected: str) -> None:
    assert format_coordinate(value) == expected


def test_maps_link() -> None:
    assert build_maps_link(28.6139, 77.209) == "https://maps.google.com/?q=28.6139,77.209"


def test_sms_body_format() -> None:
    when = datetime(2026, 11, 2, 14, 5, 9, tzinfo=UTC)
    body = build_sms_body("Asha", "Help!", "https://maps.google.com/?q=1,2", when)
    assert body == (
        "🆘 SOS from Asha: Help! | Location: https://maps.google.com/?q=1,2 | 2026-11-02 14:05 UTC"
    )


def test_sms_body_is_truncated_but_keeps_location_and_time() -> None:
    when = datetime(2026, 11, 2, 14, 5, tzinfo=UTC)
    link = build_maps_link(-33.8688197, 151.2092955)
    body = build_sms_body("N" * 80, "word " * 60, link, when)
    assert len(body) <= MAX_SMS_BODY_CHARS
    assert body.endswith(f"| Location: {link} | 2026-11-02 14:05 UTC")
    assert "…" in body
    assert body.startswith("🆘 SOS from " + "N" * 80 + ": word")


def test_sms_body_collapses_whitespace_and_defaults_name() -> None:
    when = datetime(2026, 1, 1, tzinfo=UTC)
    body = build_sms_body("   ", "line1\n\nline2", "L", when)
    assert body.startswith("🆘 SOS from Anonymous: line1 line2 |")


def test_fallback_uri_encodes_body() -> None:
    uri = build_fallback_sms_uri([IN_NUMBER, US_NUMBER], "Help & come | now?")
    assert uri == f"sms:{IN_NUMBER},{US_NUMBER}?&body=Help%20%26%20come%20%7C%20now%3F"
    assert build_fallback_sms_uri([], "x") == "sms:?&body=x"


def test_numbers_needing_fallback() -> None:
    numbers = [IN_NUMBER, US_NUMBER]
    not_configured = SMSResult(configured=False)
    assert numbers_needing_fallback(numbers, not_configured) == numbers

    partial = SMSResult(
        configured=True,
        sent=[SMSSent(to="+91******3210", sid="SM1", status="queued")],
        failed=[SMSFailed(to="+14*****0123", error="boom")],
    )
    assert numbers_needing_fallback(numbers, partial) == [US_NUMBER]

    all_failed = SMSResult(configured=True, failed=partial.failed)
    assert numbers_needing_fallback(numbers, all_failed) == numbers

    all_sent = SMSResult(configured=True, sent=partial.sent)
    assert numbers_needing_fallback(numbers, all_sent) == numbers


# ----------------------------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad_number",
    ["9876543210", "+0123456789", "+12345", "+1234567890123456", "+91abc4567890", ""],
)
def test_sos_rejects_non_e164_numbers(client: TestClient, bad_number: str) -> None:
    response = client.post("/api/sos", json=sos_payload(contact_numbers=[bad_number]))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert "contact_numbers" in error["message"]
    assert error["request_id"]


def test_sos_normalises_and_dedupes_numbers(client: TestClient, run_db: Callable) -> None:
    numbers = ["+91 98765-43210", "+919876543210", "0091 (98765) 43210", "+1 415.555.0123"]
    response = client.post("/api/sos", json=sos_payload(contact_numbers=numbers))
    assert response.status_code == 200, response.text
    uri = response.json()["fallback_sms_uri"]
    assert uri.startswith(f"sms:{IN_NUMBER},{US_NUMBER}?&body=")
    assert all_events(run_db)[0].contacts_count == 2


def test_sos_rejects_more_than_ten_contacts(client: TestClient) -> None:
    numbers = [f"+9198765432{i:02d}" for i in range(11)]
    response = client.post("/api/sos", json=sos_payload(contact_numbers=numbers))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"

    ok = client.post("/api/sos", json=sos_payload(contact_numbers=numbers[:10]))
    assert ok.status_code == 200


@pytest.mark.parametrize(
    "overrides",
    [
        {"lat": 91},
        {"lon": -181},
        {"message": ""},
        {"message": "x" * 301},
        {"user_name": "n" * 81},
        {"accuracy_m": -1},
    ],
)
def test_sos_rejects_invalid_fields(client: TestClient, overrides: dict[str, Any]) -> None:
    response = client.post("/api/sos", json=sos_payload(**overrides))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# ----------------------------------------------------------------------------------------------
# Twilio not configured
# ----------------------------------------------------------------------------------------------
def test_sos_without_twilio_returns_native_sms_fallback(
    client: TestClient, run_db: Callable
) -> None:
    response = client.post("/api/sos", json=sos_payload(accuracy_m=12.5))
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["sms"] == {"configured": False, "sent": [], "failed": []}
    assert body["maps_link"] == "https://maps.google.com/?q=28.6139,77.209"
    assert body["message"] == "Trapped by flood water"
    assert body["id"]
    assert datetime.fromisoformat(body["timestamp"]).tzinfo is not None

    prefix = f"sms:{IN_NUMBER},{US_NUMBER}?&body="
    assert body["fallback_sms_uri"].startswith(prefix)
    sms_text = unquote(body["fallback_sms_uri"][len(prefix) :])
    assert sms_text.startswith("🆘 SOS from Asha: Trapped by flood water | Location: ")
    assert body["maps_link"] in sms_text
    assert sms_text.endswith(" UTC")
    assert len(sms_text) <= MAX_SMS_BODY_CHARS

    [event] = all_events(run_db)
    assert event.id == body["id"]
    assert event.user_id is None
    assert event.user_name == "Asha"
    assert (event.lat, event.lon, event.accuracy_m) == (28.6139, 77.209, 12.5)
    assert (event.contacts_count, event.sms_sent, event.sms_failed) == (2, 0, 0)
    # A keyed hash of the IP, never the IP itself (TestClient's peer is "testclient").
    assert event.client_ip_hash and len(event.client_ip_hash) == 64
    assert "testclient" not in event.client_ip_hash


def test_sos_without_contacts(client: TestClient) -> None:
    response = client.post("/api/sos", json={"lat": 1.5, "lon": 2.25})
    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "SOS! I need help!"
    assert body["sms"]["configured"] is False
    assert body["fallback_sms_uri"].startswith("sms:?&body=")
    assert "SOS%20from%20Anonymous" in body["fallback_sms_uri"]


def test_sos_uses_session_name_when_body_has_none(
    client: TestClient, auth_headers: Callable[..., dict[str, str]], run_db: Callable
) -> None:
    response = client.post(
        "/api/sos",
        json=sos_payload(user_name="  "),
        headers=auth_headers("github:42", name="Ravi Kumar"),
    )
    assert response.status_code == 200
    assert "SOS%20from%20Ravi%20Kumar" in response.json()["fallback_sms_uri"]
    [event] = all_events(run_db)
    assert event.user_id == "github:42"
    assert event.user_name == "Ravi Kumar"


def from_next(ip: str, internal_key: str) -> dict[str, str]:
    """Headers of a request relayed by our Next.js server for the browser at ``ip``."""
    return {"X-ResQ-Client-IP": ip, "X-Internal-Key": internal_key}


def test_sos_client_ip_hash_uses_the_address_reported_by_next(
    client: TestClient, run_db: Callable, settings: Settings
) -> None:
    key = settings.internal_api_key
    client.post("/api/sos", json=sos_payload(), headers=from_next("203.0.113.7", key))
    client.post("/api/sos", json=sos_payload(), headers=from_next("203.0.113.7", key))
    client.post("/api/sos", json=sos_payload(), headers=from_next("198.51.100.1", key))
    hashes = [event.client_ip_hash for event in all_events(run_db)]
    assert hashes[0] == hashes[1] != hashes[2]


def test_sos_client_ip_ignores_client_supplied_addresses(
    client: TestClient, run_db: Callable
) -> None:
    """X-Forwarded-For / X-ResQ-Client-IP without the internal key are attacker-controlled."""
    client.post("/api/sos", json=sos_payload())
    client.post("/api/sos", json=sos_payload(), headers={"X-Forwarded-For": "203.0.113.7"})
    client.post(
        "/api/sos",
        json=sos_payload(),
        headers={"X-ResQ-Client-IP": "198.51.100.1", "X-Internal-Key": "wrong"},
    )
    hashes = {event.client_ip_hash for event in all_events(run_db)}
    assert len(hashes) == 1  # all three keyed on the socket peer


def test_sos_still_succeeds_when_audit_write_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def broken_commit(self: AsyncSession) -> None:
        raise OSError("disk full at row ('Asha', 28.6139, 'Trapped by flood water')")

    monkeypatch.setattr(AsyncSession, "commit", broken_commit)
    with caplog.at_level(logging.ERROR, logger="app"):
        response = client.post("/api/sos", json=sos_payload())
    assert response.status_code == 200
    assert response.json()["fallback_sms_uri"].startswith("sms:")
    assert any("Could not store SOS event" in r.getMessage() for r in caplog.records)
    # Only the exception type is logged (driver messages may quote the row's values).
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "Trapped by flood water" not in logged and "OSError" in logged
    assert not any(r.exc_info for r in caplog.records)


def test_slow_audit_write_cannot_delay_the_sos_response(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A locked/slow database must not push a delivered SOS past the proxy's timeout."""
    import asyncio
    import time

    async def hanging_commit(self: AsyncSession) -> None:
        await asyncio.sleep(30)

    monkeypatch.setattr(sos_routes, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(AsyncSession, "commit", hanging_commit)
    started = time.monotonic()
    response = client.post("/api/sos", json=sos_payload())
    assert response.status_code == 200
    assert time.monotonic() - started < 3


# ----------------------------------------------------------------------------------------------
# Twilio configured
# ----------------------------------------------------------------------------------------------
def test_sos_with_twilio_sends_to_every_contact(
    twilio_client: TestClient, fake_twilio: FakeTwilio, run_db: Callable
) -> None:
    response = twilio_client.post("/api/sos", json=sos_payload())
    assert response.status_code == 200, response.text
    sms = response.json()["sms"]

    assert sms["configured"] is True
    assert sms["failed"] == []
    assert [item["to"] for item in sms["sent"]] == ["+91******3210", "+14*****0123"]
    assert all(item["sid"].startswith("SM") and item["status"] == "queued" for item in sms["sent"])

    assert sorted(call["to"] for call in fake_twilio.calls) == sorted([IN_NUMBER, US_NUMBER])
    for call in fake_twilio.calls:
        assert call["from_"] == TWILIO_SETTINGS["twilio_from_number"]
        assert "messaging_service_sid" not in call
        assert call["body"].startswith("🆘 SOS from Asha: Trapped by flood water | Location: ")
        assert len(call["body"]) <= MAX_SMS_BODY_CHARS

    # The real SDK class was built with the credentials and a bounded-timeout HTTP client.
    created = twilio_client.created_twilio_clients  # type: ignore[attr-defined]
    assert created, "Twilio client was never constructed"
    first = created[0]
    assert first["args"] == (TWILIO_SETTINGS["twilio_account_sid"], "test-auth-token")
    # Short (connect, read) timeouts: a single number would apply to each phase.
    http_client = first["kwargs"]["http_client"]
    assert isinstance(http_client, sms_module.BoundedTwilioHttpClient)
    assert http_client.timeout == (
        sms_module.TWILIO_CONNECT_TIMEOUT_SECONDS,
        sms_module.TWILIO_READ_TIMEOUT_SECONDS,
    )
    assert sum(http_client.timeout) < sms_module.SEND_DEADLINE_SECONDS < 20

    [event] = all_events(run_db)
    assert (event.contacts_count, event.sms_sent, event.sms_failed) == (2, 2, 0)


def test_sos_with_twilio_reports_failures_masked(
    twilio_client: TestClient,
    fake_twilio: FakeTwilio,
    run_db: Callable,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake_twilio.fail_with[US_NUMBER] = ConnectionError(f"cannot reach api for {US_NUMBER}")
    numbers = [IN_NUMBER, BAD_NUMBER, US_NUMBER]
    with caplog.at_level(logging.DEBUG, logger="app"):
        response = twilio_client.post("/api/sos", json=sos_payload(contact_numbers=numbers))
    assert response.status_code == 200
    body = response.json()
    sms = body["sms"]

    assert [item["to"] for item in sms["sent"]] == ["+91******3210"]
    failed = {item["to"]: item["error"] for item in sms["failed"]}
    assert set(failed) == {"+15*****0001", "+14*****0123"}
    assert failed["+15*****0001"].startswith("Twilio error 21211: ")
    assert "+15*****0001" in failed["+15*****0001"]
    assert failed["+14*****0123"] == "SMS provider unreachable, please retry."

    # Only the numbers that were not reached are offered in the native-SMS fallback.
    assert body["fallback_sms_uri"].startswith(f"sms:{BAD_NUMBER},{US_NUMBER}?&body=")

    # Full numbers never appear in the response's sms block nor in any log line.
    for number in numbers:
        assert number not in response.text.split("fallback_sms_uri")[0]
        assert number.lstrip("+") not in str(sms)
        assert all(number not in record.getMessage() for record in caplog.records)

    [event] = all_events(run_db)
    assert (event.contacts_count, event.sms_sent, event.sms_failed) == (3, 1, 2)


async def test_sms_service_prefers_messaging_service(
    settings_factory: Callable[..., Settings],
) -> None:
    fake = FakeTwilio()
    settings = settings_factory(**TWILIO_SETTINGS, twilio_messaging_service_sid="MG123")
    service = SMSService(settings, client_factory=lambda: fake)

    result = await service.send_bulk([IN_NUMBER, IN_NUMBER, ""], "hi")
    assert result.configured is True
    assert len(result.sent) == 1  # de-duplicated, blanks ignored
    assert fake.calls == [{"body": "hi", "to": IN_NUMBER, "messaging_service_sid": "MG123"}]


async def test_sms_service_not_configured_sends_nothing(settings: Settings) -> None:
    def factory() -> FakeTwilio:
        raise AssertionError("must not build a client")

    service = SMSService(settings, client_factory=factory)
    assert service.configured is False
    result = await service.send_bulk([IN_NUMBER], "hi")
    assert result == SMSResult(configured=False, sent=[], failed=[])


async def test_sms_service_configured_with_no_numbers(
    settings_factory: Callable[..., Settings],
) -> None:
    service = SMSService(settings_factory(**TWILIO_SETTINGS), client_factory=FakeTwilio)
    assert await service.send_bulk([], "hi") == SMSResult(configured=True)


async def test_sms_service_reuses_client_per_thread(
    settings_factory: Callable[..., Settings],
) -> None:
    built: list[FakeTwilio] = []

    def factory() -> FakeTwilio:
        client = FakeTwilio()
        built.append(client)
        return client

    service = SMSService(settings_factory(**TWILIO_SETTINGS), client_factory=factory)
    numbers = [f"+9198765432{i:02d}" for i in range(10)]
    first = await service.send_bulk(numbers, "a")
    second = await service.send_bulk(numbers, "b")
    assert len(first.sent) == len(second.sent) == 10
    # At most one client per worker thread, never one per message.
    assert 1 <= len(built) <= sms_module.MAX_CONCURRENT_SENDS
    assert sum(len(client.calls) for client in built) == 20


async def test_sms_service_uses_its_own_thread_pool(
    settings_factory: Callable[..., Settings],
) -> None:
    """SOS SMS never queue behind push deliveries/bcrypt in the loop's default executor."""
    threads: list[str] = []

    class RecordingTwilio(FakeTwilio):
        def create(self, **kwargs: Any) -> FakeMessage:
            threads.append(threading.current_thread().name)
            return super().create(**kwargs)

    service = SMSService(settings_factory(**TWILIO_SETTINGS), client_factory=RecordingTwilio)
    try:
        result = await service.send_bulk([IN_NUMBER, US_NUMBER], "hi")
    finally:
        service.close()
    assert len(result.sent) == 2
    assert threads and all(name.startswith("resq-sms") for name in threads)
    assert sms_module.MAX_CONCURRENT_SENDS >= 10  # every SOS contact in one parallel wave


async def test_sms_per_number_budget(settings_factory: Callable[..., Settings]) -> None:
    twilio = FakeTwilio()
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_per_number_limit="2/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    for _ in range(2):
        assert len((await service.send_bulk([IN_NUMBER], "hi")).sent) == 1

    third = await service.send_bulk([IN_NUMBER, US_NUMBER], "hi")
    assert [s.to for s in third.sent] == ["+14*****0123"]  # other numbers are unaffected
    assert third.failed == [SMSFailed(to="+91******3210", error=sms_module.NUMBER_BUDGET_ERROR)]
    assert [call["to"] for call in twilio.calls].count(IN_NUMBER) == 2


async def test_sms_global_budget(settings_factory: Callable[..., Settings]) -> None:
    twilio = FakeTwilio()
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_global_limit="3/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    numbers = [f"+9198765432{i:02d}" for i in range(5)]
    result = await service.send_bulk(numbers, "hi")
    assert len(result.sent) == 3
    assert len(result.failed) == 2
    assert {f.error for f in result.failed} == {sms_module.GLOBAL_BUDGET_ERROR}
    assert len(twilio.calls) == 3


async def test_sms_per_client_budget(settings_factory: Callable[..., Settings]) -> None:
    """Regression: one anonymous client could spend the whole server budget with made-up
    numbers (5 SOS/min x 10 numbers), leaving every real SOS "at capacity"."""
    twilio = FakeTwilio()
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_per_client_limit="3/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    attacker = [f"+1415555{i:04d}" for i in range(5)]
    result = await service.send_bulk(attacker, "x", client_key="ip:203.0.113.9", anonymous=True)
    assert len(result.sent) == 3
    assert {f.error for f in result.failed} == {sms_module.CLIENT_BUDGET_ERROR}
    # Another caller (and the same person after signing in) is unaffected.
    victim = await service.send_bulk([IN_NUMBER], "help", client_key="ip:198.51.100.1")
    assert len(victim.sent) == 1
    user = await service.send_bulk([US_NUMBER], "help", client_key="user:u1")
    assert len(user.sent) == 1
    assert len(twilio.calls) == 5


async def test_sms_anonymous_pool_never_drains_signed_in_budget(
    settings_factory: Callable[..., Settings],
) -> None:
    twilio = FakeTwilio()
    settings = settings_factory(
        **TWILIO_SETTINGS, sos_sms_anonymous_limit="2/hour", sos_sms_global_limit="4/hour"
    )
    service = SMSService(settings, client_factory=lambda: twilio)
    for i in range(3):  # three anonymous callers (rotating addresses)
        await service.send_bulk(
            [f"+1415555{i:04d}"], "x", client_key=f"ip:10.0.0.{i}", anonymous=True
        )
    guest = await service.send_bulk([IN_NUMBER], "help", client_key="ip:10.0.0.9", anonymous=True)
    assert guest.failed == [SMSFailed(to="+91******3210", error=sms_module.ANONYMOUS_BUDGET_ERROR)]
    signed_in = await service.send_bulk([IN_NUMBER, US_NUMBER], "help", client_key="user:u1")
    assert len(signed_in.sent) == 2
    assert len(twilio.calls) == 4


async def test_numbers_twilio_rejects_do_not_use_up_shared_budgets(
    settings_factory: Callable[..., Settings],
) -> None:
    bogus = [f"+1500555{i:04d}" for i in range(6)]
    twilio = FakeTwilio(fail_with={number: invalid_number_error(number) for number in bogus})
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_global_limit="3/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    rejected = await service.send_bulk(bogus, "x", client_key="ip:203.0.113.9", anonymous=True)
    # The first three were tried (and rejected for free); the rest hit the budget.
    assert [f.error.startswith("Twilio error 21211") for f in rejected.failed].count(True) == 3
    # Rejected messages were refunded: a real SOS still goes through.
    real = await service.send_bulk([IN_NUMBER, US_NUMBER], "help", client_key="user:u1")
    assert len(real.sent) == 2


async def test_concurrent_sos_share_one_wide_pool(
    settings_factory: Callable[..., Settings],
) -> None:
    """Regression: a 10-thread pool sized for one SOS made the 2nd..6th simultaneous SOS wait
    for earlier waves, answering after the proxy's 20 s timeout although the SMS went out."""
    import asyncio

    active = 0
    peak = 0
    lock = threading.Lock()
    everyone_in = threading.Event()

    class SlowTwilio(FakeTwilio):
        def create(self, **kwargs: Any) -> FakeMessage:
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                if active >= 30:
                    everyone_in.set()
            everyone_in.wait(timeout=2)
            with lock:
                active -= 1
            return super().create(**kwargs)

    twilio = SlowTwilio()
    service = SMSService(settings_factory(**TWILIO_SETTINGS), client_factory=lambda: twilio)
    try:
        batches = [[f"+91987{b}{i:05d}" for i in range(10)] for b in range(3)]
        results = await asyncio.gather(
            *(
                service.send_bulk(numbers, "x", client_key=f"user:u{b}")
                for b, numbers in enumerate(batches)
            )
        )
    finally:
        service.close()
    assert [len(r.sent) for r in results] == [10, 10, 10]
    assert peak == 30  # all three SOS in one wave


async def test_send_bulk_answers_by_its_deadline(
    settings_factory: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sends still queued at the deadline are cancelled (and refunded); sends in flight are
    reported as unconfirmed — the SOS response never waits for a slow Twilio."""
    import time

    monkeypatch.setattr(sms_module, "SMS_WORKER_THREADS", 1)
    gate = threading.Event()

    class StuckTwilio(FakeTwilio):
        def create(self, **kwargs: Any) -> FakeMessage:
            gate.wait(timeout=5)
            return super().create(**kwargs)

    twilio = StuckTwilio()
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_per_number_limit="1/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    service.deadline_seconds = 0.2
    try:
        started = time.monotonic()
        result = await service.send_bulk([IN_NUMBER, US_NUMBER], "x")
        assert time.monotonic() - started < 2
        assert result.sent == []
        assert result.failed == [
            SMSFailed(to="+91******3210", error=sms_module.UNCONFIRMED_ERROR),
            SMSFailed(to="+14*****0123", error=sms_module.NOT_SENT_IN_TIME_ERROR),
        ]
        gate.set()
        # The cancelled number was never sent, so its per-number budget was given back.
        retry = await service.send_bulk([US_NUMBER], "x")
        assert len(retry.sent) == 1
    finally:
        gate.set()
        service.close()


def test_sos_ipv6_rotation_inside_a_64_is_rate_limited(client: TestClient) -> None:
    """Regression: 50 SOS from 2001:db8:1:2::1 ... ::32 all passed a 5/minute limit."""
    payload = sos_payload(contact_numbers=[])
    statuses = [
        client.post(
            "/api/sos",
            json=payload,
            headers=from_next(f"2001:db8:1:2::{i + 1:x}", TEST_INTERNAL_KEY),
        ).status_code
        for i in range(7)
    ]
    assert statuses == [200] * 5 + [429] * 2


def test_sos_budget_refusals_fall_back_to_native_sms(
    settings_factory: Callable[..., Settings],
    fake_twilio: FakeTwilio,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rotating IPs (or accounts) cannot pump SMS to one number: refused numbers go to
    ``failed`` and into ``fallback_sms_uri`` while the SOS itself still succeeds."""
    monkeypatch.setattr(sms_module, "TwilioClient", lambda *a, **k: fake_twilio)
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_per_number_limit="1/hour")
    with TestClient(create_app(settings)) as client:
        first = client.post(
            "/api/sos", json=sos_payload(), headers=from_next("203.0.113.1", TEST_INTERNAL_KEY)
        )
        second = client.post(
            "/api/sos", json=sos_payload(), headers=from_next("203.0.113.2", TEST_INTERNAL_KEY)
        )
    assert len(first.json()["sms"]["sent"]) == 2
    body = second.json()
    assert second.status_code == 200
    assert body["sms"]["sent"] == []
    assert [f["error"] for f in body["sms"]["failed"]] == [sms_module.NUMBER_BUDGET_ERROR] * 2
    assert IN_NUMBER in body["fallback_sms_uri"] and US_NUMBER in body["fallback_sms_uri"]
    assert len(fake_twilio.calls) == 2


def test_sos_sms_can_be_reserved_for_signed_in_users(
    settings_factory: Callable[..., Settings],
    fake_twilio: FakeTwilio,
    monkeypatch: pytest.MonkeyPatch,
    make_token: Callable[..., str],
) -> None:
    monkeypatch.setattr(sms_module, "TwilioClient", lambda *a, **k: fake_twilio)
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_require_auth=True)
    with TestClient(create_app(settings)) as client:
        anonymous = client.post("/api/sos", json=sos_payload()).json()
        signed_in = client.post(
            "/api/sos",
            json=sos_payload(),
            headers={"Authorization": f"Bearer {make_token('u1')}"},
        ).json()
    assert anonymous["sms"]["sent"] == []
    assert [f["error"] for f in anonymous["sms"]["failed"]] == [
        sos_routes.SIGN_IN_REQUIRED_ERROR
    ] * 2
    assert IN_NUMBER in anonymous["fallback_sms_uri"]
    assert len(signed_in["sms"]["sent"]) == 2
    assert len(fake_twilio.calls) == 2


# ----------------------------------------------------------------------------------------------
# Rate limiting
# ----------------------------------------------------------------------------------------------
def test_sos_is_rate_limited(client: TestClient) -> None:
    payload = sos_payload(contact_numbers=[])
    for _ in range(5):
        ok = client.post("/api/sos", json=payload)
        assert ok.status_code == 200
        assert ok.headers["x-ratelimit-limit"] == "5"

    limited = client.post("/api/sos", json=payload)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert int(limited.headers["retry-after"]) >= 1
    assert limited.headers["x-ratelimit-remaining"] == "0"

    # Another browser (address reported by our Next.js server) has its own bucket.
    other = client.post(
        "/api/sos", json=payload, headers=from_next("198.51.100.9", TEST_INTERNAL_KEY)
    )
    assert other.status_code == 200


def test_sos_rate_limit_cannot_be_bypassed_with_forged_forwarded_for(client: TestClient) -> None:
    """Regression: a fresh X-Forwarded-For per request used to give a fresh 5/minute bucket."""
    payload = sos_payload(contact_numbers=[])
    statuses = [
        client.post(
            "/api/sos",
            json=payload,
            headers={
                "X-Forwarded-For": f"10.1.0.{i}, 172.18.0.5",
                "X-ResQ-Client-IP": f"10.2.0.{i}",
            },
        ).status_code
        for i in range(7)
    ]
    assert statuses == [200] * 5 + [429] * 2


def test_trusted_proxy_hops_uses_the_hop_added_by_our_proxy(
    settings_factory: Callable[..., Settings],
) -> None:
    """TRUSTED_PROXY_HOPS=1: the right-most entry (written by our proxy) is the client."""
    with TestClient(create_app(settings_factory(trusted_proxy_hops=1))) as client:
        payload = sos_payload(contact_numbers=[])
        statuses = [
            client.post(
                "/api/sos", json=payload, headers={"X-Forwarded-For": f"10.1.0.{i}, 203.0.113.7"}
            ).status_code
            for i in range(6)
        ]
        assert statuses == [200] * 5 + [429]
        fresh = client.post(
            "/api/sos", json=payload, headers={"X-Forwarded-For": "203.0.113.7, 198.51.100.9"}
        )
        assert fresh.status_code == 200


# ----------------------------------------------------------------------------------------------
# History
# ----------------------------------------------------------------------------------------------
def test_sos_history_requires_auth(client: TestClient) -> None:
    response = client.get("/api/sos/history")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"

    bad = client.get("/api/sos/history", headers={"Authorization": "Bearer not-a-jwt"})
    assert bad.status_code == 401


def test_sos_history_returns_own_events_newest_first(
    client: TestClient, auth_headers: Callable[..., dict[str, str]]
) -> None:
    alice = auth_headers("alice", name="Alice")
    bob = auth_headers("bob", name="Bob")
    first = client.post("/api/sos", json=sos_payload(message="first"), headers=alice).json()
    client.post("/api/sos", json=sos_payload(message="bob's"), headers=bob)
    client.post("/api/sos", json=sos_payload(message="anonymous"))
    second = client.post(
        "/api/sos",
        json=sos_payload(message="second", contact_numbers=[IN_NUMBER], lat=-1.25, lon=36.8),
        headers=alice,
    ).json()

    response = client.get("/api/sos/history", headers=alice)
    assert response.status_code == 200
    events = response.json()["events"]
    assert [e["id"] for e in events] == [second["id"], first["id"]]
    assert events[0] == {
        "id": second["id"],
        "timestamp": events[0]["timestamp"],
        "lat": -1.25,
        "lon": 36.8,
        "message": "second",
        "contacts_count": 1,
        "sms_sent": 0,
        "sms_failed": 0,
    }

    limited = client.get("/api/sos/history", params={"limit": 1}, headers=alice)
    assert [e["id"] for e in limited.json()["events"]] == [second["id"]]
    assert client.get("/api/sos/history", params={"limit": 51}, headers=alice).status_code == 422


def test_sos_history_empty(client: TestClient, auth_headers: Callable[..., dict[str, str]]) -> None:
    response = client.get("/api/sos/history", headers=auth_headers("nobody"))
    assert response.status_code == 200
    assert response.json() == {"events": []}


def test_sos_history_without_jwt_secret_is_503(
    settings_factory: Callable[..., Settings],
) -> None:
    with TestClient(create_app(settings_factory(backend_jwt_secret=""))) as client:
        response = client.get("/api/sos/history")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "not_configured"
        # SOS itself keeps working without auth configured.
        assert client.post("/api/sos", json=sos_payload()).status_code == 200


def test_route_module_constants() -> None:
    assert sos_routes.MAX_HISTORY_EVENTS == 50
    assert sos_routes.ANONYMOUS_NAME == "Anonymous"


# ----------------------------------------------------------------------------------------------
# Review round 3: accounts created on one address share one SMS budget
# ----------------------------------------------------------------------------------------------
async def test_sms_per_address_budget_is_shared_by_every_account(
    settings_factory: Callable[..., Settings],
) -> None:
    twilio = FakeTwilio()
    settings = settings_factory(
        **TWILIO_SETTINGS, sos_sms_per_client_limit="3/hour", sos_sms_per_address_limit="5/hour"
    )
    service = SMSService(settings, client_factory=lambda: twilio)
    sent = 0
    for user in range(4):  # four accounts on one address, three numbers each
        result = await service.send_bulk(
            [f"+1415555{user}{i:03d}" for i in range(3)],
            "x",
            client_key=f"user:sybil{user}",
            address_key="ip:203.0.113.7",
        )
        sent += len(result.sent)
        assert {f.error for f in result.failed} <= {sms_module.ADDRESS_BUDGET_ERROR}
    assert sent == 5
    other = await service.send_bulk([IN_NUMBER], "help", client_key="user:u1", address_key="ip:x")
    assert len(other.sent) == 1


def test_sybil_accounts_on_one_address_cannot_drain_the_global_sms_budget(
    settings_factory: Callable[..., Settings],
    fake_twilio: FakeTwilio,
    monkeypatch: pytest.MonkeyPatch,
    make_token: Callable[..., str],
) -> None:
    """Regression: the per-caller budget was keyed only by user id, so ~17 accounts
    registered from one IPv4 spent the whole global budget and every real SOS got
    GLOBAL_BUDGET_ERROR for the rest of the hour."""
    monkeypatch.setattr(sms_module, "TwilioClient", lambda *a, **k: fake_twilio)
    settings = settings_factory(
        **TWILIO_SETTINGS,
        sos_sms_per_client_limit="10/hour",
        sos_sms_per_address_limit="20/hour",
        sos_sms_global_limit="50/hour",
    )
    with TestClient(create_app(settings)) as client:
        accepted = 0
        for user in range(5):
            numbers = [f"+1415555{user}{i:03d}" for i in range(10)]
            response = client.post(
                "/api/sos",
                json=sos_payload(contact_numbers=numbers),
                headers={
                    **from_next("203.0.113.7", TEST_INTERNAL_KEY),
                    "Authorization": f"Bearer {make_token(f'sybil{user}')}",
                },
            )
            assert response.status_code == 200
            accepted += len(response.json()["sms"]["sent"])
        assert accepted == 20

        real = client.post(
            "/api/sos",
            json=sos_payload(),
            headers={
                **from_next("198.51.100.20", TEST_INTERNAL_KEY),
                "Authorization": f"Bearer {make_token('real-user')}",
            },
        ).json()
    assert len(real["sms"]["sent"]) == 2
    assert real["sms"]["failed"] == []


def test_signed_in_sms_without_a_reported_address_skips_the_address_budget(
    settings_factory: Callable[..., Settings],
    fake_twilio: FakeTwilio,
    monkeypatch: pytest.MonkeyPatch,
    make_token: Callable[..., str],
) -> None:
    """Without X-ResQ-Client-IP the peer is the Next.js server, shared by every user: it must
    not become one site-wide SMS budget for all signed-in users."""
    monkeypatch.setattr(sms_module, "TwilioClient", lambda *a, **k: fake_twilio)
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_per_address_limit="2/hour")
    with TestClient(create_app(settings)) as client:
        for user in range(3):
            body = client.post(
                "/api/sos",
                json=sos_payload(contact_numbers=[f"+1415555{user}000", f"+1415555{user}001"]),
                headers={"Authorization": f"Bearer {make_token(f'u{user}')}"},
            ).json()
            assert len(body["sms"]["sent"]) == 2


def test_locked_sqlite_database_delays_the_sos_by_the_audit_bound_only(
    settings_factory: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: a cancelled audit write still waited for SQLite's 5 s busy timeout (the
    graceful connection close waits for the driver thread), so a write-locked database
    delayed the SOS by ~5 s instead of AUDIT_WRITE_TIMEOUT_SECONDS."""
    import sqlite3
    import time

    from app.db import session as db_session

    assert db_session.SQLITE_BUSY_TIMEOUT_SECONDS <= sos_routes.AUDIT_WRITE_TIMEOUT_SECONDS
    monkeypatch.setattr(db_session, "SQLITE_BUSY_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(sos_routes, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.5)
    settings = settings_factory()
    path = settings.database_url.split("///", 1)[1]
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/sos", json=sos_payload(contact_numbers=[])).status_code == 200
        locked, release = threading.Event(), threading.Event()

        def hold_write_lock() -> None:
            con = sqlite3.connect(path, timeout=0)
            con.execute("BEGIN EXCLUSIVE")
            locked.set()
            release.wait(10)
            con.rollback()
            con.close()

        holder = threading.Thread(target=hold_write_lock)
        holder.start()
        try:
            assert locked.wait(5)
            started = time.monotonic()
            response = client.post("/api/sos", json=sos_payload(contact_numbers=[]))
            elapsed = time.monotonic() - started
        finally:
            release.set()
            holder.join()
        assert response.status_code == 200
        assert elapsed < 2.0  # ~0.5 s, not sqlite3's default 5 s busy wait
        # The pool recovered: the next SOS is stored normally.
        assert client.post("/api/sos", json=sos_payload(contact_numbers=[])).status_code == 200


async def test_send_finished_just_before_the_deadline_is_classified_by_its_result(
    settings_factory: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: the outcome was read from the asyncio wrapper, which learns the thread's
    result one loop iteration later. A rejection that finished right at the deadline was
    reported as UNCONFIRMED and its shared budgets were never refunded."""
    import time

    release = threading.Event()

    class SlowRejectingTwilio(FakeTwilio):
        def create(self, **kwargs: Any) -> FakeMessage:
            release.wait(timeout=5)
            return super().create(**kwargs)

    twilio = SlowRejectingTwilio(fail_with={BAD_NUMBER: invalid_number_error(BAD_NUMBER)})
    settings = settings_factory(**TWILIO_SETTINGS, sos_sms_global_limit="1/hour")
    service = SMSService(settings, client_factory=lambda: twilio)
    service.deadline_seconds = 0.1
    real_wait = asyncio.wait

    async def deadline_then_thread_finishes(*args: Any, **kwargs: Any) -> Any:
        outcome = await real_wait(*args, **kwargs)
        release.set()
        # Blocks the event loop on purpose: the job completes in its thread, but the
        # wrapper's done-callback cannot run before send_bulk classifies the results.
        time.sleep(0.3)  # noqa: ASYNC251
        return outcome

    monkeypatch.setattr(sms_module.asyncio, "wait", deadline_then_thread_finishes)
    try:
        result = await service.send_bulk([BAD_NUMBER], "x")
    finally:
        release.set()
    monkeypatch.undo()
    try:
        [failed] = result.failed
        assert failed.error.startswith("Twilio error 21211")
        # The rejection was free, so the global budget was refunded for a real SOS.
        real = await service.send_bulk([IN_NUMBER], "help")
        assert len(real.sent) == 1
    finally:
        service.close()
