"""Background GDACS poller pushing Orange/Red alerts to nearby subscribers.

Started from the app lifespan when ``ALERT_POLLER_ENABLED`` is true. Every
``ALERT_POLL_INTERVAL_SECONDS`` it:

1. fetches current GDACS events with alert level Orange or Red
   (:meth:`DisasterFeedService.get_events`),
2. skips events already notified at the same or a higher level (:class:`NotifiedEvent`,
   one row per ``"<event id>:<level>"`` — an Orange event that escalates to Red is pushed
   again, a de-escalation is not) and stale events whose last activity is older than
   :data:`MAX_EVENT_AGE`,
3. *claims* each new event by inserting its ``NotifiedEvent`` row first (the unique
   constraint makes this safe when several workers run a poller), then
4. calls :meth:`PushService.notify_nearby` with topic ``"disasters"`` (each subscriber's own
   radius applies; subscribers without a location only receive Red alerts).

At most :data:`MAX_EVENTS_PER_CYCLE` events are pushed per cycle (most severe first), so a
cold start never floods devices; the rest follow in later cycles. Every cycle catches all
exceptions (an outage of GDACS or the database only costs one cycle) and the task cancels
cleanly on shutdown.

Database connections are only held for short transactions: the bookkeeping (prune, dedupe
lookup, claim) and each fan-out use their own short-lived session, and
:meth:`PushService.notify_nearby` releases its connection before contacting push services,
so a slow fan-out never pins a pooled connection for the whole cycle.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import quote

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.errors import AppError
from app.db.models import NotifiedEvent, utcnow
from app.schemas.alerts import ALERT_LEVEL_RANK, DisasterEvent

logger = logging.getLogger(__name__)

#: ``NotifiedEvent.source`` for GDACS events.
SOURCE = "gdacs"
#: Push topic used for disaster alerts.
TOPIC = "disasters"
#: Alert levels that trigger a push.
NOTIFY_LEVELS = ("orange", "red")
#: Events whose most recent date is older than this are not pushed (old droughts etc.).
MAX_EVENT_AGE = timedelta(days=3)
#: Upper bound of fan-outs per cycle (the rest is handled in the next cycles).
MAX_EVENTS_PER_CYCLE = 20
#: How many events to request from the feed service per cycle.
FEED_FETCH_LIMIT = 200
#: ``NotifiedEvent`` rows older than this are deleted (much longer than ``MAX_EVENT_AGE``).
NOTIFIED_RETENTION = timedelta(days=90)
#: Delay before the first poll so startup is never slowed down by upstream calls.
STARTUP_DELAY_SECONDS = 15.0

_SEVERITY_BY_LEVEL = {"red": "high", "orange": "medium"}


class EventsSource(Protocol):
    """The part of :class:`~app.services.disaster_feed.DisasterFeedService` the poller uses."""

    async def get_events(
        self,
        lat: float | None = None,
        lon: float | None = None,
        radius_km: float | None = None,
        types: Any = None,
        min_level: Any = "green",
        limit: int = 50,
    ) -> list[DisasterEvent]: ...


class Notifier(Protocol):
    """The part of :class:`~app.services.push.PushService` the poller uses."""

    @property
    def enabled(self) -> bool: ...

    async def notify_nearby(
        self,
        session: AsyncSession,
        lat: float,
        lon: float,
        payload: dict[str, Any],
        topic: str,
    ) -> int: ...


# ----------------------------------------------------------------------------------------------
# pure helpers
# ----------------------------------------------------------------------------------------------
def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def notification_key(event_id: str, level: str) -> str:
    """``NotifiedEvent.event_id`` value: one row per event *and* alert level."""
    return f"{event_id}:{level}"[:128]


def is_recent(event: DisasterEvent, now: datetime, max_age: timedelta = MAX_EVENT_AGE) -> bool:
    """``True`` when the event's latest date is within ``max_age`` (or unknown)."""
    dates = [d for d in (_aware(event.from_date), _aware(event.to_date)) if d is not None]
    if not dates:
        return True
    return now - max(dates) <= max_age


