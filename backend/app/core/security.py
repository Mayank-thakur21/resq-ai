"""Authentication primitives.

* End users authenticate in the Next.js frontend (NextAuth). The frontend's server-side proxy
  mints a short-lived HS256 JWT (``iss="resq-frontend"``, ``aud="resq-backend"``) signed with
  ``BACKEND_JWT_SECRET`` and sends it as ``Authorization: Bearer <jwt>``.
* The internal ``/api/users/*`` endpoints are only called by the Next.js server and are
  guarded by the shared ``X-Internal-Key`` header.

FastAPI dependencies exported here: :func:`get_optional_user`, :func:`get_current_user`,
:func:`require_internal_key`. Non-dependency helper: :func:`user_from_request` (used by the
rate-limit key function).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
import warnings
from typing import Annotated, Any

import jwt
from fastapi import Depends, Request, Security
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from jwt.warnings import InsecureKeyLengthWarning
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.core.errors import ServiceNotConfiguredError, UnauthorizedError

logger = logging.getLogger(__name__)

JWT_ALGORITHM = "HS256"
JWT_ISSUER = "resq-frontend"
JWT_AUDIENCE = "resq-backend"
JWT_LEEWAY_SECONDS = 30
INTERNAL_KEY_HEADER = "X-Internal-Key"

_USER_STATE_ATTR = "_resq_current_user"
_UNSET: Any = object()

# Short secrets are reported once at startup (see app.main); silence PyJWT's per-call warning.
warnings.filterwarnings("ignore", category=InsecureKeyLengthWarning)


class CurrentUser(BaseModel):
    """Identity of the end user on whose behalf the frontend proxy is calling."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1, max_length=128)
    email: str | None = None
    name: str | None = None


class TokenError(Exception):
    """Raised by :func:`decode_access_token` for any invalid token."""

    def __init__(self, message: str, *, expired: bool = False) -> None:
        super().__init__(message)
        self.expired = expired


# OpenAPI security schemes (auto_error=False: we produce our own error envelope).
bearer_scheme = HTTPBearer(
    auto_error=False,
    scheme_name="FrontendJWT",
    description="Short-lived HS256 JWT minted by the ResQ Next.js proxy.",
)
internal_key_scheme = APIKeyHeader(
    name=INTERNAL_KEY_HEADER,
    auto_error=False,
    scheme_name="InternalKey",
    description="Shared secret used by the Next.js server for /api/users/*.",
)


def create_access_token(
    user_id: str,
    email: str | None,
    name: str | None,
    secret: str,
    expires_in: int = 600,
    *,
    issuer: str = JWT_ISSUER,
    audience: str = JWT_AUDIENCE,
    issued_at: int | None = None,
) -> str:
    """Mint a token exactly like the frontend proxy does (used by tests and tooling).

    ``expires_in`` may be negative to produce an already-expired token.
    """
    now = int(time.time()) if issued_at is None else issued_at
    payload: dict[str, Any] = {
        "sub": user_id,
        "iat": now,
        "exp": now + expires_in,
        "iss": issuer,
        "aud": audience,
    }
    if email:
        payload["email"] = email
    if name:
        payload["name"] = name
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str, secret: str) -> CurrentUser:
    """Validate a frontend JWT and return the user it represents.

    Raises:
        TokenError: signature/claims invalid (``expired=True`` for an expired token).
    """
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[JWT_ALGORITHM],
            audience=JWT_AUDIENCE,
            issuer=JWT_ISSUER,
            leeway=JWT_LEEWAY_SECONDS,
            options={"require": ["sub", "exp", "iat"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Token expired", expired=True) from exc
    except jwt.InvalidTokenError as exc:
        raise TokenError(f"Invalid token ({type(exc).__name__})") from exc

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip() or len(sub) > 128:
        raise TokenError("Invalid token (bad subject)")
    email = claims.get("email")
    name = claims.get("name")
    return CurrentUser(
        id=sub.strip(),
        email=email if isinstance(email, str) and email else None,
        name=name[:80] if isinstance(name, str) and name else None,
    )


def bearer_token(request: Request) -> str | None:
    """Extract the raw token from ``Authorization: Bearer <token>`` (case-insensitive)."""
    header = request.headers.get("authorization")
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _settings(request: Request) -> Settings:
    settings = getattr(request.app.state, "settings", None)
    if settings is None:  # pragma: no cover - create_app always sets it
        raise RuntimeError("app.state.settings is not initialised")
    return settings


def user_from_request(request: Request) -> CurrentUser | None:
    """Return the authenticated user or ``None`` (missing/invalid token, auth disabled).

    The result is memoised on ``request.state`` so the rate limiter and route dependencies
    decode the token only once per request.
    """
    cached = getattr(request.state, _USER_STATE_ATTR, _UNSET)
    if cached is not _UNSET:
        return cached

    user: CurrentUser | None = None
    token = bearer_token(request)
    secret = _settings(request).backend_jwt_secret
    if token and secret:
        try:
            user = decode_access_token(token, secret)
        except TokenError as exc:
            logger.info("Ignoring bearer token: %s", exc)
    setattr(request.state, _USER_STATE_ATTR, user)
    return user


async def get_optional_user(
    request: Request,
    _credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> CurrentUser | None:
    """Dependency: the current user if a valid token was sent, else ``None``."""
    return user_from_request(request)


async def get_current_user(
    request: Request,
    _credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> CurrentUser:
    """Dependency: the authenticated user.

    Raises:
        ServiceNotConfiguredError: ``BACKEND_JWT_SECRET`` is not configured (503).
        UnauthorizedError: missing, invalid or expired token (401).
    """
    secret = _settings(request).backend_jwt_secret
    if not secret:
        raise ServiceNotConfiguredError(
            "User authentication is not configured on the server (BACKEND_JWT_SECRET)."
        )
    token = bearer_token(request)
    if not token:
        raise UnauthorizedError("Authentication required.")
    try:
        user = decode_access_token(token, secret)
    except TokenError as exc:
        logger.info("Rejected bearer token: %s", exc)
        raise UnauthorizedError(
            "Token expired." if exc.expired else "Invalid authentication token."
        ) from exc
    setattr(request.state, _USER_STATE_ATTR, user)
    return user


async def require_internal_key(
    request: Request,
    api_key: Annotated[str | None, Security(internal_key_scheme)],
) -> None:
    """Dependency guarding internal endpoints with a constant-time ``X-Internal-Key`` check.

    Raises:
        ServiceNotConfiguredError: ``INTERNAL_API_KEY`` is not configured (503).
        UnauthorizedError: header missing or wrong (401).
    """
    expected = _settings(request).internal_api_key
    if not expected:
        raise ServiceNotConfiguredError(
            "The internal API is not configured on the server (INTERNAL_API_KEY)."
        )
    provided = (api_key or "").encode("utf-8")
    if not hmac.compare_digest(provided, expected.encode("utf-8")):
        logger.warning("Rejected internal API call with an invalid key on %s", request.url.path)
        raise UnauthorizedError("Invalid internal API key.", headers={"WWW-Authenticate": "ApiKey"})


def hash_identifier(value: str, salt: str) -> str:
    """Keyed SHA-256 of an identifier (e.g. a client IP) so it can be stored without PII."""
    return hmac.new(salt.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()
