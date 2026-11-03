"""Internal users API (``X-Internal-Key``): ``/api/users/register``, ``/api/users/verify``.

Only the Next.js server calls these (NextAuth's credentials provider and the ``/api/register``
route handler); the browser-facing proxy refuses to forward ``users`` paths. Every route here
requires the shared ``X-Internal-Key`` header (503 when ``INTERNAL_API_KEY`` is unset, 401
when wrong).

Throttling
----------
Every call arrives from the Next.js server, so this router is exempt from the per-IP default
limit (that would be one bucket for all sign-ins of the deployment). Instead the Next.js
server reports the end client's address in ``X-ResQ-Client-IP`` (trusted only together with
the internal key, see :func:`app.core.rate_limit.forwarded_client_ip`) and we apply:

* ``/verify`` — **failed** attempts count against the guessing limits. Each attempt
  *reserves* a slot in every applicable failure bucket before bcrypt runs (synchronously,
  so concurrent requests cannot all slip past a check) and gives it back when the password
  turns out to be correct:

  - :data:`VERIFY_FAILURES_PER_CLIENT_ACCOUNT` — one client guessing one account (a
    successful sign-in clears it: earlier typos are forgiven),
  - :data:`VERIFY_FAILURES_PER_CLIENT` — one client spraying many accounts,
  - :data:`VERIFY_FAILURES_PER_ACCOUNT` — all clients together against one account
    (distributed guessing). When it is exhausted, a burst of someone else's guesses must
    not lock the owner out, so it still admits

    + clients that signed in to the account successfully before (remembered for
      :data:`KNOWN_CLIENT_MEMORY`), bounded only by their own failure buckets, and
    + clients with fewer than :data:`ACCOUNT_LOCK_OWN_FAILURES` failures of their own,
      but only while the account's :data:`VERIFY_OVERFLOW_PER_ACCOUNT` bucket has room.
      That bucket bounds the escape hatch itself: an attacker who rotates through many
      networks (an IPv6 ``/48`` holds 65,536 ``/64`` subjects) gets at most
      ``VERIFY_FAILURES_PER_ACCOUNT + VERIFY_OVERFLOW_PER_ACCOUNT`` checks per hour, not
      two per network. Once both are used up, a client the account has never signed in
      from waits for the window (or uses OAuth).

  Every attempt, successful or not, also counts in :data:`VERIFY_ATTEMPTS_PER_CLIENT`
  (never refunded, ``503`` answers included): correct passwords are cheap to send in a
  loop and each one costs a bcrypt check, so without it a handful of clients could keep the
  shared bcrypt queue full and every other sign-in would get ``503``.

* ``/register`` — :data:`REGISTER_PER_CLIENT` per end client (bcrypt is expensive).

* Both — a client may have at most :data:`MAX_VERIFY_IN_FLIGHT_PER_CLIENT` requests in
  flight (further concurrent ones get 429 at once). A client's first
  :data:`QUIET_CLIENT_BCRYPT_JOBS` bcrypt jobs per minute (sign-ins and sign-ups together)
  may use the whole bcrypt queue; busier clients leave
  :data:`app.services.users.BCRYPT_RESERVED_FOR_QUIET` slots free, so someone signing in
  for the first time is admitted even while busy clients keep the rest of the queue full.

Client addresses are bucketed with :func:`app.core.rate_limit.ip_bucket` (IPv6 by ``/64``).
Per-client buckets are skipped when the client address is unknown (an older frontend that
does not send ``X-ResQ-Client-IP``): sharing one bucket between all users would turn the
limit into a site-wide lock-out. The account bucket then applies to every caller (without the
escape hatch: nothing tells the owner apart from an attacker).

bcrypt itself is bounded too (see :mod:`app.services.users`): when its queue is full the
request gets ``503 service_busy`` and the failure reservations are returned.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from fastapi import APIRouter, Request

from app.api.deps import InternalKey, SessionDep
from app.core.errors import RateLimitExceeded, UnauthorizedError
from app.core.rate_limit import (
    RETRY_AFTER_HEADER,
    ConcurrencyLimiter,
    RateLimiter,
    RateLimitState,
    forwarded_client_ip,
    in_flight,
    ip_bucket,
    limiter,
)
from app.core.security import hash_identifier
from app.schemas.common import error_responses
from app.schemas.users import UserOut, UserRegisterRequest, UserVerifyRequest
from app.services import users as user_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"], dependencies=[InternalKey])

#: Failed sign-ins allowed for one account from one end client (``limits`` syntax).
VERIFY_FAILURES_PER_CLIENT_ACCOUNT = "5/minute;20/hour"
#: Failed sign-ins allowed from one end client across all accounts.
VERIFY_FAILURES_PER_CLIENT = "30/minute;200/hour"
#: Failed sign-ins allowed for one account from all clients together.
VERIFY_FAILURES_PER_ACCOUNT = "100/hour"
#: When :data:`VERIFY_FAILURES_PER_ACCOUNT` is exhausted, clients with fewer failures of
#: their own against the account than this may still try (the owner, maybe after a typo)...
ACCOUNT_LOCK_OWN_FAILURES = 2
#: ... but only this many of them per account in total (bounds the escape hatch).
VERIFY_OVERFLOW_PER_ACCOUNT = "20/hour"
#: How long a client that signed in successfully stays "known" to the account (such clients
#: are admitted even when both account buckets are full). NextAuth sessions last 30 days.
KNOWN_CLIENT_MEMORY = "1/30 days"
#: Sign-in attempts per end client, successful ones and ``503`` answers included.
VERIFY_ATTEMPTS_PER_CLIENT = "30/minute;600/hour"
#: Registrations allowed per end client.
REGISTER_PER_CLIENT = "5/minute;20/hour"
#: Concurrent sign-in/registration requests per end client (the rest get 429 at once).
MAX_VERIFY_IN_FLIGHT_PER_CLIENT = 4
#: bcrypt jobs per end client and minute that may use the reserved part of the bcrypt queue.
QUIET_CLIENT_BCRYPT_JOBS = "3/minute"
#: Backwards-compatible alias (earlier versions counted every attempt per email).
VERIFY_ATTEMPTS_PER_EMAIL = VERIFY_FAILURES_PER_ACCOUNT
_INVALID_CREDENTIALS = "Invalid email or password."
_TOO_MANY_SIGN_INS = "Too many sign-in attempts. Please wait a moment and retry."
_TOO_MANY_SIGN_UPS = "Too many sign-up attempts. Please wait a moment and retry."

_PAIR = "users-verify-pair"
_CLIENT = "users-verify-client"
_ACCOUNT = "users-verify-account"
_OVERFLOW = "users-verify-overflow"
_KNOWN = "users-verify-known"
_ATTEMPTS = "users-verify-attempts"
_RECENT = "users-bcrypt-recent"


@dataclass(frozen=True, slots=True)
class _Bucket:
    """One limiter bucket: a ``limits`` string and the identifiers it is counted under."""

    limit: str
    identifiers: tuple[str, ...]

    @property
    def kind(self) -> str:
        return self.identifiers[0]


def _active_limiter(request: Request) -> RateLimiter | None:
    active: RateLimiter = getattr(request.app.state, "limiter", limiter)
    return active if active.enabled else None


def _keyed(request: Request, purpose: str, value: str) -> str:
    """Keyed hash so the limiter's in-memory keys never hold raw emails or addresses."""
    secret = request.app.state.settings.internal_api_key
    return hash_identifier(value, f"{purpose}:{secret}")


