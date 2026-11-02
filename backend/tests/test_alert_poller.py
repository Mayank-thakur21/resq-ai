"""Tests for :mod:`app.services.alert_poller` (GDACS -> web push background task).

The disaster feed is faked (it is another engineer's module; only its ``get_events``
interface matters here). The database is a real temporary SQLite file.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.errors import UpstreamError
from app.db.models import NotifiedEvent, PushSubscription
from app.db.session import create_engine, create_sessionmaker, init_db
from app.main import create_app
from app.schemas.alerts import DisasterEvent
from app.services import alert_poller as poller_module
from app.services import push as push_module
from app.services.alert_poller import (
    MAX_EVENTS_PER_CYCLE,
    AlertPoller,
    build_payload,
    is_recent,
    notification_key,
    select_candidates,
)
from app.services.push import PushService

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def make_event(event_id: str = "EQ-1001", level: str = "red", **overrides: Any) -> DisasterEvent:
    values: dict[str, Any] = {
        "id": event_id,
        "event_type": event_id.split("-")[0],
        "event_type_label": "Earthquake",
        "title": f"Earthquake {event_id}",
        "description": "M 6.8 earthquake near the coast",
        "alert_level": level,
        "severity_text": "Magnitude 6.8M, Depth:10km",
        "country": "Indonesia",
        "lat": -6.2,
        "lon": 106.8,
        "from_date": NOW - timedelta(hours=2),
        "to_date": NOW - timedelta(hours=1),
        "is_current": True,
        "url": f"https://www.gdacs.org/report.aspx?eventid={event_id}",
    }
    values.update(overrides)
    return DisasterEvent(**values)


@dataclass
class FakeFeeds:
    """``DisasterFeedService`` stand-in: returns ``events`` or raises the queued errors."""

    events: list[DisasterEvent] = field(default_factory=list)
    errors: list[BaseException] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def get_events(self, **kwargs: Any) -> list[DisasterEvent]:
        self.calls.append(kwargs)
        if self.errors:
            raise self.errors.pop(0)
        return list(self.events)


@dataclass
class NotifyCall:
    lat: float
    lon: float
    payload: dict[str, Any]
    topic: str


@dataclass
class FakePush:
    enabled: bool = True
    sent_per_call: int = 3
    calls: list[NotifyCall] = field(default_factory=list)
    notified: asyncio.Event = field(default_factory=asyncio.Event)

    async def notify_nearby(
        self, session: AsyncSession, lat: float, lon: float, payload: dict[str, Any], topic: str
    ) -> int:
        assert isinstance(session, AsyncSession)
        self.calls.append(NotifyCall(lat, lon, payload, topic))
        self.notified.set()
        return self.sent_per_call


@pytest.fixture
async def sessionmaker(settings: Settings) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_engine(settings)
    await init_db(engine)
    try:
        yield create_sessionmaker(engine)
    finally:
        await engine.dispose()


@pytest.fixture
def feeds() -> FakeFeeds:
    return FakeFeeds()


@pytest.fixture
def push() -> FakePush:
    return FakePush()


@pytest.fixture
def make_poller(
    feeds: FakeFeeds,
    push: FakePush,
    sessionmaker: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> Callable[..., AlertPoller]:
    def _make(**kwargs: Any) -> AlertPoller:
        kwargs.setdefault("clock", lambda: NOW)
        return AlertPoller(feeds, push, sessionmaker, settings, **kwargs)  # type: ignore[arg-type]

    return _make


async def notified_keys(sessionmaker: async_sessionmaker[AsyncSession]) -> set[str]:
    async with sessionmaker() as session:
        return set(await session.scalars(select(NotifiedEvent.event_id)))


# ----------------------------------------------------------------------------------------------
# Pure helpers
# ----------------------------------------------------------------------------------------------
def test_build_payload_red_event() -> None:
    payload = build_payload(make_event("EQ-1001", "red"))
    assert payload == {
        "title": "Red alert: Earthquake EQ-1001",
        "body": "M 6.8 earthquake near the coast — Magnitude 6.8M, Depth:10km",
        "url": "/alerts?event=EQ-1001",
        "tag": "gdacs-EQ-1001",
        "severity": "high",
    }


def test_build_payload_orange_event_without_description() -> None:
    event = make_event(
        "TC 9/1", "orange", description="", severity_text=None, event_type_label="Tropical Cyclone"
    )
    payload = build_payload(event)
    assert payload["title"].startswith("Orange alert: ")
    assert payload["body"] == "Tropical Cyclone in Indonesia"
    assert payload["severity"] == "medium"
    assert payload["url"] == "/alerts?event=TC%209%2F1"


def test_is_recent() -> None:
    assert is_recent(make_event(), NOW)
    assert is_recent(make_event(from_date=None, to_date=None), NOW)
    old = make_event(from_date=NOW - timedelta(days=60), to_date=NOW - timedelta(days=10))
    assert not is_recent(old, NOW)
    # Old event with a fresh episode (to_date) is active again.
    revived = make_event(from_date=NOW - timedelta(days=60), to_date=NOW - timedelta(hours=3))
    assert is_recent(revived, NOW)
    # Naive datetimes are treated as UTC.
    naive = make_event(from_date=datetime(2026, 11, 2, 10, 0), to_date=None)
    assert is_recent(naive, NOW)


def test_select_candidates_filters_sorts_and_dedupes() -> None:
    events = [
        make_event("EQ-1", "orange", from_date=NOW - timedelta(hours=1), to_date=None),
        make_event("EQ-2", "green"),
        make_event("EQ-3", "red", from_date=NOW - timedelta(hours=5), to_date=None),
        make_event("EQ-4", "red", is_current=False),
        make_event("EQ-5", "red", from_date=NOW - timedelta(days=30), to_date=None),
        make_event("EQ-6", "red", from_date=NOW - timedelta(hours=1), to_date=None),
        make_event("EQ-3", "red"),  # duplicate id
    ]
    assert [e.id for e in select_candidates(events, NOW)] == ["EQ-6", "EQ-3", "EQ-1"]


def test_notification_key() -> None:
    assert notification_key("EQ-1", "red") == "EQ-1:red"
    assert len(notification_key("X" * 300, "orange")) == 128


# ----------------------------------------------------------------------------------------------
# run_once
# ----------------------------------------------------------------------------------------------
async def test_run_once_pushes_new_orange_and_red_events(
    make_poller: Callable[..., AlertPoller],
    feeds: FakeFeeds,
    push: FakePush,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    feeds.events = [
        make_event("EQ-1", "orange", lat=10.0, lon=20.0),
        make_event("EQ-2", "red", lat=-6.2, lon=106.8),
        make_event("FL-3", "green"),
        make_event("TC-4", "red", is_current=False),
    ]
    poller = make_poller()

    assert await poller.run_once() == 2
    assert feeds.calls == [{"min_level": "orange", "limit": poller_module.FEED_FETCH_LIMIT}]
    assert [(c.payload["tag"], c.topic) for c in push.calls] == [
        ("gdacs-EQ-2", "disasters"),  # red first
        ("gdacs-EQ-1", "disasters"),
    ]
    assert (push.calls[0].lat, push.calls[0].lon) == (-6.2, 106.8)
    assert push.calls[0].payload["severity"] == "high"
    assert push.calls[1].payload["severity"] == "medium"
    assert await notified_keys(sessionmaker) == {"EQ-1:orange", "EQ-2:red"}
    assert poller.notified_total == 2
    assert poller.last_run_at == NOW

    # Same feed again: nothing new.
    push.calls.clear()
    assert await poller.run_once() == 0
    assert push.calls == []


async def test_escalation_is_pushed_again_but_deescalation_is_not(
    make_poller: Callable[..., AlertPoller],
    feeds: FakeFeeds,
    push: FakePush,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    poller = make_poller()
    feeds.events = [make_event("TC-7", "orange")]
    assert await poller.run_once() == 1

    feeds.events = [make_event("TC-7", "red")]
    assert await poller.run_once() == 1
    assert push.calls[-1].payload["title"].startswith("Red alert")

    feeds.events = [make_event("TC-7", "orange")]
    assert await poller.run_once() == 0
    assert await notified_keys(sessionmaker) == {"TC-7:orange", "TC-7:red"}


async def test_run_once_skips_everything_when_push_disabled(
    make_poller: Callable[..., AlertPoller], feeds: FakeFeeds, push: FakePush
) -> None:
    push.enabled = False
    feeds.events = [make_event()]
    assert await make_poller().run_once() == 0
    assert feeds.calls == []
    assert push.calls == []


async def test_run_once_caps_pushes_per_cycle(
    make_poller: Callable[..., AlertPoller], feeds: FakeFeeds, push: FakePush
) -> None:
    feeds.events = [make_event(f"EQ-{i}", "red") for i in range(MAX_EVENTS_PER_CYCLE + 5)]
    poller = make_poller()
    assert await poller.run_once() == MAX_EVENTS_PER_CYCLE
    assert await poller.run_once() == 5
    assert await poller.run_once() == 0
    assert len({c.payload["tag"] for c in push.calls}) == MAX_EVENTS_PER_CYCLE + 5


async def test_event_claimed_by_another_worker_is_skipped(
    make_poller: Callable[..., AlertPoller],
    feeds: FakeFeeds,
    push: FakePush,
    sessionmaker: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two workers race: the unique constraint lets exactly one of them push."""
    async with sessionmaker() as session:
        session.add(NotifiedEvent(source="gdacs", event_id="EQ-1:red"))
        await session.commit()

    async def stale_view(session: AsyncSession, events: list[DisasterEvent]) -> set[str]:
        return set()  # this worker read the table before the other one committed

    poller = make_poller()
    monkeypatch.setattr(poller, "_already_notified", stale_view)
    feeds.events = [make_event("EQ-1", "red"), make_event("EQ-2", "red")]
    assert await poller.run_once() == 1
    assert [c.payload["tag"] for c in push.calls] == ["gdacs-EQ-2"]


