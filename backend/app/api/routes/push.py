"""Web push: ``/api/push/vapid-public-key``, ``/subscribe``, ``/unsubscribe``, ``/test``.

* ``GET  /push/vapid-public-key`` — ``{"enabled", "public_key"}`` for ``pushManager.subscribe``.
* ``POST /push/subscribe`` (optional auth) — upsert by endpoint; 503 ``not_configured`` when
  web push is disabled on the server.
* ``POST /push/unsubscribe`` — idempotent delete by endpoint (the endpoint URL is the
  capability: whoever holds it controls the subscription).
* ``POST /push/unlink`` — keep the subscription but detach it from its account (the web app
  calls this on sign-out so the next person using the device does not get the previous
  user's notifications). Idempotent.
* ``POST /push/test`` (auth required) — test notification to the caller's own devices.

Besides the router-wide default limit, ``subscribe``/``unlink`` and ``test`` have tighter
per-client limits (:data:`SUBSCRIBE_RATE_LIMIT`, :data:`TEST_RATE_LIMIT`): every stored
subscription costs a delivery on each fan-out, and ``test`` triggers outbound requests.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUserDep, OptionalUserDep, PushDep, SessionDep, SettingsDep
from app.core.errors import ServiceNotConfiguredError
from app.core.rate_limit import RateLimit
from app.core.security import CurrentUser
from app.db.models import PushSubscription
from app.schemas.common import OkResponse, error_responses
from app.schemas.push import (
    PushSubscribeRequest,
    PushSubscribeResponse,
    PushTestResponse,
    PushTopic,
    PushUnlinkRequest,
    PushUnsubscribeRequest,
    VapidPublicKeyResponse,
)
from app.services.push import PushService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/push", tags=["push"])

#: Subscription writes (subscribe + unlink) per client.
SUBSCRIBE_RATE_LIMIT = "10/minute;60/hour"
#: Test notifications per user.
TEST_RATE_LIMIT = "5/minute;30/hour"

subscribe_rate_limit = RateLimit(lambda _settings: SUBSCRIBE_RATE_LIMIT, scope="push-subscribe")
test_rate_limit = RateLimit(lambda _settings: TEST_RATE_LIMIT, scope="push-test")

TEST_NOTIFICATION = {
    "title": "ResQ AI test notification",
    "body": "Push notifications are working on this device.",
    "url": "/profile",
    "tag": "resq-test",
    "severity": "low",
}


def _require_enabled(push: PushService) -> None:
    if not push.enabled:
        raise ServiceNotConfiguredError(
            "Web push notifications are not configured on the server (VAPID keys)."
        )


def _apply(sub: PushSubscription, body: PushSubscribeRequest, user: CurrentUser | None) -> None:
    """Copy the request onto a (new or existing) subscription row."""
    sub.p256dh = body.subscription.keys.p256dh
    sub.auth = body.subscription.keys.auth
    sub.lat = body.lat
    sub.lon = body.lon
    sub.radius_km = body.radius_km
    sub.topics = ",".join(body.topics)
    # A fresh subscribe proves the browser is alive: forget earlier delivery failures.
    sub.failure_count = 0
    # Anonymous re-subscribes keep an existing link (e.g. a stale signed-out tab); signing
    # out calls POST /push/unlink explicitly.
    if user is not None:
        sub.user_id = user.id


async def _upsert(
    session: AsyncSession, body: PushSubscribeRequest, user: CurrentUser | None
) -> PushSubscription:
    endpoint = body.subscription.endpoint
    for attempt in range(2):
        sub = await session.scalar(
            select(PushSubscription).where(PushSubscription.endpoint == endpoint)
        )
        created = sub is None
        if sub is None:
            sub = PushSubscription(endpoint=endpoint)
            session.add(sub)
        _apply(sub, body, user)
        try:
            await session.commit()
        except IntegrityError:
            # A concurrent request inserted the same endpoint first: retry as an update.
            await session.rollback()
            if attempt:
                raise
            continue
        logger.info(
            "Push subscription %s %s (topics=%s, located=%s, user=%s)",
            sub.id,
            "created" if created else "updated",
            sub.topics,
            sub.has_location,
            "yes" if sub.user_id else "no",
        )
        return sub
    raise AssertionError("unreachable")  # pragma: no cover


@router.get(
    "/vapid-public-key",
    response_model=VapidPublicKeyResponse,
    summary="VAPID public key for subscribing",
)
async def vapid_public_key(push: PushDep, settings: SettingsDep) -> VapidPublicKeyResponse:
    """``enabled=false`` (and no key) when web push is not configured.

    ``disaster_alerts`` tells the UI whether GDACS disaster pushes are actually sent (the
    background poller runs only when ``ALERT_POLLER_ENABLED`` is true).
    """
    return VapidPublicKeyResponse(
        enabled=push.enabled,
        public_key=push.public_key,
        disaster_alerts=push.enabled and settings.alert_poller_enabled,
    )


@router.post(
    "/subscribe",
    response_model=PushSubscribeResponse,
    summary="Create or update a push subscription",
    dependencies=[Depends(subscribe_rate_limit)],
    responses=error_responses(422, 429, 503),
)
async def subscribe(
    body: PushSubscribeRequest,
    session: SessionDep,
    push: PushDep,
    user: OptionalUserDep,
) -> PushSubscribeResponse:
    """Upsert by endpoint. ``lat``/``lon`` + ``radius_km`` scope incident and disaster alerts;
    without a location only red disaster alerts are delivered."""
    _require_enabled(push)
    sub = await _upsert(session, body, user)
    topics: list[PushTopic] = list(body.topics)
    return PushSubscribeResponse(id=sub.id, radius_km=sub.radius_km, topics=topics)


@router.post(
    "/unsubscribe",
    response_model=OkResponse,
    summary="Remove a push subscription",
    responses=error_responses(422),
)
async def unsubscribe(body: PushUnsubscribeRequest, session: SessionDep) -> OkResponse:
    """Idempotent: unknown endpoints also return ``{"ok": true}``."""
    result = await session.execute(
        delete(PushSubscription).where(PushSubscription.endpoint == body.endpoint)
    )
    await session.commit()
    if getattr(result, "rowcount", 0):
        logger.info("Push subscription removed")
    return OkResponse(ok=True)


@router.post(
    "/unlink",
    response_model=OkResponse,
    summary="Detach a push subscription from its account",
    dependencies=[Depends(subscribe_rate_limit)],
    responses=error_responses(422, 429),
)
async def unlink(body: PushUnlinkRequest, session: SessionDep) -> OkResponse:
    """Clear the account link of the subscription with this endpoint (it keeps receiving
    location-based alerts anonymously). Idempotent: unknown endpoints also return ok."""
    result = await session.execute(
        update(PushSubscription)
        .where(PushSubscription.endpoint == body.endpoint, PushSubscription.user_id.is_not(None))
        .values(user_id=None)
    )
    await session.commit()
    if getattr(result, "rowcount", 0):
        logger.info("Push subscription unlinked from its account")
    return OkResponse(ok=True)


@router.post(
    "/test",
    response_model=PushTestResponse,
    summary="Send a test notification to my devices",
    dependencies=[Depends(test_rate_limit)],
    responses=error_responses(401, 429, 503),
)
async def send_test(session: SessionDep, push: PushDep, user: CurrentUserDep) -> PushTestResponse:
    """Returns how many of the caller's subscriptions accepted the notification."""
    _require_enabled(push)
    sent = await push.notify_user(session, user.id, dict(TEST_NOTIFICATION))
    return PushTestResponse(sent=sent)
