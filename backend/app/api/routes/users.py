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
    (distributed guessing). When it is exhausted, a burst of someone else's guessing must
    not lock the owner out, so it still admits

    + clients that recently signed in to the account successfully (the bounded
      :data:`~app.core.rate_limit.known_clients` store: the last few clients per account,
      for 14 days), bounded only by their own failure buckets, and
    + clients with fewer than :data:`ACCOUNT_LOCK_OWN_FAILURES` failures of their own,
      but only while the account's :data:`VERIFY_OVERFLOW_PER_ACCOUNT` bucket has room.
      That bucket bounds the escape hatch itself: an attacker who rotates through many
      networks (an IPv6 ``/48`` holds 65,536 ``/64`` subjects) gets at most
      ``VERIFY_FAILURES_PER_ACCOUNT + VERIFY_OVERFLOW_PER_ACCOUNT`` checks per hour, not
      two per network. Once both are used up, a client the account has not recently
      signed in from waits for the window (or uses OAuth).

  Every attempt, successful or not, also counts in :data:`VERIFY_ATTEMPTS_PER_CLIENT` and,
  for IPv6 clients, in :data:`VERIFY_ATTEMPTS_PER_PREFIX` for their whole ``/48`` (never
  refunded, ``503`` answers included): correct passwords are cheap to send in a loop and
  each one costs a bcrypt check, so without these a handful of clients could keep the
  shared bcrypt queue full and every other sign-in would get ``503``. The ``/48`` bucket
  stops one customer from multiplying the per-client budget by rotating its ``/64``
  networks. A ``/48`` can also be a carrier pool shared by many people, so one busy client
  there must not lock its neighbours out of their own accounts: a known client (see above)
  is never *refused* by the ``/48`` bucket (it is still counted while the bucket has room).
  It stays bounded by its own per-client buckets, and the ``/48``'s in-flight cap and the
  quiet budget below still apply to it, so the bcrypt queue invariants hold. Someone signing in
  from a network the account has not signed in from recently cannot be told apart from the
  busy client, and still waits for the ``/48`` window (or uses OAuth). Finally,
  :data:`VERIFY_SUCCESSES_PER_ACCOUNT` caps *successful* sign-ins per account from all
  clients together: looping one valid account from many networks is the cheapest flood,
  and only someone holding the password can use this budget up, so it can never be used to
  lock out someone else.

* ``/register`` — :data:`REGISTER_PER_CLIENT` per end client and
  :data:`REGISTER_PER_PREFIX` per IPv6 ``/48`` (bcrypt is expensive, and every account is
  another SOS SMS budget). A new user has no history that tells them apart from a busy
  client on the same ``/48``, so while that client keeps the ``/48`` budget full, sign-ups
  from it wait for the window (existing accounts, OAuth and anonymous use are unaffected).

* Both — a client may have at most :data:`MAX_VERIFY_IN_FLIGHT_PER_CLIENT` requests in
  flight, an IPv6 ``/48`` at most :data:`MAX_VERIFY_IN_FLIGHT_PER_PREFIX` (further
  concurrent ones get 429 at once). A client's first :data:`QUIET_CLIENT_BCRYPT_JOBS`
  bcrypt jobs per minute (sign-ins and sign-ups together) may use the whole bcrypt queue,
  provided its network (IPv4 ``/24``, IPv6 ``/40``) has not run more than
  :data:`QUIET_NETWORK_BCRYPT_JOBS` either; busier clients leave
  :data:`app.services.users.BCRYPT_RESERVED_FOR_QUIET` slots free, so someone signing in
  for the first time is admitted even while busy clients keep the rest of the queue full.
  Two invariants make that hold against a single network however it rotates its addresses
  (256 IPv4 addresses, 65,536 ``/64`` networks of one ``/48`` or the 256 ``/48`` networks
  of one ``/40``): its quiet jobs per minute stay below the reserve, and an IPv6 ``/48``'s
  requests in flight stay below the unreserved part of the queue (tests pin both). Being
  quiet is only a priority, never a refusal, which is why it can be counted over networks
  this wide. Attackers holding addresses in dozens of such networks can still use the
  reserve up (each network adds its own quiet budget); the reserve is a defence against
  one customer, not against a botnet.

