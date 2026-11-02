"""Email/password users (bcrypt), used by the internal ``/api/users/*`` endpoints.

Password hashing
----------------
bcrypt only looks at the first 72 bytes of its input (bcrypt 5 even *rejects* longer input),
while the API accepts passwords up to 128 characters (up to 512 UTF-8 bytes). Every password
is therefore pre-hashed with HMAC-SHA256 and base64-encoded (44 ASCII bytes, no NUL bytes)
before bcrypt — the same construction as passlib's ``bcrypt_sha256``. The stored value is a
regular ``$2b$`` bcrypt hash.

bcrypt is deliberately slow (~0.25 s at cost 12), so hashing and checking run in worker
threads instead of blocking the event loop — on a small **dedicated** pool
(:data:`BCRYPT_WORKERS` threads), not the loop's default executor, so a flood of sign-ins or
registrations queues behind itself and can never delay emergency work (SOS SMS and web push
have their own pools as well).

Bounded work, no held connections
---------------------------------
* At most :data:`BCRYPT_MAX_PENDING` bcrypt jobs (running + queued) are admitted at once;
  further sign-ins/registrations get ``503 service_busy`` with ``Retry-After`` straight away
  (:class:`PasswordHashingBusyError`) instead of queueing without limit.
* No database connection is held while waiting for bcrypt: the lookup's transaction is
  ended (``commit()`` returns the pooled connection) *before* the bcrypt job is queued.
  Earlier versions kept the connection checked out for the whole wait, so a burst of
  anonymous sign-in requests could exhaust the pool and stall every other endpoint
  (including SOS) for the pool timeout.

Timing
------
:func:`verify_user` performs a bcrypt check even when the email is unknown (against a dummy
hash with the same cost), so response times do not reveal which addresses are registered.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass

import bcrypt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, InvalidInputError, ServiceBusyError
from app.db.models import User
from app.schemas.users import normalize_email

logger = logging.getLogger(__name__)

#: bcrypt work factor (tests lower it to keep the suite fast).
BCRYPT_ROUNDS = 12
#: Domain-separation key of the HMAC pre-hash (not a secret).
_PREHASH_KEY = b"resq-ai/bcrypt-sha256/v1"

#: Threads of the dedicated bcrypt pool.
BCRYPT_WORKERS = 2
#: bcrypt jobs admitted at once (running + queued). At cost 12 the last one waits about
#: ``BCRYPT_MAX_PENDING * 0.25 s / BCRYPT_WORKERS`` (~4 s); more are refused with 503.
BCRYPT_MAX_PENDING = 32

_dummy_hash: tuple[int, bytes] | None = None
_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()
_pending = 0
_pending_lock = threading.Lock()


class PasswordHashingBusyError(ServiceBusyError):
    """Too many sign-ins/registrations are waiting for bcrypt (503 ``service_busy``)."""

    default_message = "Too many sign-in requests right now. Please retry in a few seconds."


@dataclass(frozen=True, slots=True)
class VerifiedUser:
    """The identity returned by :func:`verify_user` (a plain value, no ORM session)."""

    id: str
    email: str
    name: str


def _bcrypt_executor() -> ThreadPoolExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(
                max_workers=BCRYPT_WORKERS, thread_name_prefix="resq-bcrypt"
            )
        return _executor


def pending_bcrypt_jobs() -> int:
    """bcrypt jobs currently running or queued (for tests and diagnostics)."""
    with _pending_lock:
        return _pending


def _release_slot(_future: Future[object] | None = None) -> None:
    global _pending
    with _pending_lock:
        _pending = max(0, _pending - 1)


async def _run_bcrypt[T](fn: Callable[..., T], *args: object) -> T:
    """Run a blocking bcrypt call on the dedicated pool (bounded queue).

    Raises:
        PasswordHashingBusyError: :data:`BCRYPT_MAX_PENDING` jobs are already admitted.
    """
    global _pending
    with _pending_lock:
        if _pending >= BCRYPT_MAX_PENDING:
            logger.warning("bcrypt queue full (%d jobs); refusing request", _pending)
            raise PasswordHashingBusyError()
        _pending += 1
    try:
        future = _bcrypt_executor().submit(fn, *args)
    except BaseException:
        _release_slot()
        raise
    # The slot is released when the job really finishes (or is cancelled before it starts),
    # not when the awaiting request goes away: a running bcrypt job keeps its thread busy.
    future.add_done_callback(_release_slot)
    return await asyncio.wrap_future(future)


def shutdown_executor() -> None:
    """Stop the bcrypt pool (app shutdown); it is recreated on next use."""
    global _executor
    with _executor_lock:
        executor, _executor = _executor, None
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)


def _prehash(password: str) -> bytes:
    """HMAC-SHA256 + base64 of the password (44 ASCII bytes, safe for bcrypt)."""
    digest = hmac.new(_PREHASH_KEY, password.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest)


def hash_password(password: str, rounds: int | None = None) -> str:
    """Return the bcrypt hash (``$2b$...``) of ``password`` — CPU bound, blocking."""
    salt = bcrypt.gensalt(rounds=rounds or BCRYPT_ROUNDS)
    return bcrypt.hashpw(_prehash(password), salt).decode("ascii")


def check_password(password: str, password_hash: str) -> bool:
    """Constant-time check of ``password`` against a stored hash — blocking; never raises."""
    try:
        return bcrypt.checkpw(_prehash(password), password_hash.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        logger.error("Stored password hash is malformed; rejecting login")
        return False


def _dummy_password_hash() -> bytes:
    """A hash with the current cost, used to burn equal time for unknown emails."""
    global _dummy_hash
    if _dummy_hash is None or _dummy_hash[0] != BCRYPT_ROUNDS:
        hashed = hash_password("resq-ai-timing-equaliser", BCRYPT_ROUNDS).encode("ascii")
        _dummy_hash = (BCRYPT_ROUNDS, hashed)
    return _dummy_hash[1]


def _burn_check(password: str) -> None:
    bcrypt.checkpw(_prehash(password), _dummy_password_hash())


def _normalise(email: str) -> str:
    try:
        return normalize_email(email)
    except ValueError as exc:
        raise InvalidInputError("Invalid email address.") from exc


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    """Lookup by (normalised) email."""
    return await session.scalar(select(User).where(User.email == _normalise(email)))


async def _end_transaction(session: AsyncSession) -> None:
    """End the read transaction so the pooled connection is returned before slow work."""
    await session.commit()


async def register_user(session: AsyncSession, email: str, password: str, name: str) -> User:
    """Create a user (email normalised, bcrypt hash) and commit.

    The duplicate check's transaction is ended before hashing, so no database connection is
    held while the bcrypt job waits; a concurrent registration of the same address is still
    caught by the unique index (409).

    Raises:
        ConflictError: email already registered (409).
        InvalidInputError: malformed email / blank name (422; normally caught by the schema).
        PasswordHashingBusyError: the bcrypt queue is full (503).
    """
    normalised = _normalise(email)
    clean_name = " ".join((name or "").split())[:80]
    if not clean_name:
        raise InvalidInputError("Name must not be blank.")

    exists = await session.scalar(select(User.id).where(User.email == normalised)) is not None
    await _end_transaction(session)
    if exists:
        logger.info("Registration rejected: email already registered")
        raise ConflictError("An account with this email already exists.")

    password_hash = await _run_bcrypt(hash_password, password)
    user = User(email=normalised, name=clean_name, password_hash=password_hash)
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as exc:
        # Lost a race with a concurrent registration of the same address.
        await session.rollback()
        raise ConflictError("An account with this email already exists.") from exc
    logger.info("Registered user %s", user.id)
    return user


async def verify_user(session: AsyncSession, email: str, password: str) -> VerifiedUser | None:
    """Return the user when the credentials match (constant-time), else ``None``.

    The lookup's transaction is ended before bcrypt runs (no pooled connection is held
    while the job waits in the bcrypt queue).

    Raises:
        PasswordHashingBusyError: the bcrypt queue is full (503).
    """
    try:
        normalised = normalize_email(email)
    except ValueError:
        await _run_bcrypt(_burn_check, password)
        return None

    user = await session.scalar(select(User).where(User.email == normalised))
    found = (
        None
        if user is None
        else (VerifiedUser(id=user.id, email=user.email, name=user.name), user.password_hash)
    )
    await _end_transaction(session)

    if found is None:
        await _run_bcrypt(_burn_check, password)
        logger.info("Login failed: unknown email")
        return None
    identity, password_hash = found
    if not await _run_bcrypt(check_password, password, password_hash):
        logger.info("Login failed: wrong password for user %s", identity.id)
        return None
    return identity


__all__ = [
    "BCRYPT_MAX_PENDING",
    "BCRYPT_ROUNDS",
    "BCRYPT_WORKERS",
    "PasswordHashingBusyError",
    "VerifiedUser",
    "check_password",
    "get_user_by_email",
    "hash_password",
    "pending_bcrypt_jobs",
    "register_user",
    "shutdown_executor",
    "verify_user",
]