def _client_subject(request: Request) -> str | None:
    """Rate-limit subject of the end client (IPv6 by /64), ``None`` when unknown."""
    client = forwarded_client_ip(request)
    return ip_bucket(client) if client is not None else None


def _raise_limited(state: RateLimitState, message: str) -> None:
    headers = state.headers()
    headers[RETRY_AFTER_HEADER] = str(state.retry_after())
    raise RateLimitExceeded(message, headers=headers)


def _is_quiet(active: RateLimiter, request: Request, subject: str | None) -> bool:
    """Count one bcrypt job of ``subject``; ``True`` while it is among the first few.

    Unknown clients (no reported address) cannot be told apart, so they keep the whole
    queue, as before this distinction existed.
    """
    if subject is None:
        return True
    recent = _Bucket(QUIET_CLIENT_BCRYPT_JOBS, (_RECENT, _keyed(request, "bcrypt-recent", subject)))
    return active.hit(recent.limit, *recent.identifiers).allowed


@dataclass(slots=True)
class _Attempt:
    """Reservations and the in-flight slot held by one ``/verify`` or ``/register`` call.

    Exactly one of :meth:`succeeded`, :meth:`failed` or :meth:`abandoned` must be called
    (``finally``), which returns the in-flight slot.
    """

    limiter: RateLimiter | None
    concurrency: ConcurrencyLimiter
    in_flight_key: str | None = None
    #: Failure reservations (returned on success and when no verdict was reached).
    reserved: list[_Bucket] = field(default_factory=list)
    #: Marker set on success: this client is now known to the account.
    known_marker: _Bucket | None = None
    #: May use the part of the bcrypt queue reserved for quiet clients.
    quiet: bool = True

    def _release_slot(self) -> None:
        if self.in_flight_key is not None:
            self.concurrency.release(self.in_flight_key)
            self.in_flight_key = None

    def succeeded(self) -> None:
        """Correct password: reservations are returned and the pair counter is cleared."""
        if self.limiter is not None:
            for bucket in self.reserved:
                if bucket.kind == _PAIR:
                    self.limiter.clear(bucket.limit, *bucket.identifiers)
                else:
                    self.limiter.refund(bucket.limit, *bucket.identifiers)
            if self.known_marker is not None:
                # Restart the memory window at the latest success.
                self.limiter.clear(self.known_marker.limit, *self.known_marker.identifiers)
                self.limiter.hit(self.known_marker.limit, *self.known_marker.identifiers)
        self.reserved.clear()
        self._release_slot()

    def failed(self) -> None:
        """Wrong credentials: the reservations stay counted as failures."""
        self.reserved.clear()
        self._release_slot()

    def abandoned(self) -> None:
        """No verdict (bcrypt busy, database error, cancelled): give the reservations back.

        The per-client attempt counter is not part of them: it stays charged.
        """
        if self.limiter is not None:
            for bucket in self.reserved:
                self.limiter.refund(bucket.limit, *bucket.identifiers)
        self.reserved.clear()
        self._release_slot()