Client addresses are bucketed with :func:`app.core.rate_limit.ip_bucket` (IPv6 by ``/64``)
and, for the shared budgets above, :func:`app.core.rate_limit.ip_prefix_bucket` (IPv6 by
``/48``; IPv4 clients have no such bucket, so these limits change nothing for them) and,
for the quiet budget only, :func:`app.core.rate_limit.ip_network_bucket` (IPv4 ``/24``,
IPv6 ``/40``). Per-client buckets
are skipped when the client address is unknown (an older frontend that does not send
``X-ResQ-Client-IP``): sharing one bucket between all users would turn the limit into a
site-wide lock-out. The account buckets then apply to every caller (without the escape
hatch: nothing tells the owner apart from an attacker).

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
    KnownClients,
    RateLimiter,
    RateLimitState,
    forwarded_client_ip,
    in_flight,
    ip_bucket,
    ip_network_bucket,
    ip_prefix_bucket,
    known_clients,
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
#: Sign-in attempts per end client, successful ones and ``503`` answers included.
VERIFY_ATTEMPTS_PER_CLIENT = "30/minute;600/hour"
#: Sign-in attempts per IPv6 ``/48`` (all its ``/64`` clients together). Four times the
#: per-client budget: a ``/48`` may be one customer rotating networks, but also a carrier
#: pool shared by many people, and sign-ins are rare (sessions last 30 days).
VERIFY_ATTEMPTS_PER_PREFIX = "120/minute;2400/hour"
#: Successful sign-ins per account from all clients together. Each one costs a bcrypt
#: check; people sign in a few times a month, so an hour's worth is far above normal use.
VERIFY_SUCCESSES_PER_ACCOUNT = "30/hour"
#: Registrations allowed per end client.
REGISTER_PER_CLIENT = "5/minute;20/hour"
#: Registrations allowed per IPv6 ``/48`` (all its ``/64`` clients together).
REGISTER_PER_PREFIX = "20/minute;200/hour"
#: Concurrent sign-in/registration requests per end client (the rest get 429 at once).
MAX_VERIFY_IN_FLIGHT_PER_CLIENT = 4
#: Concurrent sign-in/registration requests per IPv6 ``/48``. Must stay below the unreserved
#: part of the bcrypt queue (``BCRYPT_MAX_PENDING - BCRYPT_RESERVED_FOR_QUIET`` = 24), so one
#: ``/48`` can never fill it alone, whatever ``/64`` networks it rotates through.
MAX_VERIFY_IN_FLIGHT_PER_PREFIX = 16
#: bcrypt jobs per end client and minute that may use the reserved part of the bcrypt queue.
QUIET_CLIENT_BCRYPT_JOBS = "3/minute"
#: bcrypt jobs per network (IPv4 ``/24``, IPv6 ``/40``, see
#: :func:`~app.core.rate_limit.ip_network_bucket`) and minute that may use the reserved part
#: of the queue. Must stay below ``BCRYPT_RESERVED_FOR_QUIET`` (8), so one network can never
#: occupy the whole reserve: without it, every fresh ``/64`` of a ``/48`` (and, before the
#: bucket was widened from ``/48``, every ``/48`` of a ``/40`` and every IPv4 address of a
#: ``/24``) counted as a new "quiet" client.
QUIET_NETWORK_BCRYPT_JOBS = "6/minute"
#: Backwards-compatible alias (earlier versions counted every attempt per email).
VERIFY_ATTEMPTS_PER_EMAIL = VERIFY_FAILURES_PER_ACCOUNT
_INVALID_CREDENTIALS = "Invalid email or password."
_TOO_MANY_SIGN_INS = "Too many sign-in attempts. Please wait a moment and retry."
_TOO_MANY_SIGN_UPS = "Too many sign-up attempts. Please wait a moment and retry."