def build_payload(event: DisasterEvent) -> dict[str, Any]:
    """Push payload (``PushPayload`` shape) for a GDACS event."""
    level = event.alert_level
    title = f"{level.capitalize()} alert: {event.title}"
    body = " ".join((event.description or "").split())
    if not body:
        body = event.event_type_label + (f" in {event.country}" if event.country else "")
    if event.severity_text and event.severity_text not in body:
        body = f"{body} — {event.severity_text}"
    return {
        "title": title,
        "body": body,
        "url": f"/alerts?event={quote(event.id, safe='')}",
        "tag": f"gdacs-{event.id}",
        "severity": _SEVERITY_BY_LEVEL.get(level, "medium"),
    }


def select_candidates(events: Iterable[DisasterEvent], now: datetime) -> list[DisasterEvent]:
    """Current, recent Orange/Red events, most severe (then most recent) first, unique ids."""
    seen: set[str] = set()
    picked: list[DisasterEvent] = []
    for event in events:
        if event.id in seen or event.alert_level not in NOTIFY_LEVELS:
            continue
        if not event.is_current or not is_recent(event, now):
            continue
        seen.add(event.id)
        picked.append(event)

    epoch = datetime.min.replace(tzinfo=UTC)

    def sort_key(event: DisasterEvent) -> tuple[int, datetime]:
        latest = max(
            (d for d in (_aware(event.from_date), _aware(event.to_date)) if d), default=epoch
        )
        return ALERT_LEVEL_RANK[event.alert_level], latest

    picked.sort(key=sort_key, reverse=True)
    return picked