def _take_in_flight_slot(request: Request, attempt: _Attempt, subject: str | None) -> None:
    """429 when the client already has :data:`MAX_VERIFY_IN_FLIGHT_PER_CLIENT` requests."""
    if subject is None:
        return
    key = _keyed(request, "users-in-flight", subject)
    if not attempt.concurrency.try_acquire(key, MAX_VERIFY_IN_FLIGHT_PER_CLIENT):
        logger.warning("Too many concurrent sign-in requests from one client")
        raise RateLimitExceeded(_TOO_MANY_SIGN_INS, headers={RETRY_AFTER_HEADER: "1"})
    attempt.in_flight_key = key


def _begin_verify(request: Request, email: str) -> _Attempt:
    """Admit one sign-in attempt and reserve its failure slots (429 when not allowed).

    Synchronous on purpose: every check and reservation happens without an ``await`` in
    between, so concurrent attempts are counted one by one.
    """
    active = _active_limiter(request)
    attempt = _Attempt(limiter=active, concurrency=in_flight)
    if active is None:
        return attempt
    subject = _client_subject(request)
    account = _keyed(request, "verify-email", email)
    pair: _Bucket | None = None
    client_bucket: _Bucket | None = None
    attempts: _Bucket | None = None
    known: _Bucket | None = None
    if subject is not None:
        address = _keyed(request, "verify-client", subject)
        pair = _Bucket(VERIFY_FAILURES_PER_CLIENT_ACCOUNT, (_PAIR, address, account))
        client_bucket = _Bucket(VERIFY_FAILURES_PER_CLIENT, (_CLIENT, address))
        attempts = _Bucket(VERIFY_ATTEMPTS_PER_CLIENT, (_ATTEMPTS, address))
        known = _Bucket(KNOWN_CLIENT_MEMORY, (_KNOWN, address, account))
    account_bucket = _Bucket(VERIFY_FAILURES_PER_ACCOUNT, (_ACCOUNT, account))
    overflow_bucket = _Bucket(VERIFY_OVERFLOW_PER_ACCOUNT, (_OVERFLOW, account))

    _take_in_flight_slot(request, attempt, subject)
    try:
        for bucket in (pair, client_bucket, attempts):
            if bucket is None:
                continue
            state = active.peek(bucket.limit, *bucket.identifiers)
            if not state.allowed:
                logger.warning("Too many sign-ins (%s, %s)", bucket.kind, state.description)
                _raise_limited(state, _TOO_MANY_SIGN_INS)

        to_reserve = [bucket for bucket in (pair, client_bucket) if bucket is not None]
        account_state = active.peek(account_bucket.limit, *account_bucket.identifiers)
        if account_state.allowed:
            to_reserve.append(account_bucket)
        elif known is not None and active.count(known.limit, *known.identifiers) > 0:
            # Someone else's guessing filled the account bucket; this client signed in to
            # the account before, so it may still try (bounded by its own failure buckets).
            logger.info("Account sign-in bucket full; admitting a known client")
        else:
            own_failures = active.count(pair.limit, *pair.identifiers) if pair else None
            overflow_state = active.peek(overflow_bucket.limit, *overflow_bucket.identifiers)
            if (
                own_failures is None
                or own_failures >= ACCOUNT_LOCK_OWN_FAILURES
                or not overflow_state.allowed
            ):
                logger.warning(
                    "Too many failed sign-ins (%s, %s)", _ACCOUNT, account_state.description
                )
                _raise_limited(account_state, _TOO_MANY_SIGN_INS)
            # A client with (almost) no failures of its own: admitted through the bounded
            # overflow bucket, so rotating networks cannot multiply the account's budget.
            logger.info("Account sign-in bucket full; admitting a client without own failures")
            to_reserve.append(overflow_bucket)

        for bucket in to_reserve:
            # Cannot be refused: peeked above with no await in between.
            active.hit(bucket.limit, *bucket.identifiers)
            attempt.reserved.append(bucket)
        if attempts is not None:
            active.hit(attempts.limit, *attempts.identifiers)  # never refunded
        attempt.known_marker = known
        attempt.quiet = _is_quiet(active, request, subject)
    except BaseException:
        attempt.abandoned()
        raise
    return attempt


