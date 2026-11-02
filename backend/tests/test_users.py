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


def test_successful_sign_ins_are_never_counted(
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
