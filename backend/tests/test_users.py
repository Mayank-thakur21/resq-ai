"""Tests for the internal users API (``/api/users/*``) and :mod:`app.services.users`."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ConflictError, InvalidInputError
from app.db.models import User
from app.main import create_app
from app.services import users as user_service


@pytest.fixture(autouse=True)
def _fast_bcrypt(monkeypatch: pytest.MonkeyPatch) -> None:
    """Cost 4 keeps the suite fast; production uses ``BCRYPT_ROUNDS = 12``."""
    monkeypatch.setattr(user_service, "BCRYPT_ROUNDS", 4)


def register(
    client: TestClient, headers: dict[str, str], **overrides: Any
) -> Any:  # httpx2 Response
    payload = {"email": "Asha@Example.COM ", "password": "correct horse 42", "name": "Asha  Rao"}
    payload.update(overrides)
    return client.post("/api/users/register", json=payload, headers=headers)


def verify(client: TestClient, headers: dict[str, str], email: str, password: str) -> Any:
    return client.post(
        "/api/users/verify", json={"email": email, "password": password}, headers=headers
    )


def stored_users(run_db: Callable[..., Any]) -> list[User]:
    async def _query(session: AsyncSession) -> list[User]:
        return list(await session.scalars(select(User)))

    return run_db(_query)


# ----------------------------------------------------------------------------------------------
# Register
# ----------------------------------------------------------------------------------------------
def test_register_creates_user(
    client: TestClient, internal_headers: dict[str, str], run_db: Callable
) -> None:
    response = register(client, internal_headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {"id": body["id"], "email": "asha@example.com", "name": "Asha Rao"}

    [user] = stored_users(run_db)
    assert user.id == body["id"]
    assert user.email == "asha@example.com"
    assert user.password_hash.startswith("$2b$04$")
    assert "correct horse" not in user.password_hash
    assert user.created_at.tzinfo is not None


def test_register_duplicate_email_is_409(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    assert register(client, internal_headers).status_code == 201
    duplicate = register(client, internal_headers, email="  ASHA@example.com", name="Other")
    assert duplicate.status_code == 409
    error = duplicate.json()["error"]
    assert error["code"] == "conflict"
    assert "already exists" in error["message"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"email": "not-an-email"},
        {"email": "a@b"},
        {"password": "short"},
        {"password": "x" * 129},
        {"name": ""},
        {"name": "   "},
        {"name": "n" * 81},
    ],
)
def test_register_validation(
    client: TestClient, internal_headers: dict[str, str], overrides: dict[str, Any]
) -> None:
    response = register(client, internal_headers, **overrides)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# ----------------------------------------------------------------------------------------------
# Verify
# ----------------------------------------------------------------------------------------------
def test_verify_valid_credentials(client: TestClient, internal_headers: dict[str, str]) -> None:
    user_id = register(client, internal_headers).json()["id"]
    response = verify(client, internal_headers, " ASHA@example.com", "correct horse 42")
    assert response.status_code == 200
    assert response.json() == {"id": user_id, "email": "asha@example.com", "name": "Asha Rao"}


@pytest.mark.parametrize(
    ("email", "password"),
    [
        ("asha@example.com", "wrong password"),
        ("asha@example.com", "correct horse 42 "),  # passwords are used verbatim
        ("asha@example.com", "Correct horse 42"),
        ("nobody@example.com", "correct horse 42"),
    ],
)
def test_verify_bad_credentials_is_generic_401(
    client: TestClient, internal_headers: dict[str, str], email: str, password: str
) -> None:
    register(client, internal_headers)
    response = verify(client, internal_headers, email, password)
    assert response.status_code == 401
    error = response.json()["error"]
    assert error["code"] == "unauthorized"
    assert error["message"] == "Invalid email or password."


def test_verify_validation(client: TestClient, internal_headers: dict[str, str]) -> None:
    response = verify(client, internal_headers, "nope", "whatever")
    assert response.status_code == 422
    response = client.post(
        "/api/users/verify", json={"email": "a@example.com"}, headers=internal_headers
    )
    assert response.status_code == 422


def test_long_passwords_are_not_truncated(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    """bcrypt alone only sees 72 bytes; the HMAC pre-hash makes every character count."""
    password = "é" * 100 + "A"  # 201 UTF-8 bytes
    assert register(client, internal_headers, password=password).status_code == 201
    assert verify(client, internal_headers, "asha@example.com", password).status_code == 200
    almost = "é" * 100 + "B"
    assert verify(client, internal_headers, "asha@example.com", almost).status_code == 401


def from_client(ip: str, internal_headers: dict[str, str]) -> dict[str, str]:
    """Headers of a call made by the Next.js server on behalf of the browser at ``ip``."""
    return {**internal_headers, "X-ResQ-Client-IP": ip}


def test_verify_throttles_failed_attempts_per_client_and_account(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    register(client, internal_headers)
    attacker = from_client("203.0.113.66", internal_headers)
    owner = from_client("198.51.100.7", internal_headers)
    for _ in range(5):
        assert verify(client, attacker, "asha@example.com", "guess").status_code == 401

    limited = verify(client, attacker, "ASHA@example.com", "correct horse 42")
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert int(limited.headers["retry-after"]) >= 1

    # The real owner (another address) still signs in: someone else's guessing never
    # locks out a correct password.
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200

    # Other accounts are unaffected for the attacker's address too.
    register(client, internal_headers, email="ravi@example.com")
    assert verify(client, attacker, "ravi@example.com", "correct horse 42").status_code == 200


def test_successful_sign_in_forgives_earlier_typos(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    register(client, internal_headers)
    me = from_client("198.51.100.7", internal_headers)
    for _ in range(4):
        assert verify(client, me, "asha@example.com", "typo").status_code == 401
    assert verify(client, me, "asha@example.com", "correct horse 42").status_code == 200
    for _ in range(4):  # counter was cleared by the success
        assert verify(client, me, "asha@example.com", "typo").status_code == 401
    assert verify(client, me, "asha@example.com", "correct horse 42").status_code == 200


def test_successful_sign_ins_never_count_as_failures(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    register(client, internal_headers)
    me = from_client("198.51.100.7", internal_headers)
    assert all(
        verify(client, me, "asha@example.com", "correct horse 42").status_code == 200
        for _ in range(12)
    )


def test_one_client_cannot_spray_many_accounts(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_CLIENT", "3/minute")
    sprayer = from_client("203.0.113.66", internal_headers)
    statuses = [
        verify(client, sprayer, f"user{i}@example.com", "guess").status_code for i in range(5)
    ]
    assert statuses == [401, 401, 401, 429, 429]
    other = from_client("198.51.100.7", internal_headers)
    assert verify(client, other, "user9@example.com", "guess").status_code == 401


def test_sign_ins_are_not_limited_per_next_server(
    client: TestClient, internal_headers: dict[str, str], settings_factory: Callable[..., Settings]
) -> None:
    """Regression: /users/* shared one per-IP default bucket (the Next.js server) for every
    login of the deployment, so ~2 bad logins/s from anyone blocked all sign-ins."""
    with TestClient(create_app(settings_factory(rate_limit_default="5/minute"))) as limited:
        register(limited, internal_headers)
        for i in range(8):  # random emails, no client address forwarded
            assert (
                verify(limited, internal_headers, f"x{i}@example.com", "guess").status_code == 401
            )
        ok = verify(limited, internal_headers, "asha@example.com", "correct horse 42")
        assert ok.status_code == 200


def test_unknown_client_address_still_has_an_account_limit(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_ACCOUNT", "3/hour")
    register(client, internal_headers)
    statuses = [
        verify(client, internal_headers, "asha@example.com", "guess").status_code for _ in range(4)
    ]
    assert statuses == [401, 401, 401, 429]


def test_register_is_limited_per_client(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    flooder = from_client("203.0.113.66", internal_headers)
    statuses = [
        register(client, flooder, email=f"bot{i}@example.com").status_code for i in range(6)
    ]
    assert statuses == [201] * 5 + [429]
    other = from_client("198.51.100.7", internal_headers)
    assert register(client, other, email="human@example.com").status_code == 201


def test_bcrypt_runs_on_its_own_pool(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    threads: list[str] = []
    real_hash = user_service.hash_password

    def recording_hash(password: str, rounds: int | None = None) -> str:
        threads.append(threading.current_thread().name)
        return real_hash(password, rounds)

    monkeypatch.setattr(user_service, "hash_password", recording_hash)
    assert register(client, internal_headers).status_code == 201
    assert threads and threads[0].startswith("resq-bcrypt")


# ----------------------------------------------------------------------------------------------
# Internal key guard
# ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/api/users/register", "/api/users/verify"])
@pytest.mark.parametrize("headers", [{}, {"X-Internal-Key": "wrong-key"}, {"X-Internal-Key": ""}])
def test_users_require_internal_key(client: TestClient, path: str, headers: dict[str, str]) -> None:
    response = client.post(
        path,
        json={"email": "a@example.com", "password": "password123", "name": "A"},
        headers=headers,
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_users_internal_key_not_configured_is_503(
    settings_factory: Callable[..., Settings],
) -> None:
    with TestClient(create_app(settings_factory(internal_api_key=""))) as client:
        response = client.post(
            "/api/users/register",
            json={"email": "a@example.com", "password": "password123", "name": "A"},
            headers={"X-Internal-Key": "anything"},
        )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_bad_key_is_rejected_before_body_validation(client: TestClient) -> None:
    """Unauthenticated callers learn nothing about the expected body (401, not 422)."""
    response = client.post("/api/users/register", json={}, headers={"X-Internal-Key": "nope"})
    assert response.status_code == 401


# ----------------------------------------------------------------------------------------------
# Service level
# ----------------------------------------------------------------------------------------------
def test_hash_and_check_password() -> None:
    hashed = user_service.hash_password("s3cret-password", rounds=4)
    assert hashed.startswith("$2b$04$")
    assert user_service.check_password("s3cret-password", hashed)
    assert not user_service.check_password("s3cret-passwordX", hashed)
    assert user_service.hash_password("s3cret-password", rounds=4) != hashed  # salted
    assert not user_service.check_password("anything", "not-a-bcrypt-hash")


def test_service_register_and_verify(run_db: Callable) -> None:
    async def scenario(session: AsyncSession) -> None:
        user = await user_service.register_user(
            session, "Mixed@Case.ORG", "password123", "  Mixed   Case "
        )
        assert user.email == "mixed@case.org"
        assert user.name == "Mixed Case"
        assert await user_service.get_user_by_email(session, "MIXED@case.org") is not None

        verified = await user_service.verify_user(session, "mixed@case.org", "password123")
        assert verified is not None and verified.id == user.id
        assert await user_service.verify_user(session, "mixed@case.org", "password124") is None
        assert await user_service.verify_user(session, "bogus", "password123") is None

        with pytest.raises(ConflictError):
            await user_service.register_user(session, "mixed@case.org", "password123", "X")
        with pytest.raises(InvalidInputError):
            await user_service.register_user(session, "a@b.co", "password123", "   ")
        with pytest.raises(InvalidInputError):
            await user_service.register_user(session, "not-an-email", "password123", "X")

    run_db(scenario)


def test_service_register_race_maps_integrity_error_to_conflict(
    run_db: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two concurrent registrations: the loser's INSERT hits the unique index -> 409."""

    async def scenario(session: AsyncSession) -> None:
        await user_service.register_user(session, "race@example.com", "password123", "First")

        real_scalar = session.scalar

        async def pre_check_misses(statement: Any, *args: Any, **kwargs: Any) -> Any:
            # Simulate the race: the duplicate check runs before the other INSERT commits.
            return None

        monkeypatch.setattr(session, "scalar", pre_check_misses)
        with pytest.raises(ConflictError):
            await user_service.register_user(session, "race@example.com", "password123", "Second")
        monkeypatch.setattr(session, "scalar", real_scalar)

        rows = list(await session.scalars(select(User).where(User.email == "race@example.com")))
        assert [row.name for row in rows] == ["First"]

    run_db(scenario)


def test_verify_burns_bcrypt_time_for_unknown_email(
    run_db: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unknown emails still run one bcrypt check (no timing-based account enumeration)."""
    checks: list[bytes] = []
    real_checkpw = user_service.bcrypt.checkpw

    def counting_checkpw(password: bytes, hashed: bytes) -> bool:
        checks.append(hashed)
        return real_checkpw(password, hashed)

    monkeypatch.setattr(user_service.bcrypt, "checkpw", counting_checkpw)

    async def scenario(session: AsyncSession) -> None:
        assert await user_service.verify_user(session, "ghost@example.com", "password123") is None

    run_db(scenario)
    assert len(checks) == 1
    assert checks[0].startswith(b"$2b$04$")  # dummy hash uses the configured cost


# ----------------------------------------------------------------------------------------------
# Concurrency (review round 2): reservations before bcrypt, in-flight caps, no held DB
# connections, bounded bcrypt queue, account bucket never locks out a clean client
# ----------------------------------------------------------------------------------------------
@asynccontextmanager
async def running_app(settings: Settings) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    """The real app with its lifespan, driven concurrently through an in-process transport."""
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            yield app, http


def _gate_check_password(monkeypatch: pytest.MonkeyPatch) -> threading.Event:
    """Make every bcrypt check block until the returned event is set (simulates a slow pool)."""
    gate = threading.Event()
    real_check = user_service.check_password

    def gated(password: str, password_hash: str) -> bool:
        gate.wait(timeout=10)
        return real_check(password, password_hash)

    monkeypatch.setattr(user_service, "check_password", gated)
    return gate


async def _register_async(http: httpx.AsyncClient, headers: dict[str, str]) -> None:
    payload = {"email": "asha@example.com", "password": "correct horse 42", "name": "Asha"}
    response = await http.post("/api/users/register", json=payload, headers=headers)
    assert response.status_code == 201, response.text


async def _verify_async(
    http: httpx.AsyncClient, headers: dict[str, str], password: str, email: str = "asha@example.com"
) -> httpx.Response:
    return await http.post(
        "/api/users/verify", json={"email": email, "password": password}, headers=headers
    )


async def _wait_until(predicate: Callable[[], bool]) -> None:
    """Poll ``predicate`` (state lives in other threads, so there is no event to await)."""
    async with asyncio.timeout(5):
        for _ in range(1_000):
            if predicate():
                return
            await asyncio.sleep(0.005)
    raise AssertionError("condition not reached")


async def test_concurrent_guesses_cannot_exceed_the_failure_limit(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: the limit was only peeked before bcrypt, so 13 simultaneous guesses all
    ran (12 x 401 + the correct password accepted) against a 5/minute limit."""
    from app.api.routes import users as user_routes

    # Isolate the reservation logic from the in-flight cap.
    monkeypatch.setattr(user_routes, "MAX_VERIFY_IN_FLIGHT_PER_CLIENT", 100)
    attacker = from_client("203.0.113.9", internal_headers)
    async with running_app(settings) as (_, http):
        await _register_async(http, attacker)
        guesses = [f"guess{i:02d}" for i in range(12)] + ["correct horse 42"]
        responses = await asyncio.gather(*(_verify_async(http, attacker, p) for p in guesses))
        statuses = [r.status_code for r in responses]
        assert statuses.count(401) == 5
        assert statuses.count(429) == 8
        assert responses[-1].status_code == 429  # the correct guess was never checked
        assert (await _verify_async(http, attacker, "another")).status_code == 429


async def test_one_client_has_a_bounded_number_of_sign_ins_in_flight(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import users as user_routes

    me = from_client("198.51.100.7", internal_headers)
    async with running_app(settings) as (_, http):
        await _register_async(http, me)
        gate = _gate_check_password(monkeypatch)
        limit = user_routes.MAX_VERIFY_IN_FLIGHT_PER_CLIENT
        tasks = [
            asyncio.create_task(_verify_async(http, me, "correct horse 42"))
            for _ in range(limit + 2)
        ]
        await _wait_until(lambda: sum(task.done() for task in tasks) >= 2)
        rejected = [task.result() for task in tasks if task.done()]
        assert [r.status_code for r in rejected] == [429, 429]
        assert rejected[0].headers["retry-after"] == "1"
        # Another client is not affected by this client's pending requests.
        other = asyncio.create_task(
            _verify_async(http, from_client("192.0.2.44", internal_headers), "nope")
        )
        gate.set()
        results = await asyncio.gather(*tasks)
        assert sorted(r.status_code for r in results) == [200] * limit + [429, 429]
        assert (await other).status_code == 401
        assert (await _verify_async(http, me, "correct horse 42")).status_code == 200


async def test_bcrypt_wait_holds_no_database_connection(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: verify kept a pooled connection checked out while queueing for bcrypt, so a
    login flood exhausted the pool and stalled SOS and every other endpoint."""
    async with running_app(settings) as (app, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        tasks = [
            asyncio.create_task(
                _verify_async(http, from_client(f"203.0.113.{i}", internal_headers), "wrong")
            )
            for i in range(1, 13)
        ]
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == 12)
        assert app.state.engine.pool.checkedout() == 0
        started = asyncio.get_running_loop().time()
        incidents = await http.get("/api/incidents")
        assert incidents.status_code == 200
        assert asyncio.get_running_loop().time() - started < 2
        gate.set()
        assert {r.status_code for r in await asyncio.gather(*tasks)} == {401}
    assert user_service.pending_bcrypt_jobs() == 0


async def test_full_bcrypt_queue_answers_503_and_returns_the_reservation(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(user_service, "BCRYPT_MAX_PENDING", 1)
    async with running_app(settings) as (app, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        first = asyncio.create_task(
            _verify_async(http, from_client("203.0.113.1", internal_headers), "wrong")
        )
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == 1)
        me = from_client("198.51.100.7", internal_headers)
        busy = await _verify_async(http, me, "typo")
        assert busy.status_code == 503
        assert busy.json()["error"]["code"] == "service_busy"
        assert int(busy.headers["retry-after"]) >= 1
        gate.set()
        assert (await first).status_code == 401
        # The refused attempt was not counted as one of my failures: 5 more are allowed.
        statuses = [(await _verify_async(http, me, "typo")).status_code for _ in range(6)]
        assert statuses == [401] * 5 + [429]
        assert app.state.engine.pool.checkedout() == 0


def test_burst_from_one_client_never_locks_out_the_owner(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: 100 failures filled the account-wide bucket and the owner, with the correct
    password from their own address, got 429 for an hour."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_ACCOUNT", "3/hour")
    register(client, internal_headers)
    for i in range(3):  # three attackers fill the account bucket
        attacker = from_client(f"203.0.113.{i + 1}", internal_headers)
        assert verify(client, attacker, "asha@example.com", "guess").status_code == 401

    owner = from_client("198.51.100.7", internal_headers)
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200
    # Even after one typo of their own the owner still gets in.
    assert verify(client, owner, "asha@example.com", "typo").status_code == 401
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200

    # A fresh attacker address gets ACCOUNT_LOCK_OWN_FAILURES guesses, then 429.
    fresh = from_client("192.0.2.200", internal_headers)
    statuses = [verify(client, fresh, "asha@example.com", "g").status_code for _ in range(3)]
    assert statuses == [401] * user_routes.ACCOUNT_LOCK_OWN_FAILURES + [429]
    # An earlier attacker with one failure gets one more try, then is refused.
    first = from_client("203.0.113.1", internal_headers)
    assert verify(client, first, "asha@example.com", "guess").status_code == 401
    assert verify(client, first, "asha@example.com", "guess").status_code == 429


def test_ipv6_clients_share_a_bucket_per_64(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    """Rotating addresses inside one /64 must not give fresh sign-in or sign-up buckets."""
    register(client, internal_headers)
    statuses = [
        verify(
            client,
            from_client(f"2001:db8:1:2::{i + 1:x}", internal_headers),
            "asha@example.com",
            "g",
        ).status_code
        for i in range(6)
    ]
    assert statuses == [401] * 5 + [429]
    other_network = from_client("2001:db8:1:3::1", internal_headers)
    assert verify(client, other_network, "asha@example.com", "g").status_code == 401

    sign_ups = [
        register(
            client, from_client(f"2001:db8:9:9::{i + 1:x}", internal_headers), email=f"b{i}@x.org"
        ).status_code
        for i in range(6)
    ]
    assert sign_ups == [201] * 5 + [429]


# ----------------------------------------------------------------------------------------------
# Review round 3: correct passwords are not free, bounded escape hatch, reserved bcrypt slots
# ----------------------------------------------------------------------------------------------
def test_successful_sign_ins_are_rate_limited_per_client(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: successes refunded every reservation, so a few clients looping a correct
    password kept the shared bcrypt queue full (every other sign-in got 503)."""
    from app.api.routes import users as user_routes

    assert user_routes.VERIFY_ATTEMPTS_PER_CLIENT.startswith("30/minute")
    # Isolate the per-client budget from the per-account success cap (tested below).
    monkeypatch.setattr(user_routes, "VERIFY_SUCCESSES_PER_ACCOUNT", "1000/hour")
    register(client, internal_headers)
    looper = from_client("203.0.113.70", internal_headers)
    statuses = [
        verify(client, looper, "asha@example.com", "correct horse 42").status_code
        for _ in range(31)
    ]
    assert statuses == [200] * 30 + [429]
    # Other clients (the owner on another network) are not affected.
    owner = from_client("198.51.100.7", internal_headers)
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200


def test_busy_answers_are_not_free_retries(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client spinning on 503 service_busy uses up its attempts and then gets 429."""
    from app.api.routes import users as user_routes

    register(client, internal_headers)
    monkeypatch.setattr(user_routes, "VERIFY_ATTEMPTS_PER_CLIENT", "4/minute")
    monkeypatch.setattr(user_service, "BCRYPT_MAX_PENDING", 0)  # every bcrypt job is refused
    spinner = from_client("203.0.113.71", internal_headers)
    statuses = [
        verify(client, spinner, "asha@example.com", "correct horse 42").status_code
        for _ in range(5)
    ]
    assert statuses == [503] * 4 + [429]


async def test_busy_clients_cannot_fill_the_reserved_bcrypt_slots(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: 8 clients x 4 correct sign-ins in flight filled all 32 bcrypt slots, so a
    person signing in for the first time got 503 for as long as the loop ran."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_service, "BCRYPT_MAX_PENDING", 8)
    monkeypatch.setattr(user_service, "BCRYPT_RESERVED_FOR_QUIET", 3)
    monkeypatch.setattr(user_routes, "QUIET_CLIENT_BCRYPT_JOBS", "1/minute")

    async def submit(headers: dict[str, str]) -> asyncio.Task[httpx.Response]:
        """Start one sign-in and wait until it is queued for bcrypt or answered."""
        before = user_service.pending_bcrypt_jobs()
        task = asyncio.create_task(_verify_async(http, headers, "correct horse 42"))
        await _wait_until(lambda: task.done() or user_service.pending_bcrypt_jobs() > before)
        return task

    async with running_app(settings) as (_, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        loopers = [from_client(f"203.0.113.{80 + i}", internal_headers) for i in range(2)]
        flood = [
            await submit(headers)
            for headers in loopers
            for _ in range(user_routes.MAX_VERIFY_IN_FLIGHT_PER_CLIENT)
        ]
        # Each looper's first job may use the whole queue, the others only 8 - 3 = 5 slots:
        # looper A takes 4 slots, looper B its quiet one, B's three busy ones are refused.
        assert user_service.pending_bcrypt_jobs() == 5
        assert [t.done() for t in flood] == [False] * 5 + [True] * 3
        assert [t.result().status_code for t in flood[5:]] == [503] * 3

        newcomer = await submit(from_client("198.51.100.7", internal_headers))
        assert not newcomer.done()
        assert user_service.pending_bcrypt_jobs() == 6
        gate.set()
        assert (await newcomer).status_code == 200
        assert sorted(r.status_code for r in await asyncio.gather(*flood)) == [200] * 5 + [503] * 3
    assert user_service.pending_bcrypt_jobs() == 0


def test_bcrypt_queue_limit_keeps_the_reserve() -> None:
    assert user_service.bcrypt_queue_limit(True) == user_service.BCRYPT_MAX_PENDING
    assert (
        user_service.bcrypt_queue_limit(False)
        == user_service.BCRYPT_MAX_PENDING - user_service.BCRYPT_RESERVED_FOR_QUIET
    )


def test_rotating_networks_cannot_multiply_the_account_budget(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: once the account bucket was full, every /64 with fewer than 2 own failures
    was still admitted, so one /48 (65,536 /64s) got ~131k checks per hour on one account."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_ACCOUNT", "3/hour")
    monkeypatch.setattr(user_routes, "VERIFY_OVERFLOW_PER_ACCOUNT", "4/hour")
    register(client, internal_headers)
    owner = from_client("198.51.100.7", internal_headers)
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200

    for i in range(3):  # fill the account bucket
        attacker = from_client(f"203.0.113.{i + 1}", internal_headers)
        assert verify(client, attacker, "asha@example.com", "guess").status_code == 401

    statuses = [
        verify(
            client,
            from_client(f"2001:db8:77:{i:x}::1", internal_headers),
            "asha@example.com",
            "guess",
        ).status_code
        for i in range(40)
    ]
    assert statuses.count(401) == 4  # the overflow bucket, not 2 per /64
    assert statuses.count(429) == 36

    # The owner signed in from their network before: still admitted, typo included.
    assert verify(client, owner, "asha@example.com", "typo").status_code == 401
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200
    # A network the account never signed in from waits for the window.
    stranger = from_client("192.0.2.9", internal_headers)
    assert verify(client, stranger, "asha@example.com", "correct horse 42").status_code == 429


def test_escape_hatch_success_does_not_use_up_the_overflow(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Owners admitted through the overflow bucket get their reservation back on success."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_ACCOUNT", "2/hour")
    monkeypatch.setattr(user_routes, "VERIFY_OVERFLOW_PER_ACCOUNT", "1/hour")
    register(client, internal_headers)
    for i in range(2):
        attacker = from_client(f"203.0.113.{i + 1}", internal_headers)
        assert verify(client, attacker, "asha@example.com", "guess").status_code == 401
    for i in range(3):  # three different owners' devices, each on a new network
        device = from_client(f"198.51.100.{i + 10}", internal_headers)
        assert verify(client, device, "asha@example.com", "correct horse 42").status_code == 200


# ----------------------------------------------------------------------------------------------
# Review round 4: one IPv6 /48 is one budget, successes are capped per account, known
# clients live in a bounded store
# ----------------------------------------------------------------------------------------------
def _v6(network: int, host: int = 1) -> str:
    """An address in the ``/64`` number ``network`` of the ``2001:db8:77::/48`` network."""
    return f"2001:db8:77:{network:x}::{host:x}"


def _limit_amount(limit: str) -> int:
    """The smallest amount of a ``limits`` string (``"6/minute;50/hour"`` -> 6)."""
    from limits import parse_many

    return min(item.amount for item in parse_many(limit))


def test_prefix_budgets_keep_one_48_below_the_shared_bcrypt_queue() -> None:
    """The invariants that make the bcrypt reserve hold against one /48, however it rotates
    its /64 networks (see the users route docstring)."""
    from app.api.routes import users as user_routes

    reserve = user_service.BCRYPT_RESERVED_FOR_QUIET
    unreserved = user_service.BCRYPT_MAX_PENDING - reserve
    assert _limit_amount(user_routes.QUIET_PREFIX_BCRYPT_JOBS) < reserve
    assert unreserved > user_routes.MAX_VERIFY_IN_FLIGHT_PER_PREFIX
    # The /48 buckets are wider than, and so never tighter than, the per-client ones.
    assert _limit_amount(user_routes.QUIET_PREFIX_BCRYPT_JOBS) > _limit_amount(
        user_routes.QUIET_CLIENT_BCRYPT_JOBS
    )
    assert user_routes.MAX_VERIFY_IN_FLIGHT_PER_PREFIX > user_routes.MAX_VERIFY_IN_FLIGHT_PER_CLIENT
    assert _limit_amount(user_routes.VERIFY_ATTEMPTS_PER_PREFIX) > _limit_amount(
        user_routes.VERIFY_ATTEMPTS_PER_CLIENT
    )
    assert _limit_amount(user_routes.REGISTER_PER_PREFIX) > _limit_amount(
        user_routes.REGISTER_PER_CLIENT
    )


def test_rotating_64s_of_one_48_share_one_attempt_budget(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    """Regression: the attempt budget was per /64 only, so a /48 rotating its 65,536 /64s got
    a fresh 30/minute per request and could keep the bcrypt queue full."""
    from app.api.routes import users as user_routes

    budget = _limit_amount(user_routes.VERIFY_ATTEMPTS_PER_PREFIX)
    assert budget == 120
    statuses = [
        verify(
            client, from_client(_v6(i), internal_headers), f"nobody{i}@example.com", "g"
        ).status_code
        for i in range(budget + 1)
    ]
    assert statuses == [401] * budget + [429]
    # Another /48 and IPv4 clients have their own budgets.
    assert (
        verify(
            client, from_client("2001:db8:78::1", internal_headers), "x@example.com", "g"
        ).status_code
        == 401
    )
    assert (
        verify(
            client, from_client("203.0.113.5", internal_headers), "x@example.com", "g"
        ).status_code
        == 401
    )


def test_rotating_64s_of_one_48_share_one_registration_budget(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    from app.api.routes import users as user_routes

    budget = _limit_amount(user_routes.REGISTER_PER_PREFIX)
    statuses = [
        register(client, from_client(_v6(i), internal_headers), email=f"b{i}@x.org").status_code
        for i in range(budget + 1)
    ]
    assert statuses == [201] * budget + [429]
    other = from_client("2001:db8:78::1", internal_headers)
    assert register(client, other, email="human@example.com").status_code == 201


async def test_rotating_64s_of_one_48_are_not_quiet_clients(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: every fresh /64 counted as a new "quiet" client, so one /48 rotating its
    networks used the slots reserved for first-time sign-ins and the victim got 503."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_service, "BCRYPT_MAX_PENDING", 8)
    monkeypatch.setattr(user_service, "BCRYPT_RESERVED_FOR_QUIET", 3)
    monkeypatch.setattr(user_routes, "QUIET_PREFIX_BCRYPT_JOBS", "2/minute")
    monkeypatch.setattr(user_routes, "MAX_VERIFY_IN_FLIGHT_PER_PREFIX", 100)  # tested below

    async def submit(headers: dict[str, str]) -> asyncio.Task[httpx.Response]:
        before = user_service.pending_bcrypt_jobs()
        task = asyncio.create_task(_verify_async(http, headers, "correct horse 42"))
        await _wait_until(lambda: task.done() or user_service.pending_bcrypt_jobs() > before)
        return task

    async with running_app(settings) as (_, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        flood = [await submit(from_client(_v6(i), internal_headers)) for i in range(10)]
        # Two quiet jobs for the whole /48, then only the 8 - 3 = 5 unreserved slots.
        assert user_service.pending_bcrypt_jobs() == 5
        assert [t.result().status_code for t in flood if t.done()] == [503] * 5

        newcomer = await submit(from_client("198.51.100.7", internal_headers))
        assert not newcomer.done()
        assert user_service.pending_bcrypt_jobs() == 6
        gate.set()
        assert (await newcomer).status_code == 200
        assert sorted(r.status_code for r in await asyncio.gather(*flood)) == [200] * 5 + [503] * 5
    assert user_service.pending_bcrypt_jobs() == 0


async def test_one_48_has_a_bounded_number_of_requests_in_flight(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import users as user_routes

    limit = user_routes.MAX_VERIFY_IN_FLIGHT_PER_PREFIX
    async with running_app(settings) as (_, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        tasks = [
            asyncio.create_task(
                _verify_async(http, from_client(_v6(i), internal_headers), "correct horse 42")
            )
            for i in range(limit + 2)
        ]
        await _wait_until(lambda: sum(task.done() for task in tasks) >= 2)
        rejected = [task.result() for task in tasks if task.done()]
        assert [r.status_code for r in rejected] == [429, 429]
        assert rejected[0].headers["retry-after"] == "1"
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == limit)
        # An IPv4 client and another /48 are not affected by this /48's pending requests.
        others = [
            asyncio.create_task(_verify_async(http, from_client(ip, internal_headers), "nope"))
            for ip in ("192.0.2.44", "2001:db8:78::1")
        ]
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == limit + 2)
        gate.set()
        results = await asyncio.gather(*tasks)
        assert sorted(r.status_code for r in results) == [200] * limit + [429, 429]
        assert [(await task).status_code for task in others] == [401, 401]
        # The slots were returned: a full set of concurrent requests is admitted again.
        retry = [
            _verify_async(http, from_client(_v6(i), internal_headers), "x") for i in range(limit)
        ]
        assert {r.status_code for r in await asyncio.gather(*retry)} == {401}


def test_successful_sign_ins_are_capped_per_account(
    client: TestClient, internal_headers: dict[str, str]
) -> None:
    """Regression: looping one valid account from fresh networks was the cheapest bcrypt
    flood (every success refunded its reservations and each /64 had its own budget)."""
    from app.api.routes import users as user_routes

    cap = _limit_amount(user_routes.VERIFY_SUCCESSES_PER_ACCOUNT)
    assert user_routes.VERIFY_SUCCESSES_PER_ACCOUNT == "30/hour"
    register(client, internal_headers)
    register(client, internal_headers, email="ravi@example.com")
    statuses = [
        verify(
            client,
            from_client(f"203.0.113.{i + 1}", internal_headers),
            "asha@example.com",
            "correct horse 42",
        ).status_code
        for i in range(cap + 1)
    ]
    assert statuses == [200] * cap + [429]
    capped = verify(client, from_client("192.0.2.7", internal_headers), "asha@example.com", "x")
    assert capped.status_code == 429  # refused before bcrypt, whatever the password
    assert int(capped.headers["retry-after"]) > 60
    # Other accounts are unaffected.
    ravi = from_client("192.0.2.8", internal_headers)
    assert verify(client, ravi, "ravi@example.com", "correct horse 42").status_code == 200


def test_failed_guesses_never_use_up_the_success_cap(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only someone holding the password can use the success budget: guessing cannot lock
    the owner out through it."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_SUCCESSES_PER_ACCOUNT", "2/hour")
    register(client, internal_headers)
    for i in range(10):
        guesser = from_client(f"203.0.113.{i + 1}", internal_headers)
        assert verify(client, guesser, "asha@example.com", "guess").status_code == 401
    owner = from_client("198.51.100.7", internal_headers)
    statuses = [
        verify(client, owner, "asha@example.com", "correct horse 42").status_code for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


async def test_pending_guesses_do_not_hold_the_success_cap(
    settings: Settings, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Successes are counted after the password check, not reserved before it: wrong guesses
    waiting for bcrypt must not make the owner's sign-in look over the cap."""
    from app.api.routes import users as user_routes

    monkeypatch.setattr(user_routes, "VERIFY_SUCCESSES_PER_ACCOUNT", "1/hour")
    async with running_app(settings) as (_, http):
        await _register_async(http, internal_headers)
        gate = _gate_check_password(monkeypatch)
        guesses = [
            asyncio.create_task(
                _verify_async(http, from_client(f"203.0.113.{i + 1}", internal_headers), "guess")
            )
            for i in range(3)
        ]
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == 3)
        owner = asyncio.create_task(
            _verify_async(http, from_client("198.51.100.7", internal_headers), "correct horse 42")
        )
        await _wait_until(lambda: user_service.pending_bcrypt_jobs() == 4)
        gate.set()
        assert [(await g).status_code for g in guesses] == [401] * 3
        assert (await owner).status_code == 200
        # The success was counted: the cap is now reached.
        again = await _verify_async(http, from_client("198.51.100.8", internal_headers), "x")
        assert again.status_code == 429


def test_known_clients_store_is_bounded_per_account_and_overall() -> None:
    from app.core.rate_limit import KnownClients

    store = KnownClients(per_account=3, max_accounts=2, ttl_seconds=100)
    for client in (b"c1", b"c2", b"c3", b"c4"):
        store.remember(b"a1", client)
    # Only the 3 most recently successful clients are kept.
    assert [store.knows(b"a1", c) for c in (b"c1", b"c2", b"c3", b"c4")] == [
        False,
        True,
        True,
        True,
    ]
    store.remember(b"a1", b"c2")  # a repeated success makes c2 the newest again
    store.remember(b"a1", b"c5")
    assert store.knows(b"a1", b"c2")
    assert not store.knows(b"a1", b"c3")

    store.remember(b"a2", b"c1")
    store.remember(b"a1", b"c6")  # a1 is now the most recently successful account
    store.remember(b"a3", b"c1")  # over max_accounts: the least recent (a2) is evicted
    assert len(store) == 2
    assert not store.knows(b"a2", b"c1")
    assert store.knows(b"a1", b"c6")
    assert store.knows(b"a3", b"c1")
    store.reset()
    assert len(store) == 0


def test_known_clients_expire_lazily() -> None:
    from app.core.rate_limit import KnownClients

    now = [1_000.0]
    store = KnownClients(per_account=8, max_accounts=10, ttl_seconds=60, clock=lambda: now[0])
    store.remember(b"acct", b"old")
    now[0] += 30
    store.remember(b"acct", b"new")
    now[0] += 45  # "old" is 75 s old, "new" 45 s
    assert not store.knows(b"acct", b"old")
    assert store.knows(b"acct", b"new")
    now[0] += 30
    assert not store.knows(b"acct", b"new")
    assert len(store) == 0  # the account was dropped with its last client


def test_known_client_markers_do_not_grow_with_rotating_networks(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: every successful sign-in from a new /64 added a 30-day marker to the
    process-wide limiter, without a cap (~286 MB/day for a client rotating /64s)."""
    from app.api.routes import users as user_routes
    from app.core.rate_limit import known_clients, limiter

    monkeypatch.setattr(user_routes, "VERIFY_SUCCESSES_PER_ACCOUNT", "1000/hour")
    monkeypatch.setattr(user_routes, "VERIFY_ATTEMPTS_PER_PREFIX", "1000/minute")
    register(client, internal_headers)
    for i in range(40):
        headers = from_client(_v6(i), internal_headers)
        assert verify(client, headers, "asha@example.com", "correct horse 42").status_code == 200
    assert len(known_clients) == 1
    assert known_clients.per_account == 8
    remembered = [known_clients.knows(*_known_key(client, i)) for i in range(40)]
    assert remembered == [False] * 32 + [True] * 8
    # Nothing long-lived is kept in the limiter's storage for them.
    events: dict[str, Any] = limiter._storage.events  # type: ignore[attr-defined]
    assert not [key for key in events if "users-verify-known" in key]


def _known_key(client: TestClient, network: int) -> tuple[bytes, bytes]:
    """The store key the users route uses for ``asha@example.com`` signing in from /64 #n."""
    from app.core.rate_limit import ip_bucket
    from app.core.security import hash_identifier

    secret = client.app.state.settings.internal_api_key  # type: ignore[attr-defined]
    account = hash_identifier("asha@example.com", f"verify-email:{secret}")
    address = hash_identifier(ip_bucket(_v6(network)), f"verify-client:{secret}")
    return bytes.fromhex(account[:32]), bytes.fromhex(address[:32])


def test_known_client_still_signs_in_while_both_account_buckets_are_full(
    client: TestClient, internal_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The escape hatch survives the move to the bounded store, and its memory expires."""
    from app.api.routes import users as user_routes
    from app.core.rate_limit import known_clients

    monkeypatch.setattr(user_routes, "VERIFY_FAILURES_PER_ACCOUNT", "2/hour")
    monkeypatch.setattr(user_routes, "VERIFY_OVERFLOW_PER_ACCOUNT", "1/hour")
    register(client, internal_headers)
    owner = from_client("198.51.100.7", internal_headers)
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200
    for i in range(3):  # fill the account bucket and the overflow bucket
        attacker = from_client(f"203.0.113.{i + 1}", internal_headers)
        assert verify(client, attacker, "asha@example.com", "guess").status_code == 401
    stranger = from_client("192.0.2.9", internal_headers)
    assert verify(client, stranger, "asha@example.com", "correct horse 42").status_code == 429
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 200

    # 14 days later the owner's network is forgotten (checked lazily on the next attempt).
    import time

    later = time.time() + known_clients.ttl_seconds + 60
    assert known_clients.ttl_seconds == 14 * 86_400
    monkeypatch.setattr(known_clients, "_clock", lambda: later)
    assert verify(client, owner, "asha@example.com", "correct horse 42").status_code == 429