_PAIR = "users-verify-pair"
_CLIENT = "users-verify-client"
_ACCOUNT = "users-verify-account"
_OVERFLOW = "users-verify-overflow"
_ATTEMPTS = "users-verify-attempts"
_ATTEMPTS_PREFIX = "users-verify-attempts-prefix"
_SUCCESSES = "users-verify-successes"
_REGISTER = "users-register"
_REGISTER_PREFIX = "users-register-prefix"
_RECENT = "users-bcrypt-recent"
_RECENT_NETWORK = "users-bcrypt-recent-network"


@dataclass(frozen=True, slots=True)
class _Bucket:
    """One limiter bucket: a ``limits`` string and the identifiers it is counted under."""

    limit: str
    identifiers: tuple[str, ...]

    @property
    def kind(self) -> str:
        return self.identifiers[0]


@dataclass(frozen=True, slots=True)
class _Client:
    """Rate-limit subjects of the end client: its address bucket and its wider network."""

    #: ``ip_bucket`` of the address (IPv6 by ``/64``).
    subject: str
    #: ``ip_prefix_bucket`` (IPv6 ``/48``); ``None`` for IPv4 (no wider bucket is counted).
    prefix: str | None
    #: ``ip_network_bucket`` (IPv4 ``/24``, IPv6 ``/40``): only for the quiet budget.
    network: str | None


def _active_limiter(request: Request) -> RateLimiter | None:
    active: RateLimiter = getattr(request.app.state, "limiter", limiter)
    return active if active.enabled else None


def _keyed(request: Request, purpose: str, value: str) -> str:
    """Keyed hash so the limiter's in-memory keys never hold raw emails or addresses."""
    secret = request.app.state.settings.internal_api_key
    return hash_identifier(value, f"{purpose}:{secret}")


def _compact(keyed_hash: str) -> bytes:
    """First 128 bits of a :func:`_keyed` hash as bytes (a small key for long-lived state)."""
    return bytes.fromhex(keyed_hash[:32])


def _client(request: Request) -> _Client | None:
    """Rate-limit subjects of the end client, ``None`` when its address is unknown."""
    address = forwarded_client_ip(request)
    if address is None:
        return None
    return _Client(
        subject=ip_bucket(address),
        prefix=ip_prefix_bucket(address),
        network=ip_network_bucket(address),
    )


def _raise_limited(state: RateLimitState, message: str) -> None:
    headers = state.headers()
    headers[RETRY_AFTER_HEADER] = str(state.retry_after())
    raise RateLimitExceeded(message, headers=headers)


def _first_refusal(active: RateLimiter, buckets: list[_Bucket]) -> RateLimitState | None:
    """Peek every bucket (nothing is counted); the state of the first full one, if any."""
    for bucket in buckets:
        state = active.peek(bucket.limit, *bucket.identifiers)
        if not state.allowed:
            logger.warning("Sign-in throttled (%s, %s)", bucket.kind, state.description)
            return state
    return None


def _is_quiet(active: RateLimiter, request: Request, client: _Client | None) -> bool:
    """Count one bcrypt job of ``client``; ``True`` while it is among the first few.

    Quiet means: the client's own subject *and* its network (IPv4 ``/24``, IPv6 ``/40``)
    both still have room in their per-minute budgets. Both are counted for every job (a
    busy client still adds to its network), so a network rotating through fresh addresses,
    ``/64`` or ``/48`` networks stops being quiet after :data:`QUIET_NETWORK_BCRYPT_JOBS`
    jobs. (The network bucket replaces a ``/48`` one with the same limit: every ``/48`` lies
    inside one ``/40``, so the ``/40`` bucket is always at least as tight.) Unknown clients
    (no reported address) cannot be told apart, so they keep the whole queue, as before
    this distinction existed.
    """
    if client is None:
        return True
    quiet = active.hit(
        QUIET_CLIENT_BCRYPT_JOBS, _RECENT, _keyed(request, "bcrypt-recent", client.subject)
    ).allowed
    if client.network is not None:
        network_quiet = active.hit(
            QUIET_NETWORK_BCRYPT_JOBS,
            _RECENT_NETWORK,
            _keyed(request, "bcrypt-recent-network", client.network),
        ).allowed
        quiet = quiet and network_quiet
    return quiet


