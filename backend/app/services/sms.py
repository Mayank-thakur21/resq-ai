"""SMS delivery through Twilio (used by ``POST /api/sos``).

The Twilio Python SDK is synchronous (``requests`` under the hood), so every send runs in a
worker thread. SMS uses its **own** :class:`~concurrent.futures.ThreadPoolExecutor` (never the
event loop's default pool, which web-push deliveries, bcrypt and other ``to_thread`` users
share), so no other workload can delay an SOS.

Timing (the Next.js proxy gives up after 20 s, and a user who sees "failed" retries, which
texts every contact again):

* The pool has :data:`SMS_WORKER_THREADS` threads, shared by all concurrent SOS requests
  (Twilio calls are I/O bound): several simultaneous SOS of 10 contacts each are sent in one
  wave instead of queueing behind each other.
* Each Twilio request has a ``(connect, read)`` timeout of
  :data:`TWILIO_CONNECT_TIMEOUT_SECONDS` / :data:`TWILIO_READ_TIMEOUT_SECONDS` (a plain
  number would apply to *each* phase, doubling the worst case).
* :meth:`SMSService.send_bulk` has an overall deadline (:data:`SEND_DEADLINE_SECONDS`).
  Numbers whose send had not started by then are cancelled and reported as not sent; sends
  still in flight are reported as unconfirmed. Both land in ``failed`` (so the UI offers the
  phone's own SMS app for them) and the SOS response always arrives in time.

Abuse budgets (checked and consumed atomically before a number is handed to Twilio):

* ``SOS_SMS_PER_NUMBER_LIMIT`` per destination (keyed hash of the number) — nobody can
  flood one phone, whatever their address;
* ``SOS_SMS_PER_CLIENT_LIMIT`` per caller (signed-in user id, else the client address with
  IPv6 reduced to its /64) — one caller cannot use up the shared budgets with made-up
  numbers;
* ``SOS_SMS_PER_ADDRESS_LIMIT`` per client address (IPv6 by /64) for everyone sending from
  it, signed in or not — accounts are cheap to create (no email verification), so without
  it a dozen accounts registered from one address could spend the whole global budget;
* ``SOS_SMS_PER_PREFIX_LIMIT`` per IPv6 ``/48`` (all its ``/64`` addresses together) — one
  customer commonly holds a ``/48``, so without it accounts spread over its ``/64``
  networks would each get a fresh per-address budget (IPv4 has no wider bucket);
* ``SOS_SMS_ANONYMOUS_LIMIT`` for all anonymous callers together — a smaller pool, so
  anonymous traffic can never drain what signed-in users need;
* ``SOS_SMS_NEW_CALLER_LIMIT`` for anonymous callers and recently registered accounts
  together (``established=False``) — set below the global budget, so the rest of it stays
  reserved for established accounts: brand-new accounts, however many and from however
  many networks, cannot use up the whole budget;
* ``SOS_SMS_GLOBAL_LIMIT`` for the whole server (caps the operator's Twilio bill). A
  distributed caller (many addresses, many established accounts) can still use it up: it
  is a bill guard, and over budget every contact still gets the native-SMS fallback.

When Twilio *rejects* a message (``TwilioRestException``: invalid number, unroutable region,
...), no message was created and nothing is billed, so the shared budgets (anonymous,
new-caller and global) are refunded; the caller's own budgets (client, address, prefix) and
the destination's stay charged. Sends cancelled before they started are refunded entirely.
Each send is charged once in :meth:`SMSService._reserve` and settled exactly once in
:meth:`SMSService.send_bulk` (sent, rejected, cancelled or unconfirmed), so no budget is
ever refunded twice.

Numbers over budget are reported in ``failed`` (the UI then offers the phone's own SMS app
through ``fallback_sms_uri``) instead of failing the whole SOS.

Thread safety: the SDK's HTTP client wraps a ``requests.Session`` which is not guaranteed to
be thread-safe, so each worker thread lazily builds and keeps its *own* Twilio client
(:class:`threading.local`). Executor threads are reused, so connections are still pooled.
Budget bookkeeping only ever happens on the event loop.

Privacy: full phone numbers never leave this module — results carry masked numbers
(``+91******3210``) and Twilio error texts are scrubbed because they often echo the number.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Protocol

from twilio.base.exceptions import TwilioRestException
from twilio.http.http_client import TwilioHttpClient
from twilio.rest import Client as TwilioClient

from app.core.config import Settings
from app.core.logging import mask_phone
from app.core.rate_limit import RateLimiter
from app.core.rate_limit import limiter as default_limiter
from app.core.security import hash_identifier
from app.schemas.sos import SMSFailed, SMSResult, SMSSent

logger = logging.getLogger(__name__)

#: Worker threads shared by every SOS (Twilio calls are I/O bound; an SOS has at most 10
#: contacts, so this sends ~3 simultaneous SOS in a single wave).
SMS_WORKER_THREADS = 32
#: Backwards-compatible alias (earlier versions sized the pool for exactly one SOS).
MAX_CONCURRENT_SENDS = SMS_WORKER_THREADS
#: Twilio request timeouts in seconds: TCP/TLS connect, then waiting for the answer.
TWILIO_CONNECT_TIMEOUT_SECONDS = 3.0
TWILIO_READ_TIMEOUT_SECONDS = 5.0
#: Overall time :meth:`SMSService.send_bulk` may take (keeps the SOS response well inside the
#: Next.js proxy's 20 s upstream timeout, with room for the audit write).
SEND_DEADLINE_SECONDS = 12.0
#: Client-visible error texts are truncated to this many characters.
MAX_ERROR_CHARS = 200

#: Shown for a number whose per-destination budget is used up.
NUMBER_BUDGET_ERROR = (
    "Too many SOS messages were sent to this number recently. "
    "Send it from your phone's SMS app instead."
)
#: Shown when the caller's own SMS budget is used up.
CLIENT_BUDGET_ERROR = (
    "You have sent many SOS text messages recently. Send it from your phone's SMS app instead."
)
#: Shown when the budget of the caller's address or IPv6 network (all its users together) is
#: used up.
ADDRESS_BUDGET_ERROR = (
    "Many SOS text messages were sent from your network recently. "
    "Send it from your phone's SMS app instead."
)
#: Shown when the budget shared by all anonymous callers is used up.
ANONYMOUS_BUDGET_ERROR = (
    "The SOS SMS service is at capacity for guests right now. "
    "Sign in, or send it from your phone's SMS app instead."
)
#: Shown when the server-wide SMS budget, or the part of it open to new callers, is used up
#: (one text: the reserve for established accounts is not advertised).
GLOBAL_BUDGET_ERROR = (
    "The SOS SMS service is at capacity right now. Send it from your phone's SMS app instead."
)
#: Shown when the send never started before the deadline (nothing was sent).
NOT_SENT_IN_TIME_ERROR = (
    "The SMS service was too busy to send this in time. Send it from your phone's SMS app instead."
)
#: Shown when the send was still in flight at the deadline (it may or may not arrive).
UNCONFIRMED_ERROR = (
    "Delivery could not be confirmed in time and the message may still arrive. "
    "Send it from your phone's SMS app too."
)


@dataclass(frozen=True, slots=True)
class _Charge:
    """One budget a send was counted against (refundable)."""

    limit: str
    identifiers: tuple[str, ...]
    #: Shared budgets (anonymous pool, new-caller pool, global) are refunded when Twilio
    #: rejects the message.
    shared: bool


@dataclass(frozen=True, slots=True)
class _Caller:
    """Who is sending, as far as the budgets are concerned (see :meth:`SMSService.send_bulk`)."""

    client_key: str | None
    address_key: str | None
    prefix_key: str | None
    anonymous: bool
    established: bool


#: Budgets shared by the whole server: running out of them is logged as an error.
_SERVER_WIDE_BUDGETS = frozenset({"sos-sms-global", "sos-sms-new-callers"})


class BoundedTwilioHttpClient(TwilioHttpClient):
    """Twilio HTTP client with a ``(connect, read)`` timeout tuple.

    ``TwilioHttpClient`` only validates a single number, but hands ``self.timeout`` to
    ``requests`` unchanged, which accepts a ``(connect, read)`` tuple.
    """

    def __init__(self, connect_timeout: float, read_timeout: float) -> None:
        super().__init__(timeout=read_timeout)
        self.timeout = (connect_timeout, read_timeout)  # type: ignore[assignment]


class _MessageResource(Protocol):
    """The subset of ``twilio.rest...MessageList`` we use (``client.messages``)."""

    def create(self, **kwargs: Any) -> Any: ...


class SupportsMessages(Protocol):
    """Anything with ``messages.create(...)`` like :class:`twilio.rest.Client` (or a fake)."""

    @property
    def messages(self) -> _MessageResource: ...


#: Builds a Twilio(-compatible) client; called at most once per worker thread.
ClientFactory = Callable[[], SupportsMessages]


def _scrub(text: str, number: str) -> str:
    """Replace every occurrence of ``number`` (with and without ``+``) by its masked form."""
    masked = mask_phone(number)
    scrubbed = text.replace(number, masked)
    bare = number.lstrip("+")
    if bare:
        scrubbed = scrubbed.replace(bare, masked.lstrip("+"))
    return scrubbed


def _twilio_error_message(exc: TwilioRestException, number: str) -> str:
    """Human-readable, number-free description of a Twilio API error."""
    detail = _scrub(str(exc.msg or "request rejected"), number).strip()
    prefix = f"Twilio error {exc.code}" if exc.code else f"Twilio HTTP {exc.status}"
    return f"{prefix}: {detail}"[:MAX_ERROR_CHARS]


class SMSService:
    """Sends SOS SMS messages via Twilio.

    Args:
        settings: Application settings (``TWILIO_*``, ``SOS_SMS_*``).
        client_factory: Optional factory for the Twilio client (tests inject fakes). The
            default builds ``twilio.rest.Client`` with a bounded request timeout.
        limiter: Rate limiter holding the SMS budgets (defaults to the process-wide one,
            which tests reset between cases).
    """

    def __init__(
        self,
        settings: Settings,
        *,
        client_factory: ClientFactory | None = None,
        limiter: RateLimiter | None = None,
    ) -> None:
        self.settings = settings
        self._client_factory: ClientFactory = client_factory or self._default_client
        self._local = threading.local()
        self._limiter = limiter or default_limiter
        self._executor: ThreadPoolExecutor | None = None
        self._executor_lock = threading.Lock()
        #: Overall deadline of :meth:`send_bulk` in seconds (tests shorten it).
        self.deadline_seconds = SEND_DEADLINE_SECONDS

    # ------------------------------------------------------------------------------------------
    # configuration
    # ------------------------------------------------------------------------------------------
    @property
    def configured(self) -> bool:
        """``True`` when Twilio credentials and a sender (number or messaging service) are set."""
        return self.settings.twilio_enabled

    def _sender_kwargs(self) -> dict[str, str]:
        """``messaging_service_sid`` wins over ``from_`` (Twilio picks the best sender then)."""
        if self.settings.twilio_messaging_service_sid:
            return {"messaging_service_sid": self.settings.twilio_messaging_service_sid}
        return {"from_": self.settings.twilio_from_number}

    def _default_client(self) -> SupportsMessages:
        read_timeout = min(self.settings.http_timeout_seconds, TWILIO_READ_TIMEOUT_SECONDS)
        connect_timeout = min(read_timeout, TWILIO_CONNECT_TIMEOUT_SECONDS)
        return TwilioClient(
            self.settings.twilio_account_sid,
            self.settings.twilio_auth_token,
            http_client=BoundedTwilioHttpClient(connect_timeout, read_timeout),
        )

    def _get_executor(self) -> ThreadPoolExecutor:
        """Dedicated worker pool shared by all SOS requests (created lazily)."""
        with self._executor_lock:
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=SMS_WORKER_THREADS, thread_name_prefix="resq-sms"
                )
            return self._executor

    def close(self) -> None:
        """Release the worker threads (app shutdown); sends still queued are cancelled."""
        with self._executor_lock:
            executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    def _thread_client(self) -> SupportsMessages:
        """The calling worker thread's own client (created on first use)."""
        client: SupportsMessages | None = getattr(self._local, "client", None)
        if client is None:
            client = self._client_factory()
            self._local.client = client
        return client

    # ------------------------------------------------------------------------------------------
    # sending
    # ------------------------------------------------------------------------------------------
    def _hash(self, purpose: str, value: str) -> str:
        """Keyed hash: the limiter's memory never holds phone numbers or client ids."""
        secret = self.settings.backend_jwt_secret or self.settings.internal_api_key or "resq-ai"
        return hash_identifier(value, f"{purpose}:{secret}")

    def _number_key(self, number: str) -> str:
        return self._hash("sos-sms-number", number)

    def _budget_charges(self, number: str, caller: _Caller) -> list[tuple[_Charge, str]]:
        """Budgets a send to ``number`` counts against, each with its refusal message.

        Ordered from the narrowest to the widest, so a refusal names the most specific
        reason (and is logged as such).
        """
        settings = self.settings
        client_key, address_key = caller.client_key, caller.address_key
        charges = [
            (
                _Charge(
                    settings.sos_sms_per_number_limit,
                    ("sos-sms-number", self._number_key(number)),
                    shared=False,
                ),
                NUMBER_BUDGET_ERROR,
            )
        ]
        if client_key:
            charges.append(
                (
                    _Charge(
                        settings.sos_sms_per_client_limit,
                        ("sos-sms-client", self._hash("sos-sms-client", client_key)),
                        shared=False,
                    ),
                    CLIENT_BUDGET_ERROR,
                )
            )
        if address_key:
            charges.append(
                (
                    _Charge(
                        settings.sos_sms_per_address_limit,
                        ("sos-sms-address", self._hash("sos-sms-address", address_key)),
                        shared=False,
                    ),
                    ADDRESS_BUDGET_ERROR,
                )
            )
        if caller.prefix_key:
            charges.append(
                (
                    _Charge(
                        settings.sos_sms_per_prefix_limit,
                        ("sos-sms-prefix", self._hash("sos-sms-prefix", caller.prefix_key)),
                        shared=False,
                    ),
                    ADDRESS_BUDGET_ERROR,
                )
            )
        if caller.anonymous:
            charges.append(
                (
                    _Charge(settings.sos_sms_anonymous_limit, ("sos-sms-anonymous",), shared=True),
                    ANONYMOUS_BUDGET_ERROR,
                )
            )
        if not caller.established:
            charges.append(
                (
                    _Charge(
                        settings.sos_sms_new_caller_limit, ("sos-sms-new-callers",), shared=True
                    ),
                    GLOBAL_BUDGET_ERROR,
                )
            )
        charges.append(
            (
                _Charge(settings.sos_sms_global_limit, ("sos-sms-global",), shared=True),
                GLOBAL_BUDGET_ERROR,
            )
        )
        return charges

    def _reserve(self, number: str, caller: _Caller) -> list[_Charge] | SMSFailed:
        """Count ``number`` against every budget, or an :class:`SMSFailed` when over one.

        Runs on the event loop without awaiting, so test-then-hit is atomic. All budgets
        are checked before any is consumed: a number refused by one budget uses up none.
        """
        if not self._limiter.enabled:
            return []
        masked = mask_phone(number)
        charges = self._budget_charges(number, caller)
        for charge, error in charges:
            if not self._limiter.test(charge.limit, *charge.identifiers):
                level = (
                    logging.ERROR
                    if charge.identifiers[0] in _SERVER_WIDE_BUDGETS
                    else logging.WARNING
                )
                logger.log(
                    level, "SOS SMS to %s skipped: %s budget used up", masked, charge.identifiers[0]
                )
                return SMSFailed(to=masked, error=error)
        for charge, _ in charges:
            self._limiter.hit(charge.limit, *charge.identifiers)
        return [charge for charge, _ in charges]

    def _refund(self, charges: Sequence[_Charge], *, shared_only: bool) -> None:
        for charge in charges:
            if charge.shared or not shared_only:
                self._limiter.refund(charge.limit, *charge.identifiers)

    def _send_one_sync(self, number: str, body: str) -> tuple[SMSSent | SMSFailed, bool]:
        """Blocking send of one message (runs in a worker thread); never raises.

        Returns the outcome and whether Twilio *rejected* the message (no message created,
        nothing billed — the shared budgets can be refunded).
        """
        masked = mask_phone(number)
        try:
            message = self._thread_client().messages.create(
                body=body, to=number, **self._sender_kwargs()
            )
        except TwilioRestException as exc:
            error = _twilio_error_message(exc, number)
            logger.warning("SOS SMS to %s rejected by Twilio: %s", masked, error)
            return SMSFailed(to=masked, error=error), True
        except Exception as exc:  # network errors, SDK bugs ... must not abort the SOS
            # Only the exception *type* is logged: messages/tracebacks may contain the number.
            # Not refunded: the request may have reached Twilio before the connection broke.
            logger.warning("SOS SMS to %s failed (%s)", masked, type(exc).__name__)
            return SMSFailed(to=masked, error="SMS provider unreachable, please retry."), False

        sid = str(getattr(message, "sid", "") or "")
        status = str(getattr(message, "status", "") or "queued")
        logger.info("SOS SMS to %s accepted by Twilio (sid=%s, status=%s)", masked, sid, status)
        return SMSSent(to=masked, sid=sid, status=status), False

    async def send_bulk(
        self,
        numbers: Sequence[str],
        body: str,
        *,
        client_key: str | None = None,
        address_key: str | None = None,
        prefix_key: str | None = None,
        anonymous: bool = False,
        established: bool = False,
    ) -> SMSResult:
        """Send ``body`` to every E.164 number; per-number failures are reported, not raised.

        Args:
            numbers: Validated/normalised E.164 numbers (``SOSRequest`` does that);
                duplicates and blanks are ignored.
            body: The SMS text.
            client_key: The caller's rate-limit identity (``user:<id>`` / ``ip:<bucket>``,
                see :func:`app.core.rate_limit.client_key`) for the per-client budget;
                ``None`` skips that budget.
            address_key: The caller's client address bucket (``ip:<bucket>``) for the
                per-address budget, shared by every caller on that address; ``None`` (the
                address is unknown) skips that budget.
            prefix_key: The caller's IPv6 ``/48`` (``net:<prefix>``) for the per-prefix
                budget; ``None`` (IPv4 or unknown address) skips that budget.
            anonymous: The caller is not signed in (also counts against the anonymous pool).
            established: The caller is an established account; everyone else (anonymous
                callers included) also counts against the new-caller pool and so cannot
                use the part of the global budget reserved for established accounts.

        Results keep the input order and carry masked numbers. When Twilio is not
        configured nothing is sent and ``configured`` is ``False``. Returns within
        :attr:`deadline_seconds` (plus scheduling noise) whatever Twilio does.
        """
        if not self.configured:
            logger.info("Twilio is not configured; skipping %d SOS SMS", len(numbers))
            return SMSResult(configured=False)

        unique = list(dict.fromkeys(n for n in numbers if n))
        if not unique:
            return SMSResult(configured=True)

        caller = _Caller(client_key, address_key, prefix_key, anonymous, established)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.deadline_seconds
        executor = self._get_executor()

        outcomes: dict[str, SMSSent | SMSFailed] = {}
        jobs: dict[str, tuple[Future[tuple[SMSSent | SMSFailed, bool]], list[_Charge]]] = {}
        for number in unique:
            reserved = self._reserve(number, caller)
            if isinstance(reserved, SMSFailed):
                outcomes[number] = reserved
                continue
            jobs[number] = (executor.submit(self._send_one_sync, number, body), reserved)

        if jobs:
            waiters = {number: asyncio.wrap_future(job) for number, (job, _) in jobs.items()}
            await asyncio.wait(waiters.values(), timeout=max(0.0, deadline - loop.time()))
            for number, (job, charges) in jobs.items():
                # Classify on the job itself: the asyncio wrapper only learns the result
                # through a callback on the loop, so a send that finished in its thread just
                # before the deadline can still look pending there.
                if job.done() and not job.cancelled():
                    outcome, rejected = job.result()
                    if rejected:
                        self._refund(charges, shared_only=True)
                    outcomes[number] = outcome
                elif job.cancel():
                    # Still queued behind other sends: never sent, so nothing is charged.
                    self._refund(charges, shared_only=False)
                    logger.warning(
                        "SOS SMS to %s not sent: deadline reached in the queue", mask_phone(number)
                    )
                    outcomes[number] = SMSFailed(
                        to=mask_phone(number), error=NOT_SENT_IN_TIME_ERROR
                    )
                else:
                    logger.warning(
                        "SOS SMS to %s still in flight at the deadline", mask_phone(number)
                    )
                    outcomes[number] = SMSFailed(to=mask_phone(number), error=UNCONFIRMED_ERROR)

        ordered = [outcomes[number] for number in unique]
        result = SMSResult(
            configured=True,
            sent=[o for o in ordered if isinstance(o, SMSSent)],
            failed=[o for o in ordered if isinstance(o, SMSFailed)],
        )
        logger.info(
            "SOS SMS fan-out finished: %d sent, %d failed", len(result.sent), len(result.failed)
        )
        return result


__all__ = [
    "ADDRESS_BUDGET_ERROR",
    "ANONYMOUS_BUDGET_ERROR",
    "CLIENT_BUDGET_ERROR",
    "GLOBAL_BUDGET_ERROR",
    "MAX_CONCURRENT_SENDS",
    "NOT_SENT_IN_TIME_ERROR",
    "NUMBER_BUDGET_ERROR",
    "SEND_DEADLINE_SECONDS",
    "SMS_WORKER_THREADS",
    "UNCONFIRMED_ERROR",
    "BoundedTwilioHttpClient",
    "ClientFactory",
    "SMSService",
    "SupportsMessages",
]
