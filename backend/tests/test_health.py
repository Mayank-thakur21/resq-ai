"""Tests for ``GET /api/health`` and the root endpoint."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import __version__
from app.core.config import Settings
from app.main import create_app
from app.services.cache import TTLCache
from app.services.disaster_feed import DisasterFeedService
from app.services.llm import LLMService
from app.services.places import PlacesService
from app.services.push import PushService
from app.services.sms import SMSService
from app.services.weather import WeatherService


class _BrokenEngine:
    """Stands in for an AsyncEngine whose database is unreachable."""

    def connect(self) -> Any:
        raise OSError("database is down")


def test_health_ok(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "status": "ok",
        "version": "2.0.0",
        "services": {
            "database": "ok",
            "gemini": False,
            "openweathermap": False,
            "reliefweb": False,
            "twilio": False,
            "push": True,
            "auth": True,
        },
    }
    assert __version__ == "2.0.0"
    assert response.headers["x-request-id"]
    assert "x-ratelimit-limit" not in response.headers  # exempt from rate limiting


def test_health_reports_configured_integrations(
    settings_factory: Callable[..., Settings],
) -> None:
    settings = settings_factory(
        gemini_api_key="test-gemini-key",
        openweather_api_key="owm-key",
        reliefweb_appname="resq-ai",
        twilio_account_sid="AC123",
        twilio_auth_token="secret",
        twilio_from_number="+15005550006",
        vapid_public_key="",
        backend_jwt_secret="",
    )
    with TestClient(create_app(settings)) as client:
        services = client.get("/api/health").json()["services"]
    assert services == {
        "database": "ok",
        "gemini": True,
        "openweathermap": True,
        "reliefweb": True,
        "twilio": True,
        "push": False,
        "auth": False,
    }


def test_health_push_false_when_vapid_key_unparsable(
    settings_factory: Callable[..., Settings],
) -> None:
    """Both VAPID keys set but the private key is garbage: PushService disables itself, and
    health must agree with ``/api/push/vapid-public-key`` instead of reporting push=true."""
    settings = settings_factory(vapid_private_key="not-a-valid-vapid-key")
    assert settings.push_enabled  # both keys are "present"...
    with TestClient(create_app(settings)) as client:
        services = client.get("/api/health").json()["services"]
        vapid = client.get("/api/push/vapid-public-key").json()
    assert services["push"] is False  # ...but the live service is off
    assert vapid["enabled"] is False


def test_health_degraded_when_database_unreachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client.app.state, "engine", _BrokenEngine())  # type: ignore[attr-defined]
    response = client.get("/api/health")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["services"]["database"] == "error"


def test_root(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"name": "ResQ AI API", "version": "2.0.0", "docs": "/docs"}


def test_openapi_documents_health_and_security_schemes(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert "/api/health" in schema["paths"]
    assert schema["info"]["version"] == "2.0.0"


def test_lifespan_wires_every_service(client: TestClient) -> None:
    state = client.app.state  # type: ignore[attr-defined]
    for name in (
        "settings",
        "engine",
        "sessionmaker",
        "http",
        "cache",
        "llm",
        "weather",
        "feeds",
        "places",
        "sms",
        "push",
        "alert_poller",
    ):
        assert hasattr(state, name), name
    assert state.alert_poller is None  # disabled in tests
    assert isinstance(state.http, httpx.AsyncClient)
    assert isinstance(state.cache, TTLCache)
    assert isinstance(state.llm, LLMService)
    assert isinstance(state.weather, WeatherService)
    assert isinstance(state.feeds, DisasterFeedService)
    assert isinstance(state.places, PlacesService)
    assert isinstance(state.sms, SMSService)
    assert isinstance(state.push, PushService)


def test_alert_poller_started_and_stopped_when_enabled(
    settings_factory: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    class RecordingPoller:
        def __init__(self, feeds: Any, push: Any, sessionmaker: Any, settings: Settings) -> None:
            assert feeds is not None and push is not None and sessionmaker is not None
            events.append("init")

        def start(self) -> None:
            events.append("start")

        async def stop(self) -> None:
            events.append("stop")

    monkeypatch.setattr("app.main.AlertPoller", RecordingPoller)
    with TestClient(create_app(settings_factory(alert_poller_enabled=True))) as client:
        assert client.get("/api/health").status_code == 200
        assert events == ["init", "start"]
    assert events == ["init", "start", "stop"]