@dataclass(slots=True)
class _Attempt:
    """Reservations and the in-flight slots held by one ``/verify`` or ``/register`` call.

    Exactly one of :meth:`succeeded`, :meth:`failed` or :meth:`abandoned` must be called
    (``finally``), which returns the in-flight slots.
    """

    limiter: RateLimiter | None
    concurrency: ConcurrencyLimiter
    known_clients: KnownClients
    in_flight_keys: list[str] = field(default_factory=list)
    #: Failure reservations (returned on success and when no verdict was reached).
    reserved: list[_Bucket] = field(default_factory=list)
    #: Counted only when the password is correct (:data:`VERIFY_SUCCESSES_PER_ACCOUNT`).
    success_bucket: _Bucket | None = None
    #: ``(account, client)`` key remembered in :attr:`known_clients` on success.
    known_key: tuple[bytes, bytes] | None = None
    #: May use the part of the bcrypt queue reserved for quiet clients.
    quiet: bool = True

    def release_slots(self) -> None:
        for key in self.in_flight_keys:
            self.concurrency.release(key)
        self.in_flight_keys.clear()

    def succeeded(self) -> None:
        """Correct password: reservations are returned and the pair counter is cleared."""
        if self.limiter is not None:
            for bucket in self.reserved:
                if bucket.kind == _PAIR:
                    self.limiter.clear(bucket.limit, *bucket.identifiers)
                else:
                    self.limiter.refund(bucket.limit, *bucket.identifiers)
            if self.success_bucket is not None:
                # Counted after the fact, never reserved: a reservation would let pending
                # wrong guesses (anyone's) fill the owner's success budget for a moment.
                # Concurrent successes may therefore overshoot it by at most the requests
                # in flight, which the bcrypt queue bounds.
                self.limiter.hit(self.success_bucket.limit, *self.success_bucket.identifiers)
            if self.known_key is not None:
                self.known_clients.remember(*self.known_key)
        self.reserved.clear()
        self.release_slots()

    def failed(self) -> None:
        """Wrong credentials: the reservations stay counted as failures."""
        self.reserved.clear()
        self.release_slots()

    def abandoned(self) -> None:
        """No verdict (bcrypt busy, database error, cancelled): give the reservations back.

        The per-client and per-prefix attempt counters are not part of them: they stay
        charged.
        """
        if self.limiter is not None:
            for bucket in self.reserved:
                self.limiter.refund(bucket.limit, *bucket.identifiers)
        self.reserved.clear()
        self.release_slots()


def _take_in_flight_slots(request: Request, attempt: _Attempt, client: _Client | None) -> None:
    """429 when the client (or its IPv6 ``/48``) already has its maximum of requests in flight.

    Either both slots are taken or none.
    """
    if client is None:
        return
    slots = [(_keyed(request, "users-in-flight", client.subject), MAX_VERIFY_IN_FLIGHT_PER_CLIENT)]
    if client.prefix is not None:
        slots.append(
            (
                _keyed(request, "users-in-flight-prefix", client.prefix),
                MAX_VERIFY_IN_FLIGHT_PER_PREFIX,
            )
        )
    for key, maximum in slots:
        if not attempt.concurrency.try_acquire(key, maximum):
            attempt.release_slots()
            logger.warning("Too many concurrent sign-in requests from one client or network")
            raise RateLimitExceeded(_TOO_MANY_SIGN_INS, headers={RETRY_AFTER_HEADER: "1"})
        attempt.in_flight_keys.append(key)


def _new_attempt(active: RateLimiter | None) -> _Attempt:
    return _Attempt(limiter=active, concurrency=in_flight, known_clients=known_clients)


