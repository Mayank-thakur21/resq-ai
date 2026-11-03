"""In-process sliding-window rate limiting (FastAPI dependencies on top of ``limits``).

Why not slowapi
---------------
slowapi 0.1.10 was verified against this stack: its ``@limiter.limit`` decorator works with
Starlette 1.10, but its middleware (which applies the *default* limit) cannot see routes added
with ``include_router`` on FastAPI 0.162 — FastAPI no longer flattens included routers (it
keeps lazy ``_IncludedRouter`` objects without ``.endpoint``), so slowapi treats every
``/api/*`` route as unknown and silently skips it. As the spec prescribes, we therefore use an
equivalent in-process limiter built on ``limits`` (slowapi's own engine) with the same
behaviour: moving (sliding) window, 429 + ``Retry-After`` + ``X-RateLimit-*`` headers.

How it is wired
---------------
* ``app.api`` includes every feature router with ``dependencies=[Depends(default_rate_limit)]``
  (``RATE_LIMIT_DEFAULT``, one bucket per client and route). ``/api/health`` and ``/`` are
  not limited.
* Stricter per-route limits are extra dependencies, e.g. the SOS endpoint::

      from fastapi import Depends
      from app.core.rate_limit import sos_rate_limit

      @router.post("/sos", dependencies=[Depends(sos_rate_limit)])
      async def create_sos(body: SOSRequest, ...): ...

  (no special ``request``/``response`` parameters are needed).
* Clients are identified by :func:`client_key`: the authenticated user id when a valid Bearer
  token is present, else the client IP from :func:`client_ip` reduced by :func:`ip_bucket`
  (IPv4 addresses as-is, IPv6 addresses by their ``/64`` network: one subscriber line or
  cloud host controls a whole ``/64`` and could otherwise pick a fresh bucket per request).
  Budgets shared by everyone (sign-in attempts and the bcrypt reserve, SOS SMS) also count
  IPv6 clients per ``/48`` (:func:`ip_prefix_bucket`) with higher limits, because one
  customer often holds a ``/48`` or ``/56`` and could rotate through its ``/64`` networks.
* :func:`client_ip` never trusts a client-supplied address. It uses, in this order:

  1. ``X-ResQ-Client-IP`` — only when the request also carries a valid ``X-Internal-Key``,
     i.e. it comes from our own Next.js server, which resolved the browser's address itself
     (``frontend/lib/client-ip.ts``, honouring the frontend's ``TRUSTED_PROXY_HOPS``);
  2. the ``X-Forwarded-For`` entry added by the closest of ``TRUSTED_PROXY_HOPS`` reverse
     proxies directly in front of the backend (0 = header ignored, the default);
  3. the socket peer address.

  Taking the *first* ``X-Forwarded-For`` hop (as earlier versions did) let anyone pick a
  fresh rate-limit bucket per request by sending the header themselves.
* Successful responses carry ``X-RateLimit-Limit`` / ``-Remaining`` / ``-Reset`` (epoch
  seconds) for the tightest applicable limit; 429 responses add ``Retry-After`` (seconds) and
  use the standard error envelope with code ``rate_limited``.
* :meth:`RateLimiter.hit` is all-or-nothing (a request refused by one limit of
  ``"5/minute;20/hour"`` does not consume the others) and :meth:`RateLimiter.refund` gives
  one hit back, so callers can *reserve* a slot before slow work and return it afterwards
  (the sign-in throttle does this around bcrypt). :class:`ConcurrencyLimiter` caps requests
  in flight per key.
* Tests reset all counters with :func:`reset_rate_limits` (autouse fixture in conftest).
"""

from __future__ import annotations

import hmac
import ipaddress
import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import FastAPI, Request, Response
from limits import RateLimitItem, parse_many
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter

from app.core.config import Settings
from app.core.errors import RateLimitExceeded
from app.core.security import INTERNAL_KEY_HEADER, user_from_request

logger = logging.getLogger(__name__)

LIMIT_HEADER = "X-RateLimit-Limit"
REMAINING_HEADER = "X-RateLimit-Remaining"
RESET_HEADER = "X-RateLimit-Reset"
RETRY_AFTER_HEADER = "Retry-After"
#: End-client address reported by the Next.js server (trusted only with ``X-Internal-Key``).
CLIENT_IP_HEADER = "X-ResQ-Client-IP"
#: ``X-Forwarded-For`` entries considered at most (longer chains are truncated on the left).
MAX_FORWARDED_HOPS = 20

_CLIENT_IP_STATE_ATTR = "_resq_client_ip"


