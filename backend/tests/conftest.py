"""Shared pytest fixtures for the ResQ AI backend.

Fixtures
--------
``settings``                Hermetic test :class:`Settings` (tmp SQLite file, ``app_env="test"``,
                            JWT secret, internal key, a real throw-away VAPID key pair, every
                            external integration disabled).
``settings_factory``        ``settings_factory(**overrides) -> Settings`` for variations
                            (e.g. ``openweather_api_key="k"``, ``twilio_account_sid=...``).
``app``                     ``create_app(settings)`` (lifespan not started yet).
``client``                  ``TestClient`` used as a context manager (lifespan runs, so
                            ``client.app.state.<service>`` exists and can be swapped for fakes).
``make_token``              ``make_token(user_id="u1", name="Test User", email=None,
                            expires_in=600) -> str`` — JWT exactly like the Next.js proxy's.
``auth_headers``            ``auth_headers(user_id="u1", name="Test User")``
                            -> ``{"Authorization": "Bearer <jwt>"}``.
``internal_headers``        ``{"X-Internal-Key": <test key>}`` for ``/api/users/*``.
``fake_llm``                A :class:`FakeLLM` installed as ``client.app.state.llm``.
``run_db``                  ``run_db(async_fn)`` runs ``await async_fn(session)`` on the app's
                            event loop (seed/inspect the database from sync tests).

Autouse: rate-limit counters are reset before each test, and real network access is blocked
(TCP connects / remote DNS raise :class:`NetworkBlockedError`; proxy env vars are removed).

Mocking upstream HTTP (respx)
-----------------------------
Services use the shared ``httpx.AsyncClient`` on ``app.state.http``. The ``respx_mock`` fixture
(from the respx pytest plugin) intercepts it; Starlette's ``TestClient`` uses ``httpx2`` and is
not affected::

    import httpx

    def test_weather_fallback(client, respx_mock):
        respx_mock.get("https://api.open-meteo.com/v1/forecast").mock(
            return_value=httpx.Response(200, json={...})
        )
        respx_mock.get(url__startswith="https://api.openweathermap.org/").mock(
            side_effect=httpx.ConnectError("down")
        )
        response = client.get("/api/weather", params={"lat": 28.61, "lon": 77.21})
        assert response.status_code == 200

By default ``respx_mock`` asserts that every route was called and that no unmocked request
was made; relax with ``@pytest.mark.respx(assert_all_called=False)``.

FakeLLM
-------
``from conftest import FakeLLM`` (or use the ``fake_llm`` fixture)::

    def test_chat_with_llm(client, fake_llm):
        fake_llm.json_value = {"disaster_type": "flood", "urgency": "high", "intent": "other"}
        fake_llm.text = lambda prompt, system: "- Move to higher ground"
        ...
        assert fake_llm.calls[0].kind == "json"
"""

from __future__ import annotations

import base64
import os
import socket
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.rate_limit import reset_rate_limits
from app.core.security import create_access_token
from app.main import create_app

T = TypeVar("T")

TEST_JWT_SECRET = "test-backend-jwt-secret-0123456789-abcdefghijklmnop"
TEST_INTERNAL_KEY = "test-internal-api-key-0123456789"
TEST_VAPID_SUBJECT = "mailto:test@example.com"


def browser_push_keys() -> tuple[str, str]:
    """A valid ``(p256dh, auth)`` pair like a browser's ``PushSubscription.toJSON().keys``."""
    private = ec.generate_private_key(ec.SECP256R1())
    point = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return _b64url(point), _b64url(os.urandom(16))


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


#: One valid browser key pair shared by tests that only need *some* real keys.
VALID_P256DH, VALID_AUTH = browser_push_keys()


# ---------------------------------------------------------------------------------------------
# Network guard
# ---------------------------------------------------------------------------------------------
class NetworkBlockedError(RuntimeError):
    """Raised when a test tries to reach the real network (mock it with respx instead)."""


_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "testserver", "testclient"})
_PROXY_ENV_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")


def _is_local(host: Any) -> bool:
    if isinstance(host, bytes):
        host = host.decode("ascii", "ignore")
    return host is None or str(host) in _LOCAL_HOSTS