def _begin_verify(request: Request, email: str) -> _Attempt:
    """Admit one sign-in attempt and reserve its failure slots (429 when not allowed).

    Synchronous on purpose: every check and reservation happens without an ``await`` in
    between, so concurrent attempts are counted one by one.
    """
    active = _active_limiter(request)
    attempt = _new_attempt(active)
    if active is None:
        return attempt
    client = _client(request)
    account = _keyed(request, "verify-email", email)
    pair: _Bucket | None = None
    client_bucket: _Bucket | None = None
    #: Never refunded: every attempt costs a bcrypt check, whatever its outcome.
    client_attempts: _Bucket | None = None
    prefix_attempts: _Bucket | None = None
    if client is not None:
        address = _keyed(request, "verify-client", client.subject)
        pair = _Bucket(VERIFY_FAILURES_PER_CLIENT_ACCOUNT, (_PAIR, address, account))
        client_bucket = _Bucket(VERIFY_FAILURES_PER_CLIENT, (_CLIENT, address))
        client_attempts = _Bucket(VERIFY_ATTEMPTS_PER_CLIENT, (_ATTEMPTS, address))
        if client.prefix is not None:
            network = _keyed(request, "verify-prefix", client.prefix)
            prefix_attempts = _Bucket(VERIFY_ATTEMPTS_PER_PREFIX, (_ATTEMPTS_PREFIX, network))
        attempt.known_key = (_compact(account), _compact(address))
    attempt_buckets = [b for b in (client_attempts, prefix_attempts) if b is not None]
    account_bucket = _Bucket(VERIFY_FAILURES_PER_ACCOUNT, (_ACCOUNT, account))
    overflow_bucket = _Bucket(VERIFY_OVERFLOW_PER_ACCOUNT, (_OVERFLOW, account))
    success_bucket = _Bucket(VERIFY_SUCCESSES_PER_ACCOUNT, (_SUCCESSES, account))
    #: This client signed in to this account successfully not long ago.
    known = attempt.known_key is not None and attempt.known_clients.knows(*attempt.known_key)

    _take_in_flight_slots(request, attempt, client)
    try:
        own_buckets = [bucket for bucket in (pair, client_bucket) if bucket is not None]
        checked = [*own_buckets, *attempt_buckets, success_bucket]
        if known and prefix_attempts is not None:
            # A /48 may be a carrier pool: one busy client there must not lock its
            # neighbours out of their own accounts. A known client is bounded by its own
            # buckets above (and the /48's in-flight cap and the quiet budget still apply),
            # so it is never refused by the /48 bucket; the hit below still counts it while
            # the bucket has room.
            checked.remove(prefix_attempts)
        refusal = _first_refusal(active, checked)
        if refusal is not None:
            _raise_limited(refusal, _TOO_MANY_SIGN_INS)

        to_reserve = list(own_buckets)
        account_state = active.peek(account_bucket.limit, *account_bucket.identifiers)
        if account_state.allowed:
            to_reserve.append(account_bucket)
        elif known:
            # Someone else's guessing filled the account bucket; this client signed in to
            # the account recently, so it may still try (bounded by its own failure buckets).
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
        for bucket in attempt_buckets:
            # Never refunded. Cannot be refused either (peeked above), except the /48
            # bucket of a known client, which is then simply not counted.
            active.hit(bucket.limit, *bucket.identifiers)
        attempt.success_bucket = success_bucket
        attempt.quiet = _is_quiet(active, request, client)
    except BaseException:
        attempt.abandoned()
        raise
    return attempt


def _begin_register(request: Request) -> _Attempt:
    """Admit one registration (per-client and per-prefix rates, in-flight caps), else 429."""
    active = _active_limiter(request)
    attempt = _new_attempt(active)
    client = _client(request)
    if active is None or client is None:
        return attempt
    buckets = [
        _Bucket(REGISTER_PER_CLIENT, (_REGISTER, _keyed(request, "register", client.subject)))
    ]
    if client.prefix is not None:
        network = _keyed(request, "register-prefix", client.prefix)
        buckets.append(_Bucket(REGISTER_PER_PREFIX, (_REGISTER_PREFIX, network)))
    _take_in_flight_slots(request, attempt, client)
    try:
        refusal = _first_refusal(active, buckets)
        if refusal is not None:
            _raise_limited(refusal, _TOO_MANY_SIGN_UPS)
        # Registrations always count (successful ones too); only the in-flight slots are
        # returned. Peeked above with no await in between, so these cannot be refused.
        for bucket in buckets:
            active.hit(bucket.limit, *bucket.identifiers)
        attempt.quiet = _is_quiet(active, request, client)
    except BaseException:
        attempt.abandoned()
        raise
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
        attempt.failed()  # keeps the registration counted, returns the in-flight slots
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
