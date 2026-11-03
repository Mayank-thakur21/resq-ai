"""SOS: ``POST /api/sos`` (rate limited by ``SOS_RATE_LIMIT``) and ``GET /api/sos/history``.

Flow of an SOS:

1. Build the SMS text (``🆘 SOS from {name}: {message} | Location: {maps_link} | {UTC time}``,
   at most :data:`~app.schemas.sos.MAX_SMS_BODY_CHARS` characters).
2. Send it to every contact through Twilio (:class:`~app.services.sms.SMSService`) — when
   Twilio is not configured nothing is sent and the UI uses ``fallback_sms_uri`` to open the
   phone's native SMS app instead. Twilio sends are bounded per destination number, per
   caller, per client address (all accounts on it together), for anonymous callers together
   and server-wide (``SOS_SMS_*_LIMIT``, see
   :mod:`app.services.sms`), and optionally reserved for signed-in users
   (``SOS_SMS_REQUIRE_AUTH``); refused numbers are listed in ``sms.failed`` and covered by
   ``fallback_sms_uri``. The fan-out has an overall deadline so the response always beats
   the proxy's 20 s timeout.
3. Store an audit row (:class:`~app.db.models.SOSEvent`; counts only, never phone numbers,
   and a keyed hash of the client IP). A database failure or a slow database (bounded by
   :data:`AUDIT_WRITE_TIMEOUT_SECONDS`) is logged but never turns a delivered SOS into an
   error response.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUserDep, OptionalUserDep, SessionDep, SettingsDep, SMSDep
from app.core.config import Settings
from app.core.logging import mask_phone
from app.core.rate_limit import (
    client_ip,
    client_key,
    ip_bucket,
    reported_client_ip,
    sos_rate_limit,
)
from app.core.security import hash_identifier
from app.db.models import SOSEvent, new_uuid, utcnow
from app.schemas.common import error_responses
from app.schemas.sos import (
    MAX_SMS_BODY_CHARS,
    SMSFailed,
    SMSResult,
    SOSHistoryItem,
    SOSHistoryResponse,
    SOSRequest,
    SOSResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sos"])

#: Name used in the SMS when neither the request nor the session provides one.
ANONYMOUS_NAME = "Anonymous"
#: Maximum number of events returned by ``GET /api/sos/history``.
MAX_HISTORY_EVENTS = 50
#: Upper bound for storing the audit row after the SMS went out (seconds). With SQLite the
#: real bound is the busy timeout (``app.db.session.SQLITE_BUSY_TIMEOUT_SECONDS``, kept at
#: or below this): a cancelled statement still waits for it. SMS deadline (12 s) + this
#: + overhead stays inside the proxy's 20 s timeout.
AUDIT_WRITE_TIMEOUT_SECONDS = 3.0
#: ``sms.failed`` error when ``SOS_SMS_REQUIRE_AUTH`` is on and the caller is anonymous.
SIGN_IN_REQUIRED_ERROR = (
    "Sign in to have ResQ AI text your contacts. Send it from your phone's SMS app instead."
)
_ELLIPSIS = "…"


# ----------------------------------------------------------------------------------------------
# helpers (pure functions — unit tested directly)
# ----------------------------------------------------------------------------------------------
def format_coordinate(value: float) -> str:
    """Fixed-point coordinate with at most 6 decimals (~0.1 m), no exponent, no trailing 0s.

    ``28.6139 -> "28.6139"``, ``77.0 -> "77"``, ``0.00001 -> "0.00001"``, ``-0.0 -> "0"``.
    """
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return "0" if text in {"", "-", "-0"} else text


def build_maps_link(lat: float, lon: float) -> str:
    """Google Maps link that opens a pin at the location on any phone."""
    return f"https://maps.google.com/?q={format_coordinate(lat)},{format_coordinate(lon)}"


def build_sms_body(name: str, message: str, maps_link: str, when: datetime) -> str:
    """The SOS text, shortened to :data:`MAX_SMS_BODY_CHARS` by truncating the message.

    The location link and time are never cut (they are what the recipient needs most).
    """
    stamp = when.strftime("%Y-%m-%d %H:%M UTC")
    name = " ".join(name.split()) or ANONYMOUS_NAME
    message = " ".join(message.split())

    def render(text: str) -> str:
        return f"🆘 SOS from {name}: {text} | Location: {maps_link} | {stamp}"

    body = render(message)
    if len(body) <= MAX_SMS_BODY_CHARS:
        return body
    budget = MAX_SMS_BODY_CHARS - len(render(""))
    if budget > len(_ELLIPSIS):
        return render(message[: budget - len(_ELLIPSIS)].rstrip() + _ELLIPSIS)
    # Pathological name length (names are capped at 80 chars, so this is defensive only).
    return render("")[:MAX_SMS_BODY_CHARS]


def build_fallback_sms_uri(numbers: list[str], body: str) -> str:
    """``sms:<n1>,<n2>?&body=<urlencoded>`` — the ``?&`` form works on both iOS and Android."""
    return f"sms:{','.join(numbers)}?&body={quote(body, safe='')}"


def numbers_needing_fallback(numbers: list[str], sms: SMSResult) -> list[str]:
    """Recipients the native-SMS fallback should target.

    When Twilio delivered to *some* contacts only, the fallback targets the ones that failed
    (matched via their masked form); otherwise (not configured, nothing delivered or
    everything delivered) it targets every contact.
    """
    if not (sms.configured and sms.sent and sms.failed):
        return list(numbers)
    failed_masks = {item.to for item in sms.failed}
    pending = [number for number in numbers if mask_phone(number) in failed_masks]
    return pending or list(numbers)


def sms_address_key(request: Request, signed_in: bool) -> str | None:
    """Address bucket for the per-address SMS budget, ``None`` when the address is unknown.

    Signed-in requests always come through the Next.js server, whose own address is shared
    by every user, so only an address it (or a trusted proxy) reported counts. Anonymous
    callers already share their per-client budget with everyone on the same address.
    """
    address = reported_client_ip(request) if signed_in else client_ip(request)
    return f"ip:{ip_bucket(address)}" if address else None


def _ip_hash_salt(settings: Settings) -> str:
    """Key for :func:`hash_identifier` (domain-separated, server secret when available)."""
    secret = settings.backend_jwt_secret or settings.internal_api_key or "resq-ai"
    return f"sos-client-ip:{secret}"


async def _store_audit_event(session: AsyncSession, event: SOSEvent) -> None:
    """Store the audit row, bounded by :data:`AUDIT_WRITE_TIMEOUT_SECONDS`; never raises.

    The SMS already went out: a slow or failing database (locked, full disk, exhausted
    pool) must not turn a delivered SOS into an error or push the response past the
    proxy's timeout. Only the exception *type* is logged: driver messages can quote row
    values (name, message, location).
    """
    try:
        async with asyncio.timeout(AUDIT_WRITE_TIMEOUT_SECONDS):
            session.add(event)
            await session.commit()
    except Exception as exc:
        logger.error("Could not store SOS event %s (%s)", event.id, type(exc).__name__)
        try:
            async with asyncio.timeout(AUDIT_WRITE_TIMEOUT_SECONDS):
                await session.rollback()
        except Exception as rollback_exc:
            logger.warning(
                "Rollback after failed SOS audit write failed (%s)", type(rollback_exc).__name__
            )


# ----------------------------------------------------------------------------------------------
# endpoints
# ----------------------------------------------------------------------------------------------
@router.post(
    "/sos",
    response_model=SOSResponse,
    summary="Trigger an SOS",
    dependencies=[Depends(sos_rate_limit)],
    responses=error_responses(422, 429),
)
async def create_sos(
    body: SOSRequest,
    request: Request,
    session: SessionDep,
    sms: SMSDep,
    settings: SettingsDep,
    user: OptionalUserDep,
) -> SOSResponse:
    """Send the SOS SMS to every contact (Twilio) and record the event.

    Signing in is optional; when signed in the event appears in ``GET /api/sos/history``.
    ``sms.configured=false`` (or any ``sms.failed`` entry) means the client should offer
    ``fallback_sms_uri`` to send the message from the phone's SMS app.
    """
    now = utcnow()
    name = body.user_name or (user.name if user else None) or ANONYMOUS_NAME
    maps_link = build_maps_link(body.lat, body.lon)
    sms_body = build_sms_body(name, body.message, maps_link, now)
    numbers = body.contact_numbers

    logger.warning(
        "SOS triggered (user=%s, approx=%.2f,%.2f, contacts=%d)",
        user.id if user else "anonymous",
        body.lat,
        body.lon,
        len(numbers),
    )

    if not numbers:
        sms_result = SMSResult(configured=sms.configured)
    elif settings.sos_sms_require_auth and user is None and sms.configured:
        # Anonymous callers only get the native-SMS fallback (no paid Twilio messages).
        logger.info("Anonymous SOS: Twilio SMS reserved for signed-in users")
        sms_result = SMSResult(
            configured=True,
            failed=[SMSFailed(to=mask_phone(n), error=SIGN_IN_REQUIRED_ERROR) for n in numbers],
        )
    else:
        sms_result = await sms.send_bulk(
            numbers,
            sms_body,
            client_key=client_key(request),
            address_key=sms_address_key(request, signed_in=user is not None),
            anonymous=user is None,
        )

    event = SOSEvent(
        id=new_uuid(),
        created_at=now,
        user_id=user.id if user else None,
        user_name=name[:80],
        lat=body.lat,
        lon=body.lon,
        accuracy_m=body.accuracy_m,
        message=body.message,
        contacts_count=len(numbers),
        sms_sent=len(sms_result.sent),
        sms_failed=len(sms_result.failed),
        client_ip_hash=hash_identifier(client_ip(request), _ip_hash_salt(settings)),
    )
    await _store_audit_event(session, event)

    return SOSResponse(
        id=event.id,
        timestamp=now,
        maps_link=maps_link,
        message=body.message,
        sms=sms_result,
        fallback_sms_uri=build_fallback_sms_uri(
            numbers_needing_fallback(numbers, sms_result), sms_body
        ),
    )


@router.get(
    "/sos/history",
    response_model=SOSHistoryResponse,
    summary="My recent SOS events",
    responses=error_responses(401, 503),
)
async def sos_history(
    session: SessionDep,
    user: CurrentUserDep,
    limit: int = Query(MAX_HISTORY_EVENTS, ge=1, le=MAX_HISTORY_EVENTS),
) -> SOSHistoryResponse:
    """The signed-in user's own SOS events, newest first (at most 50)."""
    rows = await session.scalars(
        select(SOSEvent)
        .where(SOSEvent.user_id == user.id)
        .order_by(SOSEvent.created_at.desc(), SOSEvent.id.desc())
        .limit(limit)
    )
    return SOSHistoryResponse(
        events=[
            SOSHistoryItem(
                id=row.id,
                timestamp=row.created_at,
                lat=row.lat,
                lon=row.lon,
                message=row.message,
                contacts_count=row.contacts_count,
                sms_sent=row.sms_sent,
                sms_failed=row.sms_failed,
            )
            for row in rows
        ]
    )