def _begin_register(request: Request) -> _Attempt:
    """Admit one registration (per-client rate + in-flight cap), 429 when not allowed."""
    active = _active_limiter(request)
    attempt = _Attempt(limiter=active, concurrency=in_flight)
    subject = _client_subject(request)
    if active is None or subject is None:
        return attempt
    _take_in_flight_slot(request, attempt, subject)
    bucket = _Bucket(REGISTER_PER_CLIENT, ("users-register", _keyed(request, "register", subject)))
    state = active.hit(bucket.limit, *bucket.identifiers)
    if not state.allowed:
        attempt.abandoned()
        logger.warning("Too many registrations from one client (%s)", state.description)
        _raise_limited(state, _TOO_MANY_SIGN_UPS)
    # Registrations always count (successful ones too); only the in-flight slot is returned.
    attempt.quiet = _is_quiet(active, request, subject)
    return attempt


@router.post(
    "/register",
    response_model=UserOut,
    status_code=201,
    summary="Register an email/password user (internal)",
    responses=error_responses(401, 409, 422, 429, 503),
)
async def register(body: UserRegisterRequest, request: Request, session: SessionDep) -> UserOut:
    """Create a user; 409 ``conflict`` when the email is already registered."""
    attempt = _begin_register(request)
    try:
        user = await user_service.register_user(
            session, body.email, body.password, body.name, use_reserve=attempt.quiet
        )
    finally:
        attempt.failed()  # keeps the registration counted, returns the in-flight slot
    return UserOut(id=user.id, email=user.email, name=user.name)


@router.post(
    "/verify",
    response_model=UserOut,
    summary="Verify email/password credentials (internal)",
    responses=error_responses(401, 422, 429, 503),
)
async def verify(body: UserVerifyRequest, request: Request, session: SessionDep) -> UserOut:
    """Return the user for valid credentials; generic 401 otherwise (no account enumeration)."""
    attempt = _begin_verify(request, body.email)
    try:
        user = await user_service.verify_user(
            session, body.email, body.password, use_reserve=attempt.quiet
        )
    except BaseException:
        attempt.abandoned()
        raise
    if user is None:
        attempt.failed()
        raise UnauthorizedError(_INVALID_CREDENTIALS)
    attempt.succeeded()
    return UserOut(id=user.id, email=user.email, name=user.name)
