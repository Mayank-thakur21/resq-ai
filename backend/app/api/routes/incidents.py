"""Community incidents: ``/api/incidents``.

* ``POST  /incidents``               (auth) report an incident -> 201; nearby push subscribers
  of the ``incidents`` topic are notified in a background task. Limited per user by
  ``INCIDENT_RATE_LIMIT`` (default 5/hour, 20/day); pushes are additionally throttled per
  reporter and per device (see :func:`app.services.incidents.notify_new_incident`).
* ``GET   /incidents``               list (newest first), radius filter with ``lat``/``lon``.
* ``GET   /incidents/{id}``          one incident (404 ``not_found``).
* ``POST  /incidents/{id}/upvote``   (auth) idempotent per user; reporters cannot self-upvote.
* ``PATCH /incidents/{id}``          (auth, reporter only -> else 403) ``{"status": ...}``.

Reads accept an optional token so ``upvoted_by_me`` reflects the caller. Paths are relative to
the ``/api`` prefix; the default rate limit is applied by ``app.api``.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Path, Query, Request, status

from app.api.deps import (
    CurrentUserDep,
    OptionalUserDep,
    PushDep,
    SessionDep,
    SessionmakerDep,
    SettingsDep,
)
from app.core.errors import InvalidInputError
from app.core.rate_limit import incident_rate_limit, limiter
from app.schemas.common import error_responses
from app.schemas.incidents import (
    DEFAULT_INCIDENT_RADIUS_KM,
    MAX_INCIDENT_LIMIT,
    MAX_INCIDENT_RADIUS_KM,
    DisasterType,
    IncidentCreate,
    IncidentListResponse,
    IncidentOut,
    IncidentStatusFilter,
    IncidentStatusUpdate,
)
from app.services import incidents as incident_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["incidents"])

IncidentId = Annotated[str, Path(min_length=1, max_length=64, description="Incident id")]


@router.post(
    "",
    response_model=IncidentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Report an incident",
    dependencies=[Depends(incident_rate_limit)],
    responses=error_responses(401, 422, 429, 503),
)
async def create_incident(
    body: IncidentCreate,
    request: Request,
    user: CurrentUserDep,
    session: SessionDep,
    settings: SettingsDep,
    push: PushDep,
    sessionmaker: SessionmakerDep,
    background: BackgroundTasks,
) -> IncidentOut:
    """Create an incident reported by the signed-in user.

    After the response is sent, web-push subscribers whose radius covers the incident (topic
    ``incidents``) get a notification linking to ``/incidents?focus=<id>``.
    """
    incident = await incident_service.create_incident(
        session, body, user, verify_threshold=settings.incident_verify_threshold
    )
    if push.enabled:
        background.add_task(
            incident_service.notify_new_incident,
            push,
            sessionmaker,
            incident,
            limiter=getattr(request.app.state, "limiter", limiter),
        )
    else:
        logger.debug("Push disabled: no fan-out for incident %s", incident.id)
    return incident


@router.get(
    "",
    response_model=IncidentListResponse,
    summary="List incidents (optionally near a point)",
    responses=error_responses(422, 429),
)
async def list_incidents(
    session: SessionDep,
    settings: SettingsDep,
    viewer: OptionalUserDep,
    lat: Annotated[
        float | None, Query(ge=-90.0, le=90.0, description="Latitude (requires lon)")
    ] = None,
    lon: Annotated[
        float | None, Query(ge=-180.0, le=180.0, description="Longitude (requires lat)")
    ] = None,
    radius_km: Annotated[
        float,
        Query(gt=0, le=MAX_INCIDENT_RADIUS_KM, description="Radius around lat/lon in km"),
    ] = DEFAULT_INCIDENT_RADIUS_KM,
    status_filter: Annotated[
        IncidentStatusFilter, Query(alias="status", description="open (default), resolved, all")
    ] = "open",
    disaster_type: Annotated[
        DisasterType | None, Query(alias="type", description="Only this disaster type")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_INCIDENT_LIMIT)] = 100,
) -> IncidentListResponse:
    """Newest first. With ``lat``/``lon`` only incidents within ``radius_km`` are returned and
    each carries ``distance_km``."""
    if (lat is None) != (lon is None):
        raise InvalidInputError("lat and lon must be provided together")
    incidents = await incident_service.list_incidents(
        session,
        lat=lat,
        lon=lon,
        radius_km=radius_km,
        status=status_filter,
        disaster_type=disaster_type,
        limit=limit,
        viewer=viewer,
        verify_threshold=settings.incident_verify_threshold,
    )
    return IncidentListResponse(incidents=incidents)


@router.get(
    "/{incident_id}",
    response_model=IncidentOut,
    summary="Get one incident",
    responses=error_responses(404, 422, 429),
)
async def get_incident(
    incident_id: IncidentId,
    session: SessionDep,
    settings: SettingsDep,
    viewer: OptionalUserDep,
) -> IncidentOut:
    return await incident_service.get_incident(
        session, incident_id, viewer, verify_threshold=settings.incident_verify_threshold
    )


@router.post(
    "/{incident_id}/upvote",
    response_model=IncidentOut,
    summary="Upvote an incident (idempotent per user)",
    responses=error_responses(401, 403, 404, 429, 503),
)
async def upvote_incident(
    incident_id: IncidentId,
    user: CurrentUserDep,
    session: SessionDep,
    settings: SettingsDep,
) -> IncidentOut:
    """Confirms an incident. Upvoting twice is harmless; ``verified`` becomes true once
    ``upvotes >= INCIDENT_VERIFY_THRESHOLD``. Reporters cannot upvote their own report (403).
    """
    return await incident_service.upvote(
        session, incident_id, user, verify_threshold=settings.incident_verify_threshold
    )


@router.patch(
    "/{incident_id}",
    response_model=IncidentOut,
    summary="Change an incident's status (reporter only)",
    responses=error_responses(401, 403, 404, 422, 429, 503),
)
async def update_incident_status(
    incident_id: IncidentId,
    body: IncidentStatusUpdate,
    user: CurrentUserDep,
    session: SessionDep,
    settings: SettingsDep,
) -> IncidentOut:
    return await incident_service.set_status(
        session, incident_id, body.status, user, verify_threshold=settings.incident_verify_threshold
    )
