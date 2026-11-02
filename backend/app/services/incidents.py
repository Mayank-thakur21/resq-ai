"""Community incidents: create / list / get / upvote / change status, with geo filtering.

Design notes
------------
* Geo queries use a bounding-box pre-filter in SQL (``lat``/``lon`` index) and confirm each
  candidate with the haversine distance. Candidates are *streamed* newest-first, so the
  ``limit`` is applied after the exact distance check without loading the whole table.
* ``verified`` is derived: ``upvotes >= verify_threshold`` (``INCIDENT_VERIFY_THRESHOLD``).
* Upvotes are idempotent per user (``UNIQUE(incident_id, user_id)`` on ``incident_votes``);
  the counter is incremented in SQL so concurrent votes are never lost. Reporters cannot
  upvote their own report (it would let anyone self-verify).
* Only the reporter may change an incident's status.
* :func:`notify_new_incident` is the push fan-out run as a background task after creation;
  it opens its own session because the request's session is closed by then. Free accounts
  could otherwise spam every subscriber in range, so pushes are throttled per reporter
  (:data:`PUSH_PER_REPORTER_LIMIT`) and per device (:data:`PUSH_PER_SUBSCRIPTION_LIMIT`);
  over the limit the incident is still listed, just not pushed.

All functions return :class:`~app.schemas.incidents.IncidentOut` and take the ``viewer``
(authenticated user or ``None``) to fill ``upvoted_by_me``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any, Protocol

from sqlalchemy import Select, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import ForbiddenError, InvalidInputError, NotFoundError
from app.core.rate_limit import RateLimiter
from app.core.rate_limit import limiter as default_limiter
from app.core.security import CurrentUser
from app.db.models import Incident, IncidentVote
from app.schemas.incidents import (
    DEFAULT_INCIDENT_RADIUS_KM,
    MAX_INCIDENT_LIMIT,
    MAX_INCIDENT_RADIUS_KM,
    IncidentCreate,
    IncidentOut,
    IncidentStatus,
    IncidentStatusFilter,
    Reporter,
)
from app.services.geo import bounding_box, haversine_km, validate_coordinates

logger = logging.getLogger(__name__)

#: Default for ``verify_threshold`` (mirrors ``Settings.incident_verify_threshold``).
DEFAULT_VERIFY_THRESHOLD = 3
#: Display name for reporters whose token carries no name.
ANONYMOUS_REPORTER = "Anonymous"
#: Push topic used for incident notifications.
PUSH_TOPIC = "incidents"
#: Characters of the description used as the notification body.
PUSH_BODY_CHARS = 180
#: Incident reports of one reporter that may trigger a push (``limits`` syntax).
PUSH_PER_REPORTER_LIMIT = "3/hour;10/day"
#: Incident notifications one device may receive.
PUSH_PER_SUBSCRIPTION_LIMIT = "1/10minutes;6/hour"

#: Incident severity -> push payload severity (``PushPayload.severity`` has three levels).
_PUSH_SEVERITY = {"low": "low", "medium": "medium", "high": "high", "critical": "high"}


# ---------------------------------------------------------------------------------------------
# Conversions
# ---------------------------------------------------------------------------------------------
def to_out(
    incident: Incident,
    *,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
    upvoted_by_me: bool = False,
    distance_km: float | None = None,
) -> IncidentOut:
    """ORM row -> API model."""
    return IncidentOut(
        id=incident.id,
        created_at=incident.created_at,
        updated_at=incident.updated_at,
        lat=incident.lat,
        lon=incident.lon,
        disaster_type=incident.disaster_type,  # type: ignore[arg-type]
        severity=incident.severity,  # type: ignore[arg-type]
        description=incident.description,
        image_url=incident.image_url,
        status=incident.status,  # type: ignore[arg-type]
        reporter=Reporter(id=incident.reporter_id, name=incident.reporter_name),
        upvotes=incident.upvotes,
        verified=incident.upvotes >= verify_threshold,
        upvoted_by_me=upvoted_by_me,
        distance_km=None if distance_km is None else round(distance_km, 3),
    )


def reporter_display_name(user: CurrentUser) -> str:
    """Public name stored with a report (never the e-mail address)."""
    name = " ".join((user.name or "").split())
    return name[:80] if name else ANONYMOUS_REPORTER


# ---------------------------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------------------------
async def _load(session: AsyncSession, incident_id: str) -> Incident:
    incident = await session.get(Incident, incident_id)
    if incident is None:
        raise NotFoundError("Incident not found.")
    return incident


async def _voted_ids(
    session: AsyncSession, viewer: CurrentUser | None, incident_ids: Iterable[str]
) -> set[str]:
    """Ids (among ``incident_ids``) the viewer has upvoted — one query."""
    ids = list(incident_ids)
    if viewer is None or not ids:
        return set()
    rows = await session.scalars(
        select(IncidentVote.incident_id).where(
            IncidentVote.user_id == viewer.id, IncidentVote.incident_id.in_(ids)
        )
    )
    return set(rows)


async def _has_voted(session: AsyncSession, viewer: CurrentUser | None, incident_id: str) -> bool:
    return incident_id in await _voted_ids(session, viewer, [incident_id])


async def create_incident(
    session: AsyncSession,
    data: IncidentCreate,
    user: CurrentUser,
    *,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
) -> IncidentOut:
    """Persist a new incident reported by ``user`` (status ``open``, 0 upvotes)."""
    incident = Incident(
        lat=data.lat,
        lon=data.lon,
        disaster_type=data.disaster_type,
        severity=data.severity,
        description=data.description,
        image_url=data.image_url,
        status="open",
        reporter_id=user.id,
        reporter_name=reporter_display_name(user),
        upvotes=0,
    )
    session.add(incident)
    await session.commit()
    logger.info(
        "Incident %s created (type=%s, severity=%s)",
        incident.id,
        incident.disaster_type,
        incident.severity,
    )
    return to_out(incident, verify_threshold=verify_threshold)


async def list_incidents(
    session: AsyncSession,
    *,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float = DEFAULT_INCIDENT_RADIUS_KM,
    status: IncidentStatusFilter = "open",
    disaster_type: str | None = None,
    limit: int = 100,
    viewer: CurrentUser | None = None,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
) -> list[IncidentOut]:
    """Incidents newest first, radius-filtered (with ``distance_km``) when ``lat``/``lon`` given.

    Raises:
        InvalidInputError: only one of ``lat``/``lon``, or out-of-range values (422).
    """
    if (lat is None) != (lon is None):
        raise InvalidInputError("lat and lon must be provided together")
    if not 0 < radius_km <= MAX_INCIDENT_RADIUS_KM:
        raise InvalidInputError(f"radius_km must be > 0 and <= {MAX_INCIDENT_RADIUS_KM:g}")
    limit = max(1, min(int(limit), MAX_INCIDENT_LIMIT))

    stmt: Select[tuple[Incident]] = select(Incident)
    if status != "all":
        stmt = stmt.where(Incident.status == status)
    if disaster_type:
        stmt = stmt.where(Incident.disaster_type == disaster_type)
    stmt = stmt.order_by(Incident.created_at.desc(), Incident.id.desc())

    results: list[tuple[Incident, float | None]] = []
    if lat is None or lon is None:
        rows = await session.scalars(stmt.limit(limit))
        results = [(row, None) for row in rows]
    else:
        lat, lon = validate_coordinates(lat, lon)
        box = bounding_box(lat, lon, radius_km)
        stmt = stmt.where(Incident.lat.between(box.min_lat, box.max_lat))
        if box.min_lon > -180.0 or box.max_lon < 180.0:
            stmt = stmt.where(Incident.lon.between(box.min_lon, box.max_lon))
        stream = await session.stream_scalars(stmt)
        try:
            async for row in stream:
                distance = haversine_km(lat, lon, row.lat, row.lon)
                if distance <= radius_km:
                    results.append((row, distance))
                    if len(results) >= limit:
                        break
        finally:
            await stream.close()

    voted = await _voted_ids(session, viewer, (row.id for row, _ in results))
    return [
        to_out(
            row,
            verify_threshold=verify_threshold,
            upvoted_by_me=row.id in voted,
            distance_km=distance,
        )
        for row, distance in results
    ]


async def get_incident(
    session: AsyncSession,
    incident_id: str,
    viewer: CurrentUser | None = None,
    *,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
) -> IncidentOut:
    """One incident.

    Raises:
        NotFoundError: unknown id (404).
    """
    incident = await _load(session, incident_id)
    return to_out(
        incident,
        verify_threshold=verify_threshold,
        upvoted_by_me=await _has_voted(session, viewer, incident.id),
    )


async def upvote(
    session: AsyncSession,
    incident_id: str,
    user: CurrentUser,
    *,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
) -> IncidentOut:
    """Idempotent upvote by ``user``: a second upvote by the same user changes nothing.

    Raises:
        NotFoundError: unknown id (404).
        ForbiddenError: ``user`` reported the incident (403).
    """
    incident = await _load(session, incident_id)
    if incident.reporter_id == user.id:
        raise ForbiddenError("You cannot upvote your own report.")

    # Keep the key in a local: a rollback expires the ORM object, and touching an expired
    # attribute would trigger synchronous (invalid under asyncio) lazy loading.
    key = incident.id
    if not await _has_voted(session, user, key):
        session.add(IncidentVote(incident_id=key, user_id=user.id))
        try:
            await session.flush()
        except IntegrityError:
            # A concurrent request by the same user won the race: already upvoted.
            await session.rollback()
            logger.debug("Duplicate upvote on %s ignored", key)
        else:
            await session.execute(
                update(Incident).where(Incident.id == key).values(upvotes=Incident.upvotes + 1)
            )
            await session.commit()
            logger.info("Incident %s upvoted", key)
        # Reload the counter (incremented in SQL, possibly by concurrent voters too).
        await session.refresh(incident)

    return to_out(incident, verify_threshold=verify_threshold, upvoted_by_me=True)


async def set_status(
    session: AsyncSession,
    incident_id: str,
    status: IncidentStatus,
    user: CurrentUser,
    *,
    verify_threshold: int = DEFAULT_VERIFY_THRESHOLD,
) -> IncidentOut:
    """Change status (reporter only); setting the current status again is a no-op.

    Raises:
        NotFoundError: unknown id (404).
        ForbiddenError: ``user`` is not the reporter (403).
    """
    incident = await _load(session, incident_id)
    if incident.reporter_id != user.id:
        raise ForbiddenError("Only the reporter can change the status of this incident.")
    if incident.status != status:
        incident.status = status
        await session.commit()
        logger.info("Incident %s marked %s", incident.id, status)
    return to_out(
        incident,
        verify_threshold=verify_threshold,
        upvoted_by_me=await _has_voted(session, user, incident.id),
    )


# ---------------------------------------------------------------------------------------------
# Push fan-out
# ---------------------------------------------------------------------------------------------
class NearbyNotifier(Protocol):
    """The part of :class:`~app.services.push.PushService` used here."""

    @property
    def enabled(self) -> bool: ...

    async def notify_nearby(
        self,
        session: AsyncSession,
        lat: float,
        lon: float,
        payload: dict[str, Any],
        topic: str,
        *,
        exclude_user_id: str | None = None,
        per_subscription_limit: str | None = None,
    ) -> int: ...


def build_push_payload(incident: IncidentOut) -> dict[str, Any]:
    """Notification for a new incident (shape of :class:`~app.schemas.push.PushPayload`)."""
    type_label = incident.disaster_type.replace("_", " ")
    body = " ".join(incident.description.split())
    if len(body) > PUSH_BODY_CHARS:
        body = body[: PUSH_BODY_CHARS - 1].rstrip() + "…"
    return {
        "title": f"{incident.severity.capitalize()} {type_label} reported nearby",
        "body": body,
        "url": f"/incidents?focus={incident.id}",
        "tag": f"incident-{incident.id}",
        "severity": _PUSH_SEVERITY.get(incident.severity, "medium"),
    }


async def notify_new_incident(
    push: NearbyNotifier,
    sessionmaker: async_sessionmaker[AsyncSession],
    incident: IncidentOut,
    *,
    limiter: RateLimiter | None = None,
) -> int:
    """Background task: push the new incident to nearby ``incidents`` subscribers.

    The reporter's own devices are skipped. A reporter over :data:`PUSH_PER_REPORTER_LIMIT`
    triggers no push at all, and each device gets at most
    :data:`PUSH_PER_SUBSCRIPTION_LIMIT` incident notifications. Never raises (logs instead) —
    it runs after the response was sent, where an exception would only produce a noisy
    traceback.
    """
    active = limiter or default_limiter
    if active.enabled:
        state = active.hit(PUSH_PER_REPORTER_LIMIT, "incident-push-reporter", incident.reporter.id)
        if not state.allowed:
            logger.info(
                "Incident %s not pushed: reporter over the push limit (%s)",
                incident.id,
                state.description,
            )
            return 0
    payload = build_push_payload(incident)
    try:
        async with sessionmaker() as session:
            sent = await push.notify_nearby(
                session,
                incident.lat,
                incident.lon,
                payload,
                PUSH_TOPIC,
                exclude_user_id=incident.reporter.id,
                per_subscription_limit=PUSH_PER_SUBSCRIPTION_LIMIT if active.enabled else None,
            )
    except Exception:
        logger.exception("Push fan-out for incident %s failed", incident.id)
        return 0
    logger.info("Incident %s: push sent to %d subscription(s)", incident.id, sent)
    return sent


__all__ = [
    "ANONYMOUS_REPORTER",
    "DEFAULT_VERIFY_THRESHOLD",
    "PUSH_TOPIC",
    "NearbyNotifier",
    "build_push_payload",
    "create_incident",
    "get_incident",
    "list_incidents",
    "notify_new_incident",
    "reporter_display_name",
    "set_status",
    "to_out",
    "upvote",
]
