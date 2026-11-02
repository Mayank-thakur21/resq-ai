"""Web Push notifications (pywebpush + VAPID).

* :meth:`PushService.send` delivers one payload to one stored subscription.
* :meth:`PushService.notify_nearby` fans a payload out to every subscription of a topic whose
  radius covers a point (used by incident reports and the GDACS alert poller).
* :meth:`PushService.notify_user` targets one user's subscriptions (``POST /api/push/test``).

Delivery
--------
pywebpush is synchronous (``requests``), so deliveries run on a **dedicated** thread pool of
:data:`MAX_CONCURRENT_DELIVERIES` workers (never the event loop's default executor, which
SOS SMS used to share and starve on). Each worker thread has its own ``requests`` session
that **never follows redirects** and refuses hosts that are not browser push services, so a
stored endpoint cannot be bounced to internal addresses (SSRF). Endpoints are also
allow-listed when subscribing (:func:`app.schemas.push.validate_push_endpoint`).

Database connections
--------------------
A fan-out can take long (slow push services, many subscribers). It must never hold a pooled
database connection meanwhile, or a few concurrent fan-outs would exhaust the pool and make
every DB-backed endpoint (SOS audit, login, incidents) time out. Therefore every public
method (1) loads the subscriptions and copies what delivery needs into detached
:class:`_Target` objects, (2) **ends the session's transaction** (``commit()``, which returns
the connection to the pool), (3) delivers without touching the database, and (4) records the
outcomes in a new short transaction.

Housekeeping & limits
---------------------
* Subscriptions reported gone (HTTP 404/410) are deleted; other failures increment
  ``failure_count`` and the row is deleted after :data:`MAX_CONSECUTIVE_FAILURES` in a row
  (a success resets the counter).
* One fan-out notifies at most :data:`MAX_FANOUT_SUBSCRIPTIONS` subscriptions and gives up
  after :data:`MAX_FANOUT_SECONDS` (remaining deliveries are skipped and logged).
* ``notify_nearby(per_subscription_limit=...)`` throttles how often one device may be
  notified (used for community incident reports).

Endpoints are capability URLs, so logs only ever show their host.

Payload shape (read by ``public/sw.js``): ``{"title", "body", "url", "tag", "severity"}``;
see :class:`app.schemas.push.PushPayload`. Over-long titles/bodies are truncated rather than
rejected so a long incident description never suppresses a notification.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from enum import Enum
from typing import Any
from urllib.parse import urlsplit

import requests
from py_vapid import Vapid
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.rate_limit import RateLimiter
from app.core.rate_limit import limiter as default_limiter
from app.db.models import PushSubscription
from app.schemas.push import validate_push_endpoint
from app.services.geo import bounding_box, haversine_km

logger = logging.getLogger(__name__)

#: Seconds the push service keeps an undelivered message (device offline).
PUSH_TTL_SECONDS = 3600
#: Parallel deliveries during a fan-out.
MAX_CONCURRENT_DELIVERIES = 10
#: Largest radius a subscription may have (``PushSubscribeRequest.radius_km`` <= 500).
MAX_SUBSCRIPTION_RADIUS_KM = 500.0
#: Upper bound for a single delivery request.
MAX_PUSH_TIMEOUT_SECONDS = 10.0
#: Push-service statuses meaning "this subscription no longer exists".
GONE_STATUSES = frozenset({404, 410})
#: Failed deliveries in a row (other than 404/410) after which a subscription is deleted.
MAX_CONSECUTIVE_FAILURES = 5
#: Most subscriptions notified by one fan-out (most recently updated first).
MAX_FANOUT_SUBSCRIPTIONS = 2000
#: Candidate rows loaded by the bounding-box query before the exact radius check.
MAX_FANOUT_CANDIDATES = 10_000
#: Wall-clock budget of one fan-out; deliveries not started by then are skipped.
MAX_FANOUT_SECONDS = 60.0

_TITLE_MAX = 120
_BODY_MAX = 400
_SEVERITIES = frozenset({"low", "medium", "high"})


class DeliveryStatus(Enum):
    """Outcome of one delivery attempt."""

    SENT = "sent"
    GONE = "gone"  # 404/410 or an endpoint that is not a push service: delete it
    FAILED = "failed"  # anything else: count the failure, retry next time
    SKIPPED = "skipped"  # not attempted (fan-out deadline reached)


@dataclass(frozen=True, slots=True)
class _Target:
    """Detached copy of what delivery needs (no ORM object outlives the transaction)."""

    id: str
    info: dict[str, Any]
    host: str
    failure_count: int = 0


class PushHTTPSession(requests.Session):
    """``requests`` session for push deliveries: no redirects, push-service hosts only.

    pywebpush calls ``session.post(endpoint, ...)``; a push service never legitimately
    redirects, and following one would let an endpoint bounce the request to internal
    addresses. Hosts are re-checked here as defence in depth for rows stored before
    endpoint validation existed.
    """

    def __init__(self) -> None:
        super().__init__()
        self.max_redirects = 0

    def request(self, method: str | bytes, url: str | bytes, *args: Any, **kwargs: Any) -> Any:
        target = url.decode("utf-8") if isinstance(url, bytes) else str(url)
        validate_push_endpoint(target)  # ValueError -> delivery fails, endpoint never hit
        kwargs["allow_redirects"] = False
        return super().request(method, url, *args, **kwargs)


def _endpoint_host(endpoint: str) -> str:
    try:
        return urlsplit(endpoint).hostname or "?"
    except ValueError:
        return "?"


def _is_push_service(endpoint: str) -> bool:
    try:
        validate_push_endpoint(endpoint)
    except ValueError:
        return False
    return True


def _to_targets(subs: Iterable[PushSubscription]) -> list[_Target]:
    """Copy rows into detached targets (call before the transaction ends)."""
    return [
        _Target(
            id=sub.id,
            info=sub.subscription_info(),
            host=_endpoint_host(sub.endpoint),
            failure_count=int(sub.failure_count or 0),
        )
        for sub in subs
    ]


async def _end_transaction(session: AsyncSession) -> None:
    """Commit so the pooled connection is released before slow network I/O.

    ``commit()`` rather than ``rollback()`` so pending work of the caller (if any) is kept;
    for the read-only queries done here both are equivalent.
    """
    if session.in_transaction():
        await session.commit()


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def normalise_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Fill defaults and enforce the size limits of :class:`~app.schemas.push.PushPayload`.

    Unknown keys are kept (the service worker ignores what it does not know).
    """
    data = dict(payload)
    data["title"] = _truncate(str(data.get("title") or "ResQ AI"), _TITLE_MAX)
    data["body"] = _truncate(str(data.get("body") or ""), _BODY_MAX)
    url = str(data.get("url") or "/")
    # Only same-origin paths: the service worker opens this URL on click.
    data["url"] = url if url.startswith("/") and not url.startswith("//") else "/"
    data["tag"] = str(data.get("tag") or "resq")
    severity = str(data.get("severity") or "medium")
    data["severity"] = severity if severity in _SEVERITIES else "medium"
    return data