@pytest.fixture(autouse=True)
def _block_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly on any real network access (TCP connects and remote DNS lookups).

    Proxy variables are removed as well: httpx honours ``HTTPS_PROXY`` and would otherwise
    tunnel "unmocked" requests through a local proxy.
    """
    for name in _PROXY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)

    real_getaddrinfo = socket.getaddrinfo

    def _refuse(address: Any) -> None:
        # AF_UNIX addresses are plain paths (str/bytes); inet addresses are tuples.
        if isinstance(address, tuple):
            raise NetworkBlockedError(
                f"Network access is disabled in tests (tried {address[0]!r}); mock it with respx"
            )

    def guarded_connect(self: socket.socket, address: Any) -> None:
        _refuse(address)
        return real_connect(self, address)

    def guarded_connect_ex(self: socket.socket, address: Any) -> int:
        _refuse(address)
        return real_connect_ex(self, address)

    def guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if not _is_local(host):
            raise NetworkBlockedError(
                f"DNS lookups are disabled in tests (tried {host!r}); mock it with respx"
            )
        return real_getaddrinfo(host, *args, **kwargs)

    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)


@pytest.fixture(autouse=True)
def _reset_limiter() -> Iterator[None]:
    """Every test starts with empty rate-limit counters."""
    reset_rate_limits()
    yield
    reset_rate_limits()


# ---------------------------------------------------------------------------------------------
# Settings / app / client
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class VapidKeys:
    public_key: str
    private_key: str


@pytest.fixture(scope="session")
def vapid_keys() -> VapidKeys:
    """Throw-away P-256 key pair in the format of ``npx web-push generate-vapid-keys``."""
    private = ec.generate_private_key(ec.SECP256R1())
    raw_private = private.private_numbers().private_value.to_bytes(32, "big")
    raw_public = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return VapidKeys(public_key=_b64url(raw_public), private_key=_b64url(raw_private))


@pytest.fixture
def settings_factory(
    tmp_path: Path, vapid_keys: VapidKeys, monkeypatch: pytest.MonkeyPatch
) -> Callable[..., Settings]:
    """Build hermetic settings; keyword overrides win over the test defaults."""
    # Ignore the developer's environment entirely.
    for field_name in Settings.model_fields:
        monkeypatch.delenv(field_name.upper(), raising=False)

    def factory(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "app_env": "test",
            "log_level": "WARNING",
            "log_json": False,
            "cors_origins": "http://localhost:3000",
            "database_url": f"sqlite+aiosqlite:///{tmp_path / 'resq-test.db'}",
            "gemini_api_key": "",
            "openweather_api_key": "",
            "openweather_onecall_enabled": False,
            "reliefweb_appname": "",
            "twilio_account_sid": "",
            "twilio_auth_token": "",
            "twilio_from_number": "",
            "twilio_messaging_service_sid": "",
            "vapid_public_key": vapid_keys.public_key,
            "vapid_private_key": vapid_keys.private_key,
            "vapid_subject": TEST_VAPID_SUBJECT,
            "backend_jwt_secret": TEST_JWT_SECRET,
            "internal_api_key": TEST_INTERNAL_KEY,
            "rate_limit_default": "1000/minute",
            "sos_rate_limit": "5/minute",
            "incident_rate_limit": "1000/minute",
            "alert_poller_enabled": False,
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)  # type: ignore[call-arg]

    return factory


@pytest.fixture
def settings(settings_factory: Callable[..., Settings]) -> Settings:
    return settings_factory()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def make_token(settings: Settings) -> Callable[..., str]:
    def _make(
        user_id: str = "u1",
        name: str | None = "Test User",
        email: str | None = None,
        expires_in: int = 600,
        **kwargs: Any,
    ) -> str:
        secret = kwargs.pop("secret", None) or settings.backend_jwt_secret
        return create_access_token(user_id, email, name, secret, expires_in, **kwargs)

    return _make


@pytest.fixture
def auth_headers(make_token: Callable[..., str]) -> Callable[..., dict[str, str]]:
    def _headers(
        user_id: str = "u1", name: str | None = "Test User", **kwargs: Any
    ) -> dict[str, str]:
        return {"Authorization": f"Bearer {make_token(user_id, name, **kwargs)}"}

    return _headers


@pytest.fixture
def internal_headers(settings: Settings) -> dict[str, str]:
    return {"X-Internal-Key": settings.internal_api_key}


# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class LLMCall:
    kind: str  # "text" | "json"
    prompt: str
    system: str | None


Responder = Any  # constant value or Callable[[str, str | None], Any]


class FakeLLM:
    """Drop-in replacement for :class:`app.services.llm.LLMService`.

    ``text`` / ``json_value`` are either a constant or ``callable(prompt, system)``; ``None``
    simulates an LLM failure (the real service returns ``None`` on errors). Set
    ``enabled=False`` to emulate a missing ``GEMINI_API_KEY``. Every call is recorded in
    :attr:`calls`.
    """

    def __init__(
        self, text: Responder = None, json_value: Responder = None, *, enabled: bool = True
    ) -> None:
        self.text = text
        self.json_value = json_value
        self._enabled = enabled
        self.calls: list[LLMCall] = []
        self.closed = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    @staticmethod
    def _resolve(responder: Responder, prompt: str, system: str | None) -> Any:
        return responder(prompt, system) if callable(responder) else responder

    async def generate_text(self, prompt: str, system: str | None = None, **_: Any) -> str | None:
        self.calls.append(LLMCall("text", prompt, system))
        if not self._enabled:
            return None
        return self._resolve(self.text, prompt, system)

    async def generate_json(self, prompt: str, system: str | None = None, **_: Any) -> Any | None:
        self.calls.append(LLMCall("json", prompt, system))
        if not self._enabled:
            return None
        return self._resolve(self.json_value, prompt, system)

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def fake_llm(client: TestClient) -> FakeLLM:
    """A :class:`FakeLLM` installed on the running app (``app.state.llm``)."""
    llm = FakeLLM()
    client.app.state.llm = llm  # type: ignore[attr-defined]
    return llm


@pytest.fixture
def run_db(client: TestClient) -> Callable[[Callable[[AsyncSession], Awaitable[T]]], T]:
    """Run ``await fn(session)`` on the app's event loop and return its result."""

    def _run(fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
        sessionmaker = client.app.state.sessionmaker  # type: ignore[attr-defined]

        async def _call() -> T:
            async with sessionmaker() as session:
                return await fn(session)

        assert client.portal is not None, "use run_db inside the client fixture"
        return client.portal.call(_call)

    return _run