# ----------------------------------------------------------------------------------------------
# poller
# ----------------------------------------------------------------------------------------------
class AlertPoller:
    """Runs every ``alert_poll_interval_seconds`` while the app is up.

    Args:
        feeds: Disaster feed service (``get_events``).
        push: Push service (``enabled``, ``notify_nearby``).
        sessionmaker: Session factory; each cycle uses its own session.
        settings: Application settings.
        interval_seconds: Override of ``settings.alert_poll_interval_seconds`` (tests).
        initial_delay_seconds: Wait before the first poll.
        clock: Returns "now" as an aware UTC datetime (tests).
    """

    def __init__(
        self,
        feeds: EventsSource,
        push: Notifier,
        sessionmaker: async_sessionmaker[AsyncSession],
        settings: Settings,
        *,
        interval_seconds: float | None = None,
        initial_delay_seconds: float = STARTUP_DELAY_SECONDS,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.feeds = feeds
        self.push = push
        self.sessionmaker = sessionmaker
        self.settings = settings
        self.interval_seconds = float(
            interval_seconds
            if interval_seconds is not None
            else settings.alert_poll_interval_seconds
        )
        self.initial_delay_seconds = max(0.0, initial_delay_seconds)
        self._clock = clock
        self._task: asyncio.Task[None] | None = None
        #: Observability: completed cycles, events pushed in total, last error (if any).
        self.cycles = 0
        self.notified_total = 0
        self.last_run_at: datetime | None = None
        self.last_error: str | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------------------------------
    def start(self) -> None:
        """Start the background task (must be called from the running event loop).

        Calling it again while running is a no-op.
        """
        if self.running:
            return
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._loop(), name="resq-alert-poller")
        self._task.add_done_callback(self._on_done)

    async def stop(self) -> None:
        """Cancel the background task and wait for it to finish (idempotent)."""
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise  # stop() itself was cancelled: propagate
        logger.info("Alert poller stopped")

    @staticmethod
    def _on_done(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:  # pragma: no cover - _loop catches everything but cancellation
            logger.error("Alert poller crashed", exc_info=exc)

    async def _loop(self) -> None:
        if self.initial_delay_seconds:
            await asyncio.sleep(self.initial_delay_seconds)
        while True:
            try:
                await self.run_once()
                self.last_error = None
            except AppError as exc:  # e.g. UpstreamError: GDACS unavailable
                self.last_error = exc.message
                logger.warning("Alert poll failed: %s", exc.message)
            except Exception as exc:
                self.last_error = type(exc).__name__
                logger.exception("Alert poll failed unexpectedly")
            self.cycles += 1
            await asyncio.sleep(self.interval_seconds)

    # ------------------------------------------------------------------------------------------
    # one cycle
    # ------------------------------------------------------------------------------------------
    async def run_once(self) -> int:
        """Poll once and push new Orange/Red events; returns how many events were pushed.

        Raises whatever the feed or database raises (the loop logs it); push delivery
        problems never raise.
        """
        now = self._clock()
        self.last_run_at = now
        if not getattr(self.push, "enabled", True):
            logger.debug("Alert poll skipped: web push is disabled")
            return 0

        events = await self.feeds.get_events(min_level="orange", limit=FEED_FETCH_LIMIT)
        candidates = select_candidates(events, now)
        if not candidates:
            logger.debug("Alert poll: no current Orange/Red events")
            return 0

        async with self.sessionmaker() as session:
            await self._prune(session, now)
            notified = await self._already_notified(session, candidates)

        pushed = 0
        for event in candidates:
            if pushed >= MAX_EVENTS_PER_CYCLE:
                logger.info("Alert poll: per-cycle cap reached, remaining events deferred")
                break
            if self._covered(event, notified):
                continue
            async with self.sessionmaker() as session:
                if not await self._claim(session, event):
                    continue
            # A separate session per fan-out; notify_nearby ends its transaction before
            # delivering, so no connection is held while push services answer.
            async with self.sessionmaker() as session:
                sent = await self.push.notify_nearby(
                    session, event.lat, event.lon, build_payload(event), topic=TOPIC
                )
            pushed += 1
            logger.info(
                "Pushed %s alert %s (%s) to %d subscriber(s)",
                event.alert_level,
                event.id,
                event.event_type,
                sent,
            )
        self.notified_total += pushed
        return pushed

    @staticmethod
    def _covered(event: DisasterEvent, notified: set[str]) -> bool:
        """Already pushed at this level or a higher one?"""
        rank = ALERT_LEVEL_RANK[event.alert_level]
        return any(
            notification_key(event.id, level) in notified
            for level in NOTIFY_LEVELS
            if ALERT_LEVEL_RANK[level] >= rank
        )

    @staticmethod
    async def _already_notified(session: AsyncSession, events: list[DisasterEvent]) -> set[str]:
        keys = [notification_key(e.id, level) for e in events for level in NOTIFY_LEVELS]
        rows = await session.scalars(
            select(NotifiedEvent.event_id).where(
                NotifiedEvent.source == SOURCE, NotifiedEvent.event_id.in_(keys)
            )
        )
        return set(rows)

    @staticmethod
    async def _claim(session: AsyncSession, event: DisasterEvent) -> bool:
        """Insert the dedupe row; ``False`` when another worker claimed the event first."""
        session.add(
            NotifiedEvent(source=SOURCE, event_id=notification_key(event.id, event.alert_level))
        )
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            logger.debug("Alert %s already claimed by another worker", event.id)
            return False
        return True

    @staticmethod
    async def _prune(session: AsyncSession, now: datetime) -> None:
        """Forget dedupe rows far older than any event that could still be pushed."""
        result = await session.execute(
            delete(NotifiedEvent).where(NotifiedEvent.created_at < now - NOTIFIED_RETENTION)
        )
        await session.commit()
        removed = getattr(result, "rowcount", 0) or 0
        if removed:
            logger.info("Pruned %d old notified-event record(s)", removed)


__all__ = [
    "MAX_EVENTS_PER_CYCLE",
    "MAX_EVENT_AGE",
    "AlertPoller",
    "build_payload",
    "is_recent",
    "notification_key",
    "select_candidates",
]
