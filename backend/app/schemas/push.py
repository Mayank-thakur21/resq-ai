"""Web Push: VAPID key, subscribe/unsubscribe, test notification and payload shape.

Subscriptions are validated strictly because the server later POSTs to the stored endpoint:

* ``endpoint`` must be an ``https`` URL on a **known browser push service**
  (:data:`PUSH_SERVICE_HOSTS` / :data:`PUSH_SERVICE_HOST_SUFFIXES`) — no IP literals, no
  explicit port, no user-info. Anything else (cloud metadata IPs, ``localhost``, internal
  hosts) would turn push delivery into a server-side request forgery primitive.
* ``keys.p256dh`` must be the base64url encoding of an uncompressed P-256 point (65 bytes,
  on the curve) and ``keys.auth`` a 16-byte base64url secret — what every browser sends.
"""

from __future__ import annotations

import base64
import binascii
import ipaddress
from typing import Literal, get_args
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.common import APIModel, Latitude, Longitude, Severity3

PushTopic = Literal["incidents", "disasters"]
PUSH_TOPICS: tuple[str, ...] = get_args(PushTopic)

#: Push services of the major browsers (exact host names).
PUSH_SERVICE_HOSTS: frozenset[str] = frozenset(
    {
        "fcm.googleapis.com",  # Chrome, Edge (Chromium), Opera, Samsung Internet, Brave
        "updates.push.services.mozilla.com",  # Firefox
        "web.push.apple.com",  # Safari (macOS 13+, iOS 16.4+)
    }
)
#: Push services addressed through sub-domains (``*.notify.windows.com`` etc.).
PUSH_SERVICE_HOST_SUFFIXES: tuple[str, ...] = (
    ".push.services.mozilla.com",
    ".notify.windows.com",
    ".push.apple.com",
)
#: Uncompressed P-256 public key: 0x04 || X (32 bytes) || Y (32 bytes).
P256DH_BYTES = 65
#: Web Push authentication secret length (RFC 8291).
AUTH_SECRET_BYTES = 16

_B64URL_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def _b64url_decode(value: str) -> bytes:
    """Decode base64url with or without padding; :class:`ValueError` when malformed."""
    text = value.strip()
    if not text or any(c not in _B64URL_ALPHABET for c in text.rstrip("=")):
        raise ValueError("not base64url")
    try:
        return base64.urlsafe_b64decode(text.rstrip("=") + "=" * (-len(text.rstrip("=")) % 4))
    except (binascii.Error, ValueError) as exc:
        raise ValueError("not base64url") from exc


def is_allowed_push_host(host: str) -> bool:
    """``True`` for host names of known browser push services (case-insensitive)."""
    name = host.lower()
    return name in PUSH_SERVICE_HOSTS or any(
        name.endswith(suffix) and len(name) > len(suffix) for suffix in PUSH_SERVICE_HOST_SUFFIXES
    )


def validate_push_endpoint(value: str) -> str:
    """Return ``value`` when it is an https URL on a known push service, else raise.

    Raises:
        ValueError: not https, user-info, explicit port, IP literal or unknown host.
    """
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise ValueError("push endpoint is not a valid URL") from exc
    if parts.scheme != "https":
        raise ValueError("push endpoint must be an https URL")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise ValueError("push endpoint must not contain credentials")
    if port is not None:
        raise ValueError("push endpoint must not specify a port")
    host = parts.hostname or ""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("push endpoint must use a host name, not an IP address")
    if not is_allowed_push_host(host):
        raise ValueError("push endpoint must belong to a browser push service")
    if not parts.path or parts.path == "/":
        raise ValueError("push endpoint has no subscription path")
    return value


class PushKeys(APIModel):
    p256dh: str = Field(min_length=1, max_length=512)
    auth: str = Field(min_length=1, max_length=256)

    @field_validator("p256dh")
    @classmethod
    def _p256dh_point(cls, value: str) -> str:
        try:
            raw = _b64url_decode(value)
        except ValueError:
            raise ValueError("p256dh must be base64url encoded") from None
        if len(raw) != P256DH_BYTES or raw[0] != 0x04:
            raise ValueError("p256dh must be an uncompressed P-256 public key (65 bytes)")
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        except ValueError:
            raise ValueError("p256dh is not a point on the P-256 curve") from None
        return value.strip()

    @field_validator("auth")
    @classmethod
    def _auth_secret(cls, value: str) -> str:
        try:
            raw = _b64url_decode(value)
        except ValueError:
            raise ValueError("auth must be base64url encoded") from None
        if len(raw) != AUTH_SECRET_BYTES:
            raise ValueError("auth must be a 16-byte secret")
        return value.strip()


class PushSubscriptionInfo(APIModel):
    """The browser's ``PushSubscription.toJSON()`` (``expirationTime`` is ignored)."""

    endpoint: str = Field(min_length=1, max_length=2048)
    keys: PushKeys

    @field_validator("endpoint")
    @classmethod
    def _known_push_service(cls, value: str) -> str:
        return validate_push_endpoint(value.strip())


class PushSubscribeRequest(APIModel):
    subscription: PushSubscriptionInfo
    lat: Latitude | None = None
    lon: Longitude | None = None
    radius_km: float = Field(default=50.0, ge=1, le=500)
    topics: list[PushTopic] = Field(
        default_factory=lambda: ["incidents", "disasters"], min_length=1, max_length=2
    )

    @field_validator("topics")
    @classmethod
    def _dedupe_topics(cls, topics: list[PushTopic]) -> list[PushTopic]:
        return list(dict.fromkeys(topics))

    @model_validator(mode="after")
    def _both_or_neither(self) -> PushSubscribeRequest:
        if (self.lat is None) != (self.lon is None):
            raise ValueError("lat and lon must be provided together")
        return self


class PushSubscribeResponse(BaseModel):
    id: str
    radius_km: float
    topics: list[PushTopic]


class PushUnsubscribeRequest(APIModel):
    endpoint: str = Field(min_length=1, max_length=2048)


class PushUnlinkRequest(APIModel):
    """``POST /api/push/unlink``: detach a device from its account (e.g. on sign-out)."""

    endpoint: str = Field(min_length=1, max_length=2048)


class VapidPublicKeyResponse(BaseModel):
    enabled: bool
    public_key: str | None = None
    #: GDACS disaster alerts are actually pushed (``ALERT_POLLER_ENABLED`` and push enabled).
    #: When ``false`` the UI should not offer the "disasters" topic.
    disaster_alerts: bool = False


class PushTestResponse(BaseModel):
    sent: int


class PushPayload(BaseModel):
    """Notification payload sent to the service worker (``json.dumps(payload.model_dump())``)."""

    title: str = Field(max_length=120)
    body: str = Field(max_length=400)
    #: Same-origin path opened on click, e.g. ``/incidents?focus=<id>``.
    url: str = "/"
    #: Notification tag (same tag replaces an older notification).
    tag: str = "resq"
    severity: Severity3 = "medium"