@dataclass(frozen=True, slots=True)
class RateLimitState:
    """Outcome of one :meth:`RateLimiter.hit` for the most relevant limit."""

    allowed: bool
    limit: int
    remaining: int
    #: Epoch seconds at which the oldest hit in the window expires (a slot frees up).
    reset_at: float
    #: Human readable limit, e.g. ``"5 per 1 minute"``.
    description: str

    def retry_after(self, now: float | None = None) -> int:
        """Seconds until the next request may succeed (at least 1)."""
        current = time.time() if now is None else now
        return max(1, math.ceil(self.reset_at - current))

    def headers(self) -> dict[str, str]:
        return {
            LIMIT_HEADER: str(self.limit),
            REMAINING_HEADER: str(max(0, self.remaining)),
            RESET_HEADER: str(math.ceil(self.reset_at)),
        }


class RateLimiter:
    """Moving-window limiter over in-memory storage (per process).

    ``hit(limit, *identifiers)`` accepts ``limits`` strings such as ``"5/minute"`` or
    ``"10/minute;100/hour"``; all of them must allow the request.

    Every method is synchronous: called from the event loop without an ``await`` in between,
    a :meth:`peek` followed by a :meth:`hit` (or several hits on different buckets) is atomic
    with respect to other requests.
    """

    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled
        self._storage = MemoryStorage()
        self._strategy = MovingWindowRateLimiter(self._storage)
        self._parsed: dict[str, list[RateLimitItem]] = {}

    def _items(self, limit: str) -> list[RateLimitItem]:
        items = self._parsed.get(limit)
        if items is None:
            items = parse_many(limit)
            if not items:
                raise ValueError(f"invalid rate limit {limit!r}")
            self._parsed[limit] = items
        return items

    def _state(
        self, item: RateLimitItem, identifiers: tuple[str, ...], allowed: bool
    ) -> RateLimitState:
        reset_at, remaining = self._strategy.get_window_stats(item, *identifiers)
        return RateLimitState(
            allowed=allowed,
            limit=item.amount,
            remaining=remaining,
            reset_at=reset_at,
            description=str(item),
        )

    def hit(self, limit: str, *identifiers: str) -> RateLimitState:
        """Count one request against ``limit`` for ``identifiers`` and report the state.

        All-or-nothing: when any of the limits is exhausted nothing is counted and the
        refusing limit is reported; otherwise every limit is counted and the tightest one is
        reported.
        """
        items = self._items(limit)
        for item in items:
            if not self._strategy.test(item, *identifiers):
                return self._state(item, identifiers, allowed=False)
        tightest: RateLimitState | None = None
        for item in items:
            # Cannot be refused: every limit was tested just above, without an await between.
            self._strategy.hit(item, *identifiers)
            state = self._state(item, identifiers, allowed=True)
            if tightest is None or state.remaining < tightest.remaining:
                tightest = state
        assert tightest is not None  # _items never returns an empty list
        return tightest

    def peek(self, limit: str, *identifiers: str) -> RateLimitState:
        """Like :meth:`hit` but without counting: ``allowed`` = one more hit would pass."""
        tightest: RateLimitState | None = None
        for item in self._items(limit):
            allowed = self._strategy.test(item, *identifiers)
            state = self._state(item, identifiers, allowed=allowed)
            if not allowed:
                return state
            if tightest is None or state.remaining < tightest.remaining:
                tightest = state
        assert tightest is not None  # _items never returns an empty list
        return tightest

    def test(self, limit: str, *identifiers: str) -> bool:
        """``True`` when one more hit would be allowed by every limit (nothing is counted)."""
        return self.peek(limit, *identifiers).allowed

    def count(self, limit: str, *identifiers: str) -> int:
        """Hits currently counted for ``identifiers`` (in the longest window of ``limit``)."""
        return max(
            item.amount - self._strategy.get_window_stats(item, *identifiers)[1]
            for item in self._items(limit)
        )

    def refund(self, limit: str, *identifiers: str) -> None:
        """Give back one earlier :meth:`hit` of ``limit`` for ``identifiers``.

        Used to *reserve* a slot before slow work (``hit``) and return it when the work turns
        out not to count (e.g. the password was correct). The most recent hit is removed,
        which leaves the same count as removing the caller's own one.

        ``limits`` has no public "decrement" for moving windows, so this edits the
        :class:`~limits.storage.MemoryStorage` event lists directly (guarded by the storage's
        own per-key locks); a test pins this behaviour against the installed ``limits``.
        """
        events = getattr(self._storage, "events", None)
        locks = getattr(self._storage, "locks", None)
        if not isinstance(events, dict) or locks is None:  # pragma: no cover - limits changed
            logger.error("Rate limiter storage does not support refunds; hit kept")
            return
        for item in self._items(limit):
            key = item.key_for(*identifiers)
            with locks[key]:
                entries = events.get(key)
                if entries:
                    del entries[0]  # newest first (MemoryStorage inserts at the front)

    def clear(self, limit: str, *identifiers: str) -> None:
        """Forget the counters of ``limit`` for ``identifiers`` (e.g. after a good login)."""
        for item in self._items(limit):
            self._strategy.clear(item, *identifiers)

    def reset(self) -> None:
        """Forget every counter."""
        self._storage.reset()