def _load_vapid_key(private_key: str) -> Vapid | None:
    """Parse the VAPID private key once (raw base64url or DER/PEM-less base64)."""
    try:
        return Vapid.from_string(private_key=private_key)
    except Exception as exc:  # malformed key: disable push rather than fail every send
        # Only the type: parser messages could echo fragments of the key.
        logger.error(
            "VAPID_PRIVATE_KEY could not be parsed (%s); web push disabled", type(exc).__name__
        )
        return None


Sender = Callable[..., Any]


class PushService:
    """Sends notifications to stored browser subscriptions.

    Args:
        settings: Application settings (``VAPID_*``).
        sender: Replacement for :func:`pywebpush.webpush` (tests). Defaults to the module's
            ``webpush`` looked up at call time, so ``monkeypatch.setattr(push, "webpush", ...)``
            works as well.
        limiter: Rate limiter for per-subscription throttles (defaults to the process-wide
            one, which tests reset between cases).
        fanout_seconds: Wall-clock budget of one fan-out (tests shorten it).
    """

    def __init__(
        self,
        settings: Settings,
        *,
        sender: Sender | None = None,
        limiter: RateLimiter | None = None,
        fanout_seconds: float = MAX_FANOUT_SECONDS,
    ) -> None:
        self.settings = settings
        self._sender = sender
        self._vapid: Vapid | None = (
            _load_vapid_key(settings.vapid_private_key) if settings.push_enabled else None
        )
        self._timeout = min(settings.http_timeout_seconds, MAX_PUSH_TIMEOUT_SECONDS)
        self.limiter = limiter or default_limiter
        self.fanout_seconds = fanout_seconds
        self._local = threading.local()
        self._executor: ThreadPoolExecutor | None = None
        self._executor_lock = threading.Lock()

    # ------------------------------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        """Both VAPID keys are set and the private key is usable."""
        return self._vapid is not None

    @property
    def public_key(self) -> str | None:
        """VAPID application server key for ``pushManager.subscribe`` (None when disabled)."""
        return self.settings.vapid_public_key if self.enabled else None

    # ------------------------------------------------------------------------------------------
    # resources
    # ------------------------------------------------------------------------------------------
    def _get_executor(self) -> ThreadPoolExecutor:
        """Dedicated delivery pool (lazily created); size == :data:`MAX_CONCURRENT_DELIVERIES`."""
        with self._executor_lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=MAX_CONCURRENT_DELIVERIES, thread_name_prefix="resq-push"
                )
            return self._executor

    def _thread_session(self) -> PushHTTPSession:
        """The calling worker thread's own HTTP session (``requests`` is not thread-safe)."""
        session: PushHTTPSession | None = getattr(self._local, "session", None)
        if session is None:
            session = PushHTTPSession()
            self._local.session = session
        return session

    def close(self) -> None:
        """Release the worker threads (app shutdown); queued deliveries are cancelled."""
        with self._executor_lock:
            executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------------------------------
    # delivery (worker thread)
    # ------------------------------------------------------------------------------------------
    def _deliver_sync(self, target: _Target, data: str) -> DeliveryStatus:
        """Blocking delivery of one message; never raises."""
        if not _is_push_service(str(target.info.get("endpoint", ""))):
            logger.warning(
                "Push subscription %s points to %s, which is not a push service; removing it",
                target.id,
                target.host,
            )
            return DeliveryStatus.GONE
        sender = self._sender or webpush
        try:
            sender(
                subscription_info=target.info,
                data=data,
                vapid_private_key=self._vapid,
                # webpush() mutates the claims (aud/exp): always pass a fresh dict.
                vapid_claims={"sub": self.settings.vapid_subject},
                ttl=PUSH_TTL_SECONDS,
                timeout=self._timeout,
                requests_session=self._thread_session(),
            )
        except WebPushException as exc:
            status = exc.status_code
            if status in GONE_STATUSES:
                logger.info("Push subscription %s expired (HTTP %s)", target.id, status)
                return DeliveryStatus.GONE
            logger.warning(
                "Push to %s (subscription %s) failed: HTTP %s",
                target.host,
                target.id,
                status if status is not None else "n/a",
            )
            return DeliveryStatus.FAILED
        except Exception as exc:  # network errors, malformed keys ...
            logger.warning(
                "Push to %s (subscription %s) failed: %s",
                target.host,
                target.id,
                type(exc).__name__,
            )
            return DeliveryStatus.FAILED
        return DeliveryStatus.SENT

    async def _deliver_many(
        self, targets: list[_Target], payload: Mapping[str, Any]
    ) -> list[tuple[_Target, DeliveryStatus]]:
        """Deliver to every target (no database access); bounded by ``fanout_seconds``."""
        if not targets:
            return []
        data = json.dumps(normalise_payload(payload), ensure_ascii=False)
        loop = asyncio.get_running_loop()
        executor = self._get_executor()
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_DELIVERIES)

        async def _one(target: _Target) -> DeliveryStatus:
            async with semaphore:
                return await loop.run_in_executor(executor, self._deliver_sync, target, data)

        tasks = [asyncio.ensure_future(_one(target)) for target in targets]
        done, pending = await asyncio.wait(tasks, timeout=self.fanout_seconds)
        for task in pending:
            task.cancel()
        if pending:
            # Already-running worker threads finish on their own (bounded by the timeout).
            await asyncio.gather(*pending, return_exceptions=True)
            logger.warning(
                "Push fan-out stopped after %.0fs: %d of %d deliveries skipped",
                self.fanout_seconds,
                len(pending),
                len(targets),
            )
        outcomes: list[tuple[_Target, DeliveryStatus]] = []
        for target, task in zip(targets, tasks, strict=True):
            if task in done and not task.cancelled() and task.exception() is None:
                outcomes.append((target, task.result()))
            else:
                outcomes.append((target, DeliveryStatus.SKIPPED))
        return outcomes

    async def _record_outcomes(
        self, session: AsyncSession, outcomes: list[tuple[_Target, DeliveryStatus]]
    ) -> None:
        """Delete gone/hopeless subscriptions and track failures — one short transaction."""
        gone = [t.id for t, status in outcomes if status is DeliveryStatus.GONE]
        failed = [t for t, status in outcomes if status is DeliveryStatus.FAILED]
        hopeless = [t.id for t in failed if t.failure_count + 1 >= MAX_CONSECUTIVE_FAILURES]
        retry = [t.id for t in failed if t.failure_count + 1 < MAX_CONSECUTIVE_FAILURES]
        recovered = [
            t.id for t, status in outcomes if status is DeliveryStatus.SENT and t.failure_count
        ]
        if not (gone or hopeless or retry or recovered):
            return
        try:
            if gone or hopeless:
                await session.execute(
                    delete(PushSubscription).where(PushSubscription.id.in_(gone + hopeless))
                )
            if retry:
                await session.execute(
                    update(PushSubscription)
                    .where(PushSubscription.id.in_(retry))
                    .values(failure_count=PushSubscription.failure_count + 1)
                )
            if recovered:
                await session.execute(
                    update(PushSubscription)
                    .where(PushSubscription.id.in_(recovered))
                    .values(failure_count=0)
                )
            await session.commit()
        except Exception:
            logger.exception("Could not record push delivery outcomes")
            await session.rollback()
            return
        if gone:
            logger.info("Deleted %d expired push subscription(s)", len(gone))
        if hopeless:
            logger.info(
                "Deleted %d push subscription(s) after %d failed deliveries in a row",
                len(hopeless),
                MAX_CONSECUTIVE_FAILURES,
            )

    async def _fan_out(
        self, session: AsyncSession, targets: list[_Target], payload: Mapping[str, Any]
    ) -> int:
        """Release the connection, deliver, then record outcomes; returns the sent count."""
        await _end_transaction(session)
        if not targets:
            return 0
        outcomes = await self._deliver_many(targets, payload)
        await self._record_outcomes(session, outcomes)
        return sum(1 for _, status in outcomes if status is DeliveryStatus.SENT)

    def _throttle(self, targets: list[_Target], limit: str | None) -> list[_Target]:
        """Drop targets notified ``limit`` times recently (in-process, per subscription)."""
        if not limit or not self.limiter.enabled:
            return targets
        allowed = [t for t in targets if self.limiter.hit(limit, "push-sub", t.id).allowed]
        if len(allowed) < len(targets):
            logger.info(
                "Push throttle (%s): %d of %d subscription(s) skipped",
                limit,
                len(targets) - len(allowed),
                len(targets),
            )
        return allowed

    # ------------------------------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------------------------------
    async def send(
        self, session: AsyncSession, sub: PushSubscription, payload: dict[str, Any]
    ) -> bool:
        """Deliver ``payload`` to one subscription; ``True`` on success.

        A subscription reported gone (404/410) is deleted and the session committed. Other
        failures are logged and return ``False``. Never raises.
        """
        if not self.enabled:
            logger.debug("Push disabled; not sending to subscription %s", sub.id)
            return False
        return await self._fan_out(session, _to_targets([sub]), payload) == 1

    async def notify_user(
        self, session: AsyncSession, user_id: str, payload: dict[str, Any]
    ) -> int:
        """Send ``payload`` to every subscription linked to ``user_id``; returns sent count."""
        if not self.enabled:
            logger.debug("Push disabled; notify_user skipped")
            return 0
        subs = await session.scalars(
            select(PushSubscription)
            .where(PushSubscription.user_id == user_id)
            .order_by(PushSubscription.updated_at.desc())
            .limit(MAX_FANOUT_SUBSCRIPTIONS)
        )
        return await self._fan_out(session, _to_targets(subs), payload)

    async def find_nearby(
        self,
        session: AsyncSession,
        lat: float,
        lon: float,
        topic: str,
        *,
        include_unlocated: bool = False,
        exclude_user_id: str | None = None,
    ) -> list[PushSubscription]:
        """Subscriptions of ``topic`` whose own ``radius_km`` covers (lat, lon).

        SQL pre-filters with the bounding box of the largest allowed radius; the exact
        per-subscription radius check uses the haversine distance. Subscriptions without a
        location are included only when ``include_unlocated`` is set.
        """
        box = bounding_box(lat, lon, MAX_SUBSCRIPTION_RADIUS_KM)
        in_box = (
            PushSubscription.lat.is_not(None)
            & PushSubscription.lon.is_not(None)
            & PushSubscription.lat.between(box.min_lat, box.max_lat)
            & PushSubscription.lon.between(box.min_lon, box.max_lon)
        )
        location_filter = (
            or_(in_box, PushSubscription.lat.is_(None) | PushSubscription.lon.is_(None))
            if include_unlocated
            else in_box
        )
        query = select(PushSubscription).where(
            location_filter, PushSubscription.topics.contains(topic)
        )
        if exclude_user_id is not None:
            query = query.where(
                PushSubscription.user_id.is_(None) | (PushSubscription.user_id != exclude_user_id)
            )
        query = query.order_by(PushSubscription.updated_at.desc()).limit(MAX_FANOUT_CANDIDATES)

        matches: list[PushSubscription] = []
        for sub in await session.scalars(query):
            if topic not in sub.topic_list:  # LIKE pre-filter may over-match
                continue
            if not sub.has_location:
                matches.append(sub)  # only selected when include_unlocated
            else:
                assert sub.lat is not None and sub.lon is not None
                if haversine_km(lat, lon, sub.lat, sub.lon) <= sub.radius_km:
                    matches.append(sub)
            if len(matches) >= MAX_FANOUT_SUBSCRIPTIONS:
                logger.warning(
                    "Push fan-out (%s) capped at %d subscriptions", topic, MAX_FANOUT_SUBSCRIPTIONS
                )
                break
        return matches

    async def notify_nearby(
        self,
        session: AsyncSession,
        lat: float,
        lon: float,
        payload: dict[str, Any],
        topic: str,
        *,
        include_unlocated: bool | None = None,
        exclude_user_id: str | None = None,
        per_subscription_limit: str | None = None,
    ) -> int:
        """Notify subscriptions of ``topic`` whose radius covers (lat, lon); returns sent count.

        Subscriptions without a location only receive red disaster alerts: by default they are
        included when ``topic == "disasters"`` and ``payload["severity"] == "high"``
        (override with ``include_unlocated``). ``exclude_user_id`` skips one user's devices
        (e.g. the reporter of an incident). ``per_subscription_limit`` (``limits`` syntax,
        e.g. ``"1/10minutes"``) skips devices that were already notified that often.

        The session's transaction is ended before delivery starts (see the module docs), so
        the caller's connection is not held while push services answer. Never raises;
        returns 0 when push is disabled.
        """
        if not self.enabled:
            logger.debug("Push disabled; notify_nearby(%s) skipped", topic)
            return 0
        if include_unlocated is None:
            include_unlocated = topic == "disasters" and payload.get("severity") == "high"
        try:
            subs = await self.find_nearby(
                session,
                lat,
                lon,
                topic,
                include_unlocated=include_unlocated,
                exclude_user_id=exclude_user_id,
            )
            targets = self._throttle(_to_targets(subs), per_subscription_limit)
            sent = await self._fan_out(session, targets, payload)
        except Exception:
            logger.exception("Push fan-out for topic %s failed", topic)
            try:
                await session.rollback()
            except Exception:  # pragma: no cover - connection already broken
                logger.debug("Rollback after failed fan-out failed", exc_info=True)
            return 0
        logger.info(
            "Push fan-out (%s, tag=%s): %d of %d subscription(s) notified",
            topic,
            payload.get("tag", "-"),
            sent,
            len(targets),
        )
        return sent


__all__ = [
    "GONE_STATUSES",
    "MAX_CONSECUTIVE_FAILURES",
    "MAX_FANOUT_SECONDS",
    "MAX_FANOUT_SUBSCRIPTIONS",
    "MAX_SUBSCRIPTION_RADIUS_KM",
    "PUSH_TTL_SECONDS",
    "DeliveryStatus",
    "PushHTTPSession",
    "PushService",
    "normalise_payload",
]