async def test_run_once_prunes_old_dedupe_rows(
    make_poller: Callable[..., AlertPoller],
    feeds: FakeFeeds,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    async with sessionmaker() as session:
        session.add_all(
            [
                NotifiedEvent(
                    source="gdacs", event_id="OLD-1:red", created_at=NOW - timedelta(days=120)
                ),
                NotifiedEvent(
                    source="gdacs", event_id="RECENT-1:red", created_at=NOW - timedelta(days=10)
                ),
            ]
        )
        await session.commit()

    feeds.events = [make_event("EQ-9", "orange")]
    await make_poller().run_once()
    assert await notified_keys(sessionmaker) == {"RECENT-1:red", "EQ-9:orange"}


async def test_run_once_propagates_feed_errors(
    make_poller: Callable[..., AlertPoller], feeds: FakeFeeds
) -> None:
    feeds.errors = [UpstreamError("GDACS unavailable")]
    with pytest.raises(UpstreamError):
        await make_poller().run_once()


# ----------------------------------------------------------------------------------------------
# Background loop
# ----------------------------------------------------------------------------------------------
async def test_loop_survives_errors_and_stops_cleanly(
    make_poller: Callable[..., AlertPoller],
    feeds: FakeFeeds,
    push: FakePush,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    feeds.errors = [UpstreamError("GDACS unavailable"), RuntimeError("unexpected")]
    feeds.events = [make_event("EQ-1", "red")]
    poller = make_poller(interval_seconds=0.01, initial_delay_seconds=0)

    # Signal once a whole cycle (not just the push inside it) has completed.
    cycle_pushed = asyncio.Event()
    real_run_once = poller.run_once

    async def tracked_run_once() -> int:
        pushed = await real_run_once()
        if pushed:
            cycle_pushed.set()
        return pushed

    monkeypatch.setattr(poller, "run_once", tracked_run_once)

    poller.start()
    poller.start()  # idempotent
    assert poller.running
    await asyncio.wait_for(cycle_pushed.wait(), timeout=5)
    assert push.notified.is_set()
    task = poller._task
    await poller.stop()

    assert not poller.running
    assert task is not None and task.done()
    assert len(feeds.calls) >= 3  # two failed cycles, then a successful one
    assert poller.cycles >= 2
    assert poller.notified_total == 1
    assert poller.last_error is None

    await poller.stop()  # idempotent


async def test_stop_before_start_is_noop(make_poller: Callable[..., AlertPoller]) -> None:
    poller = make_poller()
    await poller.stop()
    assert not poller.running


async def test_stop_cancels_during_initial_delay(
    make_poller: Callable[..., AlertPoller], feeds: FakeFeeds
) -> None:
    poller = make_poller(initial_delay_seconds=3600)
    poller.start()
    await asyncio.sleep(0)
    await asyncio.wait_for(poller.stop(), timeout=2)
    assert feeds.calls == []


def test_interval_defaults_to_settings(
    settings_factory: Callable[..., Settings], sessionmaker: Any
) -> None:
    settings = settings_factory(alert_poll_interval_seconds=120)
    poller = AlertPoller(FakeFeeds(), FakePush(), sessionmaker, settings)  # type: ignore[arg-type]
    assert poller.interval_seconds == 120.0
    assert poller.initial_delay_seconds == poller_module.STARTUP_DELAY_SECONDS


def test_lifespan_starts_and_stops_poller(settings_factory: Callable[..., Settings]) -> None:
    app = create_app(settings_factory(alert_poller_enabled=True))
    with TestClient(app) as client:
        poller = client.app.state.alert_poller  # type: ignore[attr-defined]
        assert isinstance(poller, AlertPoller)
        assert poller.running
    assert not poller.running


def test_lifespan_without_poller(client: TestClient) -> None:
    assert client.app.state.alert_poller is None  # type: ignore[attr-defined]


# ----------------------------------------------------------------------------------------------
# End-to-end with the real PushService (pywebpush faked)
# ----------------------------------------------------------------------------------------------
async def test_poller_with_real_push_service(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    feeds: FakeFeeds,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deliveries: list[dict[str, Any]] = []

    def fake_webpush(**kwargs: Any) -> Any:
        deliveries.append(kwargs)
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(push_module, "webpush", fake_webpush)

    def sub(name: str, lat: float | None, lon: float | None, topics: str) -> PushSubscription:
        return PushSubscription(
            endpoint=f"https://fcm.googleapis.com/fcm/send/{name}",
            p256dh="k",
            auth="a",
            lat=lat,
            lon=lon,
            radius_km=100,
            topics=topics,
        )

    async with sessionmaker() as session:
        session.add_all(
            [
                sub("jakarta", -6.3, 106.9, "disasters"),
                sub("jakarta-incidents-only", -6.3, 106.9, "incidents"),
                sub("tokyo", 35.68, 139.69, "incidents,disasters"),
                sub("no-location", None, None, "disasters"),
            ]
        )
        await session.commit()

    feeds.events = [
        make_event("EQ-1", "red", lat=-6.2, lon=106.8),
        make_event("FL-2", "orange", lat=-6.25, lon=106.85),
    ]
    poller = AlertPoller(feeds, PushService(settings), sessionmaker, settings, clock=lambda: NOW)
    assert await poller.run_once() == 2

    by_tag: dict[str, set[str]] = {}
    for delivery in deliveries:
        tag = json.loads(delivery["data"])["tag"]
        by_tag.setdefault(tag, set()).add(delivery["subscription_info"]["endpoint"])
    assert by_tag == {
        # Red: nearby subscriber + subscriber without a location.
        "gdacs-EQ-1": {
            "https://fcm.googleapis.com/fcm/send/jakarta",
            "https://fcm.googleapis.com/fcm/send/no-location",
        },
        # Orange: nearby subscribers only.
        "gdacs-FL-2": {"https://fcm.googleapis.com/fcm/send/jakarta"},
    }


async def test_poller_holds_no_database_connection_while_pushing(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    feeds: FakeFeeds,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: one session spanned the whole cycle, pinning a pooled connection while
    every (possibly slow) push service answered."""
    engine = sessionmaker.kw["bind"]
    checked_out: list[int] = []

    def fake_webpush(**kwargs: Any) -> Any:
        checked_out.append(engine.pool.checkedout())
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(push_module, "webpush", fake_webpush)
    async with sessionmaker() as session:
        session.add(
            PushSubscription(
                endpoint="https://fcm.googleapis.com/fcm/send/jakarta",
                p256dh="k",
                auth="a",
                lat=-6.3,
                lon=106.9,
                radius_km=100,
                topics="disasters",
            )
        )
        await session.commit()

    feeds.events = [
        make_event("EQ-1", "red", lat=-6.2, lon=106.8),
        make_event("FL-2", "orange", lat=-6.25, lon=106.85),
    ]
    push = PushService(settings)
    try:
        poller = AlertPoller(feeds, push, sessionmaker, settings, clock=lambda: NOW)
        assert await poller.run_once() == 2
    finally:
        push.close()
    assert checked_out == [0, 0]