class ConcurrencyLimiter:
    """Counts requests *in flight* per key (e.g. sign-ins waiting for bcrypt per client).

    Rate limits bound requests per time window; this bounds how many of them may be pending
    at the same moment, so one client cannot occupy a shared queue. Thread-safe.
    """

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._lock = threading.Lock()

    def try_acquire(self, key: str, maximum: int) -> bool:
        """Take a slot for ``key`` unless ``maximum`` are already taken."""
        with self._lock:
            current = self._counts.get(key, 0)
            if current >= maximum:
                return False
            self._counts[key] = current + 1
            return True

    def release(self, key: str) -> None:
        """Give back a slot taken by :meth:`try_acquire` (never goes below zero)."""
        with self._lock:
            current = self._counts.get(key, 0) - 1
            if current > 0:
                self._counts[key] = current
            else:
                self._counts.pop(key, None)

    def in_flight(self, key: str) -> int:
        with self._lock:
            return self._counts.get(key, 0)

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()


class KnownClients:
    """Bounded memory of the clients each account recently signed in from successfully.

    The sign-in throttle admits such a client even while someone else's guessing has
    filled the account's failure buckets (:mod:`app.api.routes.users`). Earlier versions
    kept one marker per (account, client) in :class:`RateLimiter` storage for 30 days with
    no cap (~525 bytes each), so a client rotating through IPv6 ``/64`` networks while
    signing in successfully could grow memory without bound. This store is bounded instead:

    * at most :attr:`per_account` clients per account (the most recently successful ones);
    * at most :attr:`max_accounts` accounts, the least recently successful one evicted first;
    * entries older than :attr:`ttl_seconds` are ignored and dropped when next looked at
      (lazily: no sweeper task; the caps above bound memory in the meantime).

    Only a *successful* sign-in adds an entry, so nobody can push the owner's own clients
    out of an account without its password. Evicting a whole account takes successful
    sign-ins to ``max_accounts`` other accounts; its owner then falls back to the bounded
    overflow escape hatch of the sign-in throttle, so the worst case is a slower sign-in,
    never a lock-out of the owner's other options.

    Keys are opaque ``bytes`` (callers pass short keyed digests, never raw emails or
    addresses). Thread-safe; every operation is O(per_account).
    """

    def __init__(
        self,
        *,
        per_account: int,
        max_accounts: int,
        ttl_seconds: float,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.per_account = per_account
        self.max_accounts = max_accounts
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        # account -> {client: last success (epoch seconds)}; both dicts oldest first.
        self._accounts: OrderedDict[bytes, dict[bytes, float]] = OrderedDict()
        self._lock = threading.Lock()

    def remember(self, account: bytes, client: bytes) -> None:
        """Record a successful sign-in of ``client`` to ``account`` (now)."""
        now = self._clock()
        with self._lock:
            clients = self._accounts.pop(account, None)
            if clients is None:
                clients = {}
            clients.pop(client, None)  # re-insert so it becomes the newest
            clients[client] = now
            while len(clients) > self.per_account:
                del clients[next(iter(clients))]
            self._accounts[account] = clients
            while len(self._accounts) > self.max_accounts:
                self._accounts.popitem(last=False)

    def knows(self, account: bytes, client: bytes) -> bool:
        """``True`` when ``client`` signed in to ``account`` within :attr:`ttl_seconds`."""
        now = self._clock()
        with self._lock:
            clients = self._accounts.get(account)
            seen = clients.get(client) if clients else None
            if clients is None or seen is None:
                return False
            if now - seen <= self.ttl_seconds:
                return True
            # Expired: forget it now (lazy expiry), and the account once it has no clients.
            del clients[client]
            if not clients:
                del self._accounts[account]
            return False

    def __len__(self) -> int:
        """Accounts currently remembered."""
        with self._lock:
            return len(self._accounts)

    def reset(self) -> None:
        with self._lock:
            self._accounts.clear()


#: Process-wide limiter (also exposed as ``app.state.limiter``).
limiter = RateLimiter()
#: Process-wide in-flight counters (see :class:`ConcurrencyLimiter`).
in_flight = ConcurrencyLimiter()
#: Clients that signed in successfully, per account (see :class:`KnownClients`). Remembered
#: for 14 days: long enough to cover how often people sign in again (NextAuth sessions last
#: 30 days, but each device signs in once per session), short enough to keep little state.
known_clients = KnownClients(per_account=8, max_accounts=50_000, ttl_seconds=14 * 86_400)
#: IPv6 clients share one bucket per network of this prefix length (one subscriber line).
IPV6_BUCKET_PREFIX = 64
#: Wider IPv6 network counted *in addition* for the shared budgets (sign-in attempts, the
#: bcrypt reserve, SOS SMS): ISPs and hosting providers commonly hand one customer a ``/48``
#: or ``/56``, i.e. 256 to 65,536 ``/64`` subjects, so per-``/64`` limits alone can be
#: multiplied by rotating networks. Limits on this bucket are set well above the ``/64``
#: ones because a ``/48`` may also be shared by many unrelated users of one carrier.
IPV6_PREFIX_BUCKET = 48


def normalise_ip(value: str | None) -> str | None:
    """Canonical text form of an IPv4/IPv6 address, or ``None`` when ``value`` is not one.

    Accepts the decorations proxies add: ``[2001:db8::1]``, ``[2001:db8::1]:443`` and
    ``203.0.113.7:51234``. IPv4-mapped IPv6 addresses are reduced to IPv4.
    """
    if not value:
        return None
    candidate = value.strip()[:64]
    if candidate.startswith("["):
        candidate = candidate[1:].split("]", 1)[0]
    elif candidate.count(":") == 1:  # IPv4 with a port (IPv6 has several colons)
        candidate = candidate.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return str(address)


def ip_bucket(address: str) -> str:
    """Rate-limit subject for a client address.

    IPv4 addresses are used as-is. IPv6 addresses are reduced to their ``/64`` network
    (``2001:db8:1:2::dead:beef`` -> ``2001:db8:1:2::/64``): ISPs and cloud providers hand
    every subscriber or host at least a ``/64``, so keying on the full address would let a
    single client rotate through 2^64 fresh buckets. Anything that is not an IP address
    (e.g. ``"unknown"``) is returned unchanged.
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return address
    if isinstance(parsed, ipaddress.IPv6Address):
        if parsed.ipv4_mapped is not None:
            return str(parsed.ipv4_mapped)
        return str(ipaddress.IPv6Network((parsed, IPV6_BUCKET_PREFIX), strict=False))
    return str(parsed)


def ip_prefix_bucket(address: str) -> str | None:
    """The wider network of an IPv6 client (``/48``, see :data:`IPV6_PREFIX_BUCKET`).

    ``2001:db8:77:1234::1`` -> ``2001:db8:77::/48``. ``None`` for IPv4 addresses (including
    IPv4-mapped IPv6) and anything that is not an address: there the per-address subject of
    :func:`ip_bucket` is already the whole client, so no wider bucket is counted and nothing
    changes for IPv4 callers.
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return None
    if not isinstance(parsed, ipaddress.IPv6Address) or parsed.ipv4_mapped is not None:
        return None
    return str(ipaddress.IPv6Network((parsed, IPV6_PREFIX_BUCKET), strict=False))


def is_internal_caller(request: Request) -> bool:
    """``True`` when the request carries the correct ``X-Internal-Key`` (our Next.js server).

    Constant-time comparison; ``False`` when ``INTERNAL_API_KEY`` is not configured.
    """
    settings: Settings | None = getattr(request.app.state, "settings", None)
    expected = settings.internal_api_key if settings is not None else ""
    provided = request.headers.get(INTERNAL_KEY_HEADER)
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def forwarded_client_ip(request: Request) -> str | None:
    """The end client's address as reported by the Next.js server, else ``None``.

    Only honoured together with a valid ``X-Internal-Key`` — a browser (or anyone calling
    the backend directly) cannot choose its own address this way.
    """
    reported = request.headers.get(CLIENT_IP_HEADER)
    if not reported or not is_internal_caller(request):
        return None
    return normalise_ip(reported)


def _trusted_proxy_ip(request: Request, hops: int) -> str | None:
    """Address recorded by the outermost of ``hops`` trusted proxies in ``X-Forwarded-For``.

    Each proxy appends the address it received the request from, so with ``hops`` trusted
    proxies in front of us the client is the ``hops``-th entry from the right. Entries left
    of it were written by the client and are ignored.
    """
    header = request.headers.get("x-forwarded-for")
    if hops <= 0 or not header:
        return None
    chain = [hop.strip() for hop in header.split(",") if hop.strip()][-MAX_FORWARDED_HOPS:]
    if not chain:
        return None
    return normalise_ip(chain[max(0, len(chain) - hops)])


def reported_client_ip(request: Request) -> str | None:
    """The end client's address when a trusted party reported it, else ``None``.

    That is our Next.js server (``X-ResQ-Client-IP`` with the internal key) or one of
    ``TRUSTED_PROXY_HOPS`` reverse proxies (``X-Forwarded-For``). ``None`` means only the
    socket peer is known, which for requests relayed by the Next.js server is that server
    itself, shared by every user (signed-in requests always arrive that way).
    """
    settings: Settings | None = getattr(request.app.state, "settings", None)
    hops = settings.trusted_proxy_hops if settings is not None else 0
    return forwarded_client_ip(request) or _trusted_proxy_ip(request, hops)


def client_ip(request: Request) -> str:
    """Best trustworthy client address (see the module docstring); memoised per request."""
    cached = getattr(request.state, _CLIENT_IP_STATE_ATTR, None)
    if cached is not None:
        return cached
    settings: Settings | None = getattr(request.app.state, "settings", None)
    hops = settings.trusted_proxy_hops if settings is not None else 0
    peer = request.client.host if request.client and request.client.host else None
    address = (
        forwarded_client_ip(request)
        or _trusted_proxy_ip(request, hops)
        or normalise_ip(peer)
        or (peer[:64] if peer else "unknown")
    )
    setattr(request.state, _CLIENT_IP_STATE_ATTR, address)
    return address


def client_key(request: Request) -> str:
    """Rate-limit bucket key: ``user:<id>`` for authenticated callers, else ``ip:<bucket>``.

    The address is reduced with :func:`ip_bucket` (IPv6 by ``/64``).
    """
    user = user_from_request(request)
    if user is not None:
        return f"user:{user.id}"
    return f"ip:{ip_bucket(client_ip(request))}"


def _merge_headers(response: Response, headers: dict[str, str]) -> None:
    """Expose the tightest limit when several rate-limit dependencies apply to a route."""
    existing = response.headers.get(REMAINING_HEADER)
    if existing is not None and int(existing) <= int(headers[REMAINING_HEADER]):
        return
    for name, value in headers.items():
        response.headers[name] = value


class RateLimit:
    """FastAPI dependency enforcing a limit taken from the app's settings.

    Args:
        limit_from_settings: returns the limit string, e.g. ``lambda s: s.sos_rate_limit``.
        scope: bucket name; defaults to the matched route path (one bucket per route).
    """

    def __init__(self, limit_from_settings: Callable[[Settings], str], *, scope: str | None = None):
        self.limit_from_settings = limit_from_settings
        self.scope = scope

    async def __call__(self, request: Request, response: Response) -> None:
        active: RateLimiter = getattr(request.app.state, "limiter", limiter)
        if not active.enabled:
            return
        settings: Settings = request.app.state.settings
        route = request.scope.get("route")
        bucket = self.scope or getattr(route, "path", None) or request.url.path
        key = client_key(request)
        state = active.hit(self.limit_from_settings(settings), key, bucket)
        headers = state.headers()
        if not state.allowed:
            headers[RETRY_AFTER_HEADER] = str(state.retry_after())
            logger.warning("Rate limit exceeded (%s) for %s on %s", state.description, key, bucket)
            raise RateLimitExceeded(
                f"Too many requests (limit: {state.description}). Please retry later.",
                headers=headers,
            )
        _merge_headers(response, headers)


#: Default limit for every /api route (``RATE_LIMIT_DEFAULT``), one bucket per route.
default_rate_limit = RateLimit(lambda settings: settings.rate_limit_default)
#: SOS limit (``SOS_RATE_LIMIT``); shared bucket for all SOS endpoints that use it.
sos_rate_limit = RateLimit(lambda settings: settings.sos_rate_limit, scope="sos")
#: Incident reports per user (``INCIDENT_RATE_LIMIT``).
incident_rate_limit = RateLimit(
    lambda settings: settings.incident_rate_limit, scope="incident-create"
)


def reset_rate_limits() -> None:
    """Clear all counters (tests call this before every test)."""
    limiter.reset()
    in_flight.reset()
    known_clients.reset()


def setup_rate_limiting(app: FastAPI, settings: Settings) -> None:
    """Expose the limiter on ``app.state`` (limits are read per request from settings)."""
    limiter.enabled = True
    app.state.limiter = limiter
    logger.debug(
        "Rate limits: default=%s sos=%s", settings.rate_limit_default, settings.sos_rate_limit
    )
