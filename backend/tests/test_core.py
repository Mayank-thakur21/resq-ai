"""Tests for the foundation: config, logging, errors, security, rate limiting, middleware,
cache, geo helpers, database models, HTTP client and the shared schemas."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
import sqlalchemy.exc
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUserDep, InternalKey, OptionalUserDep, SessionDep
from app.core.config import Settings, get_settings
from app.core.errors import ConflictError, NotFoundError, format_validation_errors
from app.core.logging import (
    JsonFormatter,
    RequestIdFilter,
    configure_logging,
    mask_phone,
    mask_secret,
    request_id_var,
)
from app.core.rate_limit import (
    ConcurrencyLimiter,
    RateLimiter,
    RateLimitState,
    client_ip,
    default_rate_limit,
    ip_bucket,
    normalise_ip,
    reset_rate_limits,
    sos_rate_limit,
)
from app.core.security import (
    JWT_ALGORITHM,
    JWT_AUDIENCE,
    JWT_ISSUER,
    TokenError,
    create_access_token,
    decode_access_token,
    hash_identifier,
)
from app.db.models import (
    Incident,
    IncidentVote,
    NotifiedEvent,
    PushSubscription,
    User,
    utcnow,
)
from app.db.session import create_engine, init_db
from app.main import create_app
from app.schemas.incidents import IncidentCreate
from app.schemas.push import PushSubscribeRequest
from app.schemas.sos import SOSRequest, normalize_e164
from app.schemas.users import UserRegisterRequest
from app.services.cache import TTLCache
from app.services.geo import (
    BoundingBox,
    bounding_box,
    haversine_km,
    round_coord,
    validate_coordinates,
)
from app.services.http import USER_AGENT
from conftest import (
    TEST_INTERNAL_KEY,
    TEST_JWT_SECRET,
    VALID_AUTH,
    VALID_P256DH,
    NetworkBlockedError,
)

# ---------------------------------------------------------------------------------------------
# helpers: a test-only router mounted on a fresh app
# ---------------------------------------------------------------------------------------------
probe_router = APIRouter(prefix="/api/_probe")


@probe_router.get("/ping")
async def probe_ping() -> dict[str, bool]:
    return {"ok": True}


@probe_router.post("/sos-like", dependencies=[Depends(sos_rate_limit)])
async def probe_sos_like() -> dict[str, bool]:
    return {"sent": True}


@probe_router.get("/not-found")
async def probe_not_found() -> None:
    raise NotFoundError("Incident not found.")


@probe_router.get("/conflict")
async def probe_conflict() -> None:
    raise ConflictError()


@probe_router.get("/http-error")
async def probe_http_error() -> None:
    raise HTTPException(status_code=400, detail="Bad thing")


@probe_router.get("/boom")
async def probe_boom() -> None:
    raise RuntimeError("secret internal detail")


@probe_router.get("/coords")
async def probe_coords(lat: float, lon: float) -> dict[str, float]:
    validate_coordinates(lat, lon)
    return {"lat": lat, "lon": lon}


@probe_router.get("/me")
async def probe_me(user: CurrentUserDep) -> dict[str, Any]:
    return user.model_dump()


@probe_router.get("/maybe-me")
async def probe_maybe_me(user: OptionalUserDep) -> dict[str, Any]:
    return {"user": user.model_dump() if user else None}


@probe_router.get("/internal", dependencies=[InternalKey])
async def probe_internal() -> dict[str, bool]:
    return {"ok": True}


@probe_router.get("/db-pool-timeout")
async def probe_db_pool_timeout() -> None:
    raise sqlalchemy.exc.TimeoutError("QueuePool limit of size 5 overflow 10 reached")


@probe_router.get("/db")
async def probe_db(session: SessionDep) -> dict[str, int]:
    count = await session.scalar(select(func.count()).select_from(User))
    return {"users": int(count or 0)}


def build_probe_app(settings: Settings) -> FastAPI:
    """Real app + probe routes wired exactly like ``app.api`` wires feature routers."""
    app = create_app(settings)
    app.include_router(probe_router, dependencies=[Depends(default_rate_limit)])
    return app


@pytest.fixture
def probe_client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(build_probe_app(settings), raise_server_exceptions=False) as client:
        yield client


def probe_client_for(settings: Settings) -> TestClient:
    return TestClient(build_probe_app(settings), raise_server_exceptions=False)


def assert_envelope(response: httpx.Response | Any, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "request_id"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]
    assert body["error"]["request_id"] == response.headers["x-request-id"]
    return body["error"]


# ---------------------------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------------------------
class TestSettings:
    def test_defaults_match_spec(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for field_name in Settings.model_fields:
            monkeypatch.delenv(field_name.upper(), raising=False)
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.app_env == "development"
        assert s.database_url == "sqlite+aiosqlite:///./data/resq.db"
        assert s.gemini_model == "gemini-2.5-flash"
        assert s.rate_limit_default == "120/minute"
        assert s.sos_rate_limit == "5/minute"
        assert (s.weather_cache_ttl, s.feed_cache_ttl, s.places_cache_ttl) == (300, 600, 3600)
        assert s.alert_poll_interval_seconds == 600
        assert s.incident_verify_threshold == 3
        assert s.http_timeout_seconds == 10.0
        assert s.vapid_subject == "mailto:admin@example.com"
        assert not (s.gemini_enabled or s.openweather_enabled or s.twilio_enabled)
        assert not (s.push_enabled or s.user_auth_enabled or s.reliefweb_enabled)

    def test_reads_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("APP_ENV", "Production")
        monkeypatch.setenv("LOG_LEVEL", "warn")
        monkeypatch.setenv("CORS_ORIGINS", " https://a.example , https://b.example,, ")
        monkeypatch.setenv("ALERT_POLLER_ENABLED", "true")
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.is_production
        assert s.log_level == "WARNING"
        assert s.cors_origin_list == ["https://a.example", "https://b.example"]
        assert s.alert_poller_enabled is True

    def test_feature_flags(self, settings_factory: Callable[..., Settings]) -> None:
        s = settings_factory(twilio_account_sid="AC1", twilio_auth_token="tok")
        assert not s.twilio_enabled  # no sender configured
        assert settings_factory(
            twilio_account_sid="AC1", twilio_auth_token="tok", twilio_from_number="+15550001111"
        ).twilio_enabled
        assert settings_factory(
            twilio_account_sid="AC1", twilio_auth_token="tok", twilio_messaging_service_sid="MG1"
        ).twilio_enabled
        assert settings_factory(vapid_private_key="").push_enabled is False
        assert settings_factory(gemini_api_key="g").gemini_enabled
        assert settings_factory(reliefweb_appname="resq").reliefweb_enabled
        assert settings_factory(backend_jwt_secret="").user_auth_enabled is False

    @pytest.mark.parametrize("value", ["5 per minut", "abc", ""])
    def test_invalid_rate_limit_rejected(
        self, settings_factory: Callable[..., Settings], value: str
    ) -> None:
        with pytest.raises(ValidationError):
            settings_factory(sos_rate_limit=value)

    def test_invalid_log_level_rejected(self, settings_factory: Callable[..., Settings]) -> None:
        with pytest.raises(ValidationError):
            settings_factory(log_level="LOUD")

    def test_secrets_hidden_from_repr(self, settings: Settings) -> None:
        text = repr(settings)
        assert TEST_JWT_SECRET not in text
        assert settings.vapid_private_key not in text
        assert "internal_api_key" not in text

    def test_get_settings_is_cached(self) -> None:
        assert get_settings() is get_settings()


# ---------------------------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------------------------
class TestLogging:
    @pytest.mark.parametrize(
        ("raw", "masked"),
        [
            ("+919876543210", "+91******3210"),
            ("+14155550123", "+14*****0123"),
            ("12345678", "******78"),
            ("123", "***"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_mask_phone(self, raw: str | None, masked: str) -> None:
        assert mask_phone(raw) == masked

    def test_mask_secret(self) -> None:
        assert mask_secret("sk_live_1234567890abcdef") == "********cdef"
        assert mask_secret("short") == "*****"
        assert mask_secret("") == ""

    def test_json_formatter_includes_request_id_and_extra(self) -> None:
        token = request_id_var.set("rid-123")
        try:
            record = logging.LogRecord(
                "resq.test", logging.INFO, __file__, 1, "hello %s", ("x",), None
            )
            RequestIdFilter().filter(record)
            record.user_id = "u1"
            payload = json.loads(JsonFormatter().format(record))
        finally:
            request_id_var.reset(token)
        assert payload["message"] == "hello x"
        assert payload["request_id"] == "rid-123"
        assert payload["level"] == "INFO"
        assert payload["user_id"] == "u1"
        assert datetime.fromisoformat(payload["ts"]).tzinfo is not None

    def test_json_formatter_exception(self) -> None:
        try:
            raise ValueError("bad")
        except ValueError:
            import sys

            record = logging.LogRecord(
                "resq.test", logging.ERROR, __file__, 1, "failed", (), sys.exc_info()
            )
        RequestIdFilter().filter(record)
        payload = json.loads(JsonFormatter().format(record))
        assert "ValueError: bad" in payload["exc_info"]

    def test_configure_logging_is_idempotent(self) -> None:
        root = logging.getLogger()
        configure_logging("DEBUG", json=True)
        configure_logging("INFO", json=False)
        ours = [h for h in root.handlers if h.get_name() == "resq-root-handler"]
        assert len(ours) == 1
        assert root.level == logging.INFO
        # httpx would log full URLs (incl. API keys) at INFO.
        assert logging.getLogger("httpx").level >= logging.WARNING

    def test_request_logs_never_contain_query_strings(
        self, probe_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Regression: uvicorn's access log (on by default) recorded every query string, i.e.
        users' coordinates, next to the app's own path-only access line."""
        configure_logging("INFO")
        assert not logging.getLogger("uvicorn.access").isEnabledFor(logging.INFO)
        with caplog.at_level(logging.INFO):
            probe_client.get("/api/_probe/ping", params={"lat": "28.6139", "lon": "77.209"})
        access = [r.getMessage() for r in caplog.records if r.name == "app.access"]
        assert access and all("/api/_probe/ping" in line for line in access)
        assert not any("28.6139" in r.getMessage() for r in caplog.records)
        dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
        cmd = next(line for line in dockerfile.splitlines() if line.startswith("CMD"))
        assert "--no-access-log" in cmd


# ---------------------------------------------------------------------------------------------
# error envelope + middleware
# ---------------------------------------------------------------------------------------------
class TestErrors:
    def test_app_error(self, probe_client: TestClient) -> None:
        err = assert_envelope(probe_client.get("/api/_probe/not-found"), 404, "not_found")
        assert err["message"] == "Incident not found."
        assert_envelope(probe_client.get("/api/_probe/conflict"), 409, "conflict")

    def test_http_exception_and_routing_errors(self, probe_client: TestClient) -> None:
        err = assert_envelope(probe_client.get("/api/_probe/http-error"), 400, "bad_request")
        assert err["message"] == "Bad thing"
        assert_envelope(probe_client.get("/api/does-not-exist"), 404, "not_found")
        assert_envelope(probe_client.delete("/api/_probe/ping"), 405, "method_not_allowed")

    def test_validation_error_is_flattened(self, probe_client: TestClient) -> None:
        response = probe_client.get("/api/_probe/coords", params={"lat": "north"})
        err = assert_envelope(response, 422, "validation_error")
        assert "query.lat" in err["message"]
        assert "query.lon" in err["message"]

    def test_invalid_input_error(self, probe_client: TestClient) -> None:
        response = probe_client.get("/api/_probe/coords", params={"lat": 95, "lon": 0})
        err = assert_envelope(response, 422, "invalid_input")
        assert "lat" in err["message"]

    def test_unhandled_error_is_500_without_details(
        self, probe_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.ERROR, logger="app.core.errors"):
            response = probe_client.get("/api/_probe/boom")
        err = assert_envelope(response, 500, "internal_error")
        assert "secret internal detail" not in response.text
        assert err["message"] == "An unexpected error occurred."
        assert any(r.exc_info for r in caplog.records), "traceback must be logged"

    def test_database_pool_timeout_is_503_service_busy(self, probe_client: TestClient) -> None:
        """An exhausted connection pool is a temporary overload, not an internal error."""
        response = probe_client.get("/api/_probe/db-pool-timeout")
        err = assert_envelope(response, 503, "service_busy")
        assert "QueuePool" not in err["message"]
        assert int(response.headers["retry-after"]) >= 1

    def test_format_validation_errors(self) -> None:
        msg = format_validation_errors(
            [{"loc": ("body", "contact_numbers", 0), "msg": "bad"}, {"loc": (), "msg": "x"}]
        )
        assert msg == "body.contact_numbers.0: bad; x"


class TestRequestContext:
    def test_inbound_request_id_is_echoed(self, client: TestClient) -> None:
        response = client.get("/api/health", headers={"X-Request-ID": "proxy-abc.123"})
        assert response.headers["x-request-id"] == "proxy-abc.123"

    def test_malformed_request_id_is_replaced(self, client: TestClient) -> None:
        response = client.get("/api/health", headers={"X-Request-ID": "bad id\twith spaces"})
        rid = response.headers["x-request-id"]
        assert rid != "bad id\twith spaces" and len(rid) == 32

    def test_error_body_request_id_matches_header(self, probe_client: TestClient) -> None:
        response = probe_client.get("/api/nope", headers={"X-Request-ID": "trace-1"})
        assert response.json()["error"]["request_id"] == "trace-1"

    def test_cors_preflight(self, client: TestClient) -> None:
        response = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


# ---------------------------------------------------------------------------------------------
# security
# ---------------------------------------------------------------------------------------------
class TestTokens:
    def test_roundtrip(self) -> None:
        token = create_access_token("github:42", "a@b.co", "Asha", TEST_JWT_SECRET)
        user = decode_access_token(token, TEST_JWT_SECRET)
        assert (user.id, user.email, user.name) == ("github:42", "a@b.co", "Asha")

    def test_expired(self) -> None:
        token = create_access_token("u1", None, None, TEST_JWT_SECRET, expires_in=-120)
        with pytest.raises(TokenError) as info:
            decode_access_token(token, TEST_JWT_SECRET)
        assert info.value.expired

    def test_leeway_accepts_slightly_expired(self) -> None:
        token = create_access_token("u1", None, None, TEST_JWT_SECRET, expires_in=-10)
        assert decode_access_token(token, TEST_JWT_SECRET).id == "u1"

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"secret": "another-secret-another-secret-another"},
            {"audience": "someone-else"},
            {"issuer": "evil"},
        ],
    )
    def test_rejects_wrong_signature_audience_issuer(self, kwargs: dict[str, str]) -> None:
        secret = kwargs.pop("secret", TEST_JWT_SECRET)
        token = create_access_token("u1", None, None, secret, **kwargs)
        with pytest.raises(TokenError):
            decode_access_token(token, TEST_JWT_SECRET)

    def test_requires_iat_and_sub(self) -> None:
        now = int(time.time())
        base = {"iss": JWT_ISSUER, "aud": JWT_AUDIENCE, "exp": now + 60}
        for claims in (
            {**base, "sub": "u1"},
            {**base, "iat": now},
            {**base, "iat": now, "sub": ""},
        ):
            token = jwt.encode(claims, TEST_JWT_SECRET, algorithm=JWT_ALGORITHM)
            with pytest.raises(TokenError):
                decode_access_token(token, TEST_JWT_SECRET)

    def test_rejects_alg_none(self) -> None:
        now = int(time.time())
        claims = {"sub": "u1", "iat": now, "exp": now + 60, "iss": JWT_ISSUER, "aud": JWT_AUDIENCE}
        token = jwt.encode(claims, key=None, algorithm="none")
        with pytest.raises(TokenError):
            decode_access_token(token, TEST_JWT_SECRET)

    def test_hash_identifier(self) -> None:
        assert hash_identifier("1.2.3.4", "salt") == hash_identifier("1.2.3.4", "salt")
        assert hash_identifier("1.2.3.4", "salt") != hash_identifier("1.2.3.4", "pepper")
        assert len(hash_identifier("1.2.3.4", "salt")) == 64


class TestAuthDependencies:
    def test_current_user_requires_token(self, probe_client: TestClient) -> None:
        response = probe_client.get("/api/_probe/me")
        assert_envelope(response, 401, "unauthorized")
        assert response.headers["www-authenticate"] == "Bearer"

    def test_current_user_valid(
        self, probe_client: TestClient, auth_headers: Callable[..., dict[str, str]]
    ) -> None:
        response = probe_client.get(
            "/api/_probe/me", headers=auth_headers("u9", "Ravi", email="r@x.io")
        )
        assert response.status_code == 200
        assert response.json() == {"id": "u9", "email": "r@x.io", "name": "Ravi"}

    def test_current_user_expired_and_garbage(
        self, probe_client: TestClient, make_token: Callable[..., str]
    ) -> None:
        expired = make_token(expires_in=-300)
        err = assert_envelope(
            probe_client.get("/api/_probe/me", headers={"Authorization": f"Bearer {expired}"}),
            401,
            "unauthorized",
        )
        assert err["message"] == "Token expired."
        for header in ("Bearer not-a-jwt", "Basic dXNlcjpwYXNz", "Bearer"):
            response = probe_client.get("/api/_probe/me", headers={"Authorization": header})
            assert_envelope(response, 401, "unauthorized")

    def test_current_user_not_configured(
        self, settings_factory: Callable[..., Settings], make_token: Callable[..., str]
    ) -> None:
        with probe_client_for(settings_factory(backend_jwt_secret="")) as client:
            response = client.get(
                "/api/_probe/me", headers={"Authorization": f"Bearer {make_token()}"}
            )
        assert_envelope(response, 503, "not_configured")

    def test_optional_user(
        self, probe_client: TestClient, auth_headers: Callable[..., dict[str, str]]
    ) -> None:
        assert probe_client.get("/api/_probe/maybe-me").json() == {"user": None}
        bad = probe_client.get("/api/_probe/maybe-me", headers={"Authorization": "Bearer junk"})
        assert bad.status_code == 200 and bad.json() == {"user": None}
        ok = probe_client.get("/api/_probe/maybe-me", headers=auth_headers("u2", "Mei"))
        assert ok.json()["user"]["id"] == "u2"

    def test_internal_key(self, probe_client: TestClient, internal_headers: dict[str, str]) -> None:
        assert_envelope(probe_client.get("/api/_probe/internal"), 401, "unauthorized")
        wrong = probe_client.get("/api/_probe/internal", headers={"X-Internal-Key": "nope"})
        assert_envelope(wrong, 401, "unauthorized")
        assert probe_client.get("/api/_probe/internal", headers=internal_headers).json() == {
            "ok": True
        }

    def test_internal_key_not_configured(self, settings_factory: Callable[..., Settings]) -> None:
        with probe_client_for(settings_factory(internal_api_key="")) as client:
            response = client.get("/api/_probe/internal", headers={"X-Internal-Key": "x"})
        assert_envelope(response, 503, "not_configured")


# ---------------------------------------------------------------------------------------------
# rate limiting (in-process moving window; slowapi's middleware cannot see FastAPI 0.162
# included routers, see app/core/rate_limit.py)
# ---------------------------------------------------------------------------------------------
class TestRateLimit:
    def test_default_limit_429_with_headers(
        self, settings_factory: Callable[..., Settings]
    ) -> None:
        with probe_client_for(settings_factory(rate_limit_default="3/minute")) as client:
            responses = [client.get("/api/_probe/ping") for _ in range(4)]
        assert [r.status_code for r in responses] == [200, 200, 200, 429]
        first = responses[0]
        assert first.headers["x-ratelimit-limit"] == "3"
        assert first.headers["x-ratelimit-remaining"] == "2"
        assert "x-ratelimit-reset" in first.headers
        assert "retry-after" not in first.headers  # only meaningful on 429
        limited = responses[-1]
        err = assert_envelope(limited, 429, "rate_limited")
        assert "3 per 1 minute" in err["message"]
        assert 0 < int(limited.headers["retry-after"]) <= 61
        assert limited.headers["x-ratelimit-remaining"] == "0"

    def test_decorated_route_uses_sos_limit(
        self, settings_factory: Callable[..., Settings]
    ) -> None:
        settings = settings_factory(rate_limit_default="100/minute", sos_rate_limit="2/minute")
        with probe_client_for(settings) as client:
            statuses = [client.post("/api/_probe/sos-like").status_code for _ in range(3)]
            ok_after = client.get("/api/_probe/ping")
            sos_response = client.post("/api/_probe/sos-like")
        assert statuses == [200, 200, 429]
        assert ok_after.status_code == 200  # other routes unaffected
        assert sos_response.headers["x-ratelimit-limit"] == "2"
        assert int(sos_response.headers["retry-after"]) > 0

    def test_buckets_per_user_and_forwarded_ip(
        self,
        settings_factory: Callable[..., Settings],
        auth_headers: Callable[..., dict[str, str]],
    ) -> None:
        with probe_client_for(settings_factory(rate_limit_default="1/minute")) as client:
            assert client.get("/api/_probe/ping", headers=auth_headers("alice")).status_code == 200
            assert client.get("/api/_probe/ping", headers=auth_headers("alice")).status_code == 429
            assert client.get("/api/_probe/ping", headers=auth_headers("bob")).status_code == 200
            # Browsers relayed by our Next.js server: keyed on the address it reports.
            key = TEST_INTERNAL_KEY
            relayed = {"X-ResQ-Client-IP": "203.0.113.7", "X-Internal-Key": key}
            assert client.get("/api/_probe/ping", headers=relayed).status_code == 200
            assert client.get("/api/_probe/ping", headers=relayed).status_code == 429
            other = {"X-ResQ-Client-IP": "198.51.100.9", "X-Internal-Key": key}
            assert client.get("/api/_probe/ping", headers=other).status_code == 200

    def test_client_supplied_addresses_do_not_create_new_buckets(
        self, settings_factory: Callable[..., Settings]
    ) -> None:
        """Regression (critical): forged X-Forwarded-For used to bypass every IP limit."""
        with probe_client_for(settings_factory(rate_limit_default="2/minute")) as client:
            statuses = [
                client.get(
                    "/api/_probe/ping",
                    headers={
                        "X-Forwarded-For": f"10.0.0.{i}, 172.18.0.5",
                        "X-ResQ-Client-IP": f"10.9.0.{i}",  # no internal key: ignored
                    },
                ).status_code
                for i in range(4)
            ]
        assert statuses == [200, 200, 429, 429]

    def test_client_ip_resolution(self, settings_factory: Callable[..., Settings]) -> None:
        def resolve(settings: Settings, headers: dict[str, str], peer: str = "192.0.2.1") -> str:
            app = FastAPI()
            app.state.settings = settings
            scope = {
                "type": "http",
                "app": app,
                "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                "client": (peer, 1234),
            }
            return client_ip(Request(scope))

        plain = settings_factory()
        key = plain.internal_api_key
        assert resolve(plain, {}) == "192.0.2.1"
        assert resolve(plain, {"X-Forwarded-For": "203.0.113.7"}) == "192.0.2.1"
        assert resolve(plain, {"X-ResQ-Client-IP": "203.0.113.7"}) == "192.0.2.1"
        assert (
            resolve(plain, {"X-ResQ-Client-IP": "203.0.113.7", "X-Internal-Key": "nope"})
            == "192.0.2.1"
        )
        relayed = {"X-ResQ-Client-IP": "203.0.113.7", "X-Internal-Key": key}
        assert resolve(plain, relayed) == "203.0.113.7"
        assert resolve(plain, {**relayed, "X-ResQ-Client-IP": "not-an-ip"}) == "192.0.2.1"
        assert resolve(plain, {**relayed, "X-ResQ-Client-IP": "::ffff:203.0.113.9"}) == (
            "203.0.113.9"
        )
        # The internal key alone never makes X-Forwarded-For trusted.
        assert resolve(plain, {"X-Internal-Key": key, "X-Forwarded-For": "1.2.3.4"}) == "192.0.2.1"

        one_hop = settings_factory(trusted_proxy_hops=1)
        chain = {"X-Forwarded-For": "10.0.0.1, 203.0.113.7"}  # forged left, real right
        assert resolve(one_hop, chain) == "203.0.113.7"
        assert resolve(one_hop, {"X-Forwarded-For": "[2001:db8::1]:443"}) == "2001:db8::1"
        assert resolve(one_hop, {"X-Forwarded-For": "203.0.113.7:5555"}) == "203.0.113.7"
        assert resolve(one_hop, {"X-Forwarded-For": "garbage"}) == "192.0.2.1"
        two_hops = settings_factory(trusted_proxy_hops=2)
        assert resolve(two_hops, {"X-Forwarded-For": "6.6.6.6, 203.0.113.7, 10.0.0.2"}) == (
            "203.0.113.7"
        )
        assert resolve(two_hops, {"X-Forwarded-For": "203.0.113.7"}) == "203.0.113.7"

    def test_normalise_ip(self) -> None:
        assert normalise_ip(" 203.0.113.7 ") == "203.0.113.7"
        assert normalise_ip("2001:DB8::1") == "2001:db8::1"
        assert normalise_ip("[2001:db8::1]") == "2001:db8::1"
        assert normalise_ip("unknown") is None
        assert normalise_ip("") is None
        assert normalise_ip(None) is None

    def test_health_is_exempt(self, settings_factory: Callable[..., Settings]) -> None:
        with probe_client_for(settings_factory(rate_limit_default="1/minute")) as client:
            assert all(client.get("/api/health").status_code == 200 for _ in range(3))
            assert all(client.get("/").status_code == 200 for _ in range(3))

    def test_reset(self, settings_factory: Callable[..., Settings]) -> None:
        with probe_client_for(settings_factory(rate_limit_default="1/minute")) as client:
            assert client.get("/api/_probe/ping").status_code == 200
            assert client.get("/api/_probe/ping").status_code == 429
            reset_rate_limits()
            assert client.get("/api/_probe/ping").status_code == 200

    def test_limiter_multiple_limits_and_state(self) -> None:
        local = RateLimiter()
        first = local.hit("5/minute;2/hour", "ip:1", "/x")
        assert first.allowed and (first.limit, first.remaining) == (2, 1)  # tightest reported
        assert local.hit("5/minute;2/hour", "ip:1", "/x").allowed
        blocked = local.hit("5/minute;2/hour", "ip:1", "/x")
        assert not blocked.allowed and blocked.description == "2 per 1 hour"
        assert local.hit("5/minute;2/hour", "ip:2", "/x").allowed  # other client
        assert local.hit("5/minute;2/hour", "ip:1", "/y").allowed  # other bucket
        local.reset()
        assert local.hit("5/minute;2/hour", "ip:1", "/x").allowed
        with pytest.raises(ValueError):
            local.hit("nonsense", "ip:1", "/x")

    def test_limiter_peek_test_and_clear_do_not_count(self) -> None:
        local = RateLimiter()
        assert local.test("2/minute", "k") and local.peek("2/minute", "k").remaining == 2
        local.hit("2/minute", "k")
        local.hit("2/minute", "k")
        assert not local.test("2/minute", "k")
        peeked = local.peek("2/minute", "k")
        assert not peeked.allowed and peeked.remaining == 0 and peeked.retry_after() >= 1
        local.clear("2/minute", "k")
        assert local.test("2/minute", "k")

    def test_state_headers_and_retry_after(self) -> None:
        state = RateLimitState(
            allowed=False, limit=5, remaining=0, reset_at=1000.2, description="5 per 1 minute"
        )
        assert state.headers() == {
            "X-RateLimit-Limit": "5",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1001",
        }
        assert state.retry_after(now=990.0) == 11
        assert state.retry_after(now=2000.0) == 1

    def test_hit_is_all_or_nothing(self) -> None:
        """A request refused by one limit must not consume the others (reservations)."""
        local = RateLimiter()
        assert local.hit("1/hour", "k").allowed
        refused = local.hit("5/minute;1/hour", "k")
        assert not refused.allowed and refused.description == "1 per 1 hour"
        # The refused hit did not count against the minute limit.
        assert local.count("5/minute", "k") == 0

    def test_refund_and_count(self) -> None:
        local = RateLimiter()
        for _ in range(3):
            local.hit("3/minute;10/hour", "k")
        assert not local.test("3/minute;10/hour", "k")
        assert local.count("3/minute;10/hour", "k") == 3
        local.refund("3/minute;10/hour", "k")
        assert local.count("3/minute;10/hour", "k") == 2
        assert local.test("3/minute;10/hour", "k")
        local.refund("3/minute", "never-hit")  # no-op, never raises
        assert local.count("3/minute", "never-hit") == 0

    def test_prune_forgets_keys_whose_windows_ran_out(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: ``limits`` kept every key it ever saw, so rotating clients (one per
        IPv6 ``/64``) grew the process's memory for as long as it ran."""
        local = RateLimiter()
        for network in range(50):
            local.hit("1/second", "client", f"2001:db8:{network:x}::/64")
        local.hit("5/hour", "live")
        local.refund("1/minute", "never-hit")  # leaves a lock behind in the storage
        storage = local._storage
        assert len(storage.events) == 51
        assert local.prune() == 0  # nothing has expired yet

        later = time.time() + 2  # entries and prune() both read time.time()
        monkeypatch.setattr(time, "time", lambda: later)
        assert local.prune() == 50
        assert list(storage.events) == ["LIMITER/live/5/1/hour"]
        assert set(storage.locks) <= set(storage.events)
        # Counting is unchanged: the live window survives, the pruned ones start afresh.
        assert local.count("5/hour", "live") == 1
        assert local.hit("1/second", "client", "2001:db8::/64").allowed

    def test_hit_prunes_periodically(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(RateLimiter, "PRUNE_INTERVAL_SECONDS", 0.0)
        local = RateLimiter()
        for network in range(20):
            local.hit("1/second", "client", str(network))
        later = time.time() + 2
        monkeypatch.setattr(time, "time", lambda: later)
        local.hit("1/second", "client", "new")
        assert list(local._storage.events) == ["LIMITER/client/new/1/1/second"]

    def test_ip_bucket_groups_ipv6_by_64(self) -> None:
        assert ip_bucket("203.0.113.7") == "203.0.113.7"
        assert ip_bucket("2001:db8:1:2::1") == "2001:db8:1:2::/64"
        assert ip_bucket("2001:db8:1:2::dead:beef") == "2001:db8:1:2::/64"
        assert ip_bucket("2001:db8:1:3::1") == "2001:db8:1:3::/64"
        assert ip_bucket("::ffff:203.0.113.9") == "203.0.113.9"
        assert ip_bucket("unknown") == "unknown"

    def test_ipv6_rotation_inside_a_64_shares_one_bucket(
        self, settings_factory: Callable[..., Settings]
    ) -> None:
        """Regression: every address of a /64 got its own bucket (2^64 fresh buckets)."""
        with probe_client_for(settings_factory(sos_rate_limit="2/minute")) as client:
            statuses = [
                client.post(
                    "/api/_probe/sos-like",
                    headers={
                        "X-ResQ-Client-IP": f"2001:db8:1:2::{i + 1:x}",
                        "X-Internal-Key": TEST_INTERNAL_KEY,
                    },
                ).status_code
                for i in range(4)
            ]
            other = client.post(
                "/api/_probe/sos-like",
                headers={
                    "X-ResQ-Client-IP": "2001:db8:1:3::1",
                    "X-Internal-Key": TEST_INTERNAL_KEY,
                },
            )
        assert statuses == [200, 200, 429, 429]
        assert other.status_code == 200

    def test_concurrency_limiter(self) -> None:
        local = ConcurrencyLimiter()
        assert local.try_acquire("k", 2) and local.try_acquire("k", 2)
        assert not local.try_acquire("k", 2)
        assert local.try_acquire("other", 2)
        local.release("k")
        assert local.in_flight("k") == 1 and local.try_acquire("k", 2)
        for _ in range(5):
            local.release("k")  # never negative
        assert local.in_flight("k") == 0
        local.reset()
        assert local.in_flight("other") == 0

    def test_disabled_limiter(self, settings_factory: Callable[..., Settings]) -> None:
        with probe_client_for(settings_factory(rate_limit_default="1/minute")) as client:
            client.app.state.limiter = RateLimiter(enabled=False)  # type: ignore[attr-defined]
            assert all(client.get("/api/_probe/ping").status_code == 200 for _ in range(3))


# ---------------------------------------------------------------------------------------------
# cache
# ---------------------------------------------------------------------------------------------
class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class TestTTLCache:
    async def test_get_or_set_caches_until_expiry(self) -> None:
        clock = FakeClock()
        cache = TTLCache(clock=clock)
        calls = 0

        async def factory() -> int:
            nonlocal calls
            calls += 1
            return calls

        assert await cache.get_or_set("k", 10, factory) == 1
        assert await cache.get_or_set("k", 10, factory) == 1
        clock.now += 11
        assert await cache.get_or_set("k", 10, factory) == 2
        assert (cache.hits, cache.misses) == (1, 2)

    async def test_zero_ttl_and_exceptions_are_not_cached(self) -> None:
        cache = TTLCache()

        async def boom() -> int:
            raise RuntimeError("upstream down")

        with pytest.raises(RuntimeError):
            await cache.get_or_set("k", 60, boom)
        assert "k" not in cache

        async def value() -> str:
            return "v"

        assert await cache.get_or_set("z", 0, value) == "v"
        assert "z" not in cache

    async def test_single_flight(self) -> None:
        cache = TTLCache()
        calls = 0

        async def slow() -> str:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return "done"

        results = await asyncio.gather(*(cache.get_or_set("k", 60, slow) for _ in range(10)))
        assert results == ["done"] * 10
        assert calls == 1
        assert cache._locks == {} and cache._lock_users == {} and cache._loaded == {}

    async def test_zero_ttl_shares_one_load_with_concurrent_callers(self) -> None:
        """Regression: with TTL 0 the single-flight lock made identical concurrent loads run
        one after another (5 callers of a 1 s load finished at 1, 2, 3, 4 and 5 s)."""
        cache = TTLCache()
        calls = 0

        async def slow() -> int:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.2)
            return calls

        loop = asyncio.get_running_loop()
        started = loop.time()
        results = await asyncio.gather(*(cache.get_or_set("k", 0, slow) for _ in range(5)))
        assert results == [1] * 5
        assert calls == 1
        assert loop.time() - started < 0.6
        assert "k" not in cache and cache._loaded == {}
        # Nothing was stored: the next (non-concurrent) call loads again.
        assert await cache.get_or_set("k", 0, slow) == 2

    async def test_waiters_after_a_failed_load_retry_themselves(self) -> None:
        cache = TTLCache()
        attempts = 0

        async def flaky() -> str:
            nonlocal attempts
            attempts += 1
            await asyncio.sleep(0.01)
            if attempts == 1:
                raise RuntimeError("upstream down")
            return "ok"

        results = await asyncio.gather(
            *(cache.get_or_set("k", 0, flaky) for _ in range(3)), return_exceptions=True
        )
        assert isinstance(results[0], RuntimeError)
        assert results[1:] == ["ok", "ok"]
        assert attempts == 2

    def test_lru_eviction_and_clear(self) -> None:
        cache = TTLCache(max_size=2)
        cache.set("a", 1, 60)
        cache.set("b", 2, 60)
        assert cache.get("a") == 1  # "a" becomes most recently used
        cache.set("c", 3, 60)
        assert "b" not in cache and cache.get("a") == 1 and cache.get("c") == 3
        assert len(cache) == 2
        cache.delete("a")
        assert cache.get("a", "missing") == "missing"
        cache.clear()
        assert len(cache) == 0

    def test_invalid_max_size(self) -> None:
        with pytest.raises(ValueError):
            TTLCache(max_size=0)


# ---------------------------------------------------------------------------------------------
# geo
# ---------------------------------------------------------------------------------------------
class TestGeo:
    def test_haversine(self) -> None:
        delhi, mumbai = (28.6139, 77.2090), (19.0760, 72.8777)
        assert 1140 < haversine_km(*delhi, *mumbai) < 1160
        assert haversine_km(*delhi, *delhi) == 0
        assert haversine_km(0, 0, 0, 180) == pytest.approx(20015.1, rel=1e-3)

    def test_bounding_box_contains_points_within_radius(self) -> None:
        lat, lon, radius = 28.6, 77.2, 25.0
        box = bounding_box(lat, lon, radius)
        assert isinstance(box, BoundingBox)
        for d_lat, d_lon in ((0.2, 0.0), (-0.2, 0.0), (0.0, 0.25), (0.0, -0.25), (0.15, 0.15)):
            p_lat, p_lon = lat + d_lat, lon + d_lon
            if haversine_km(lat, lon, p_lat, p_lon) <= radius:
                assert box.contains(p_lat, p_lon)
        assert not box.contains(lat + 1, lon)

    def test_bounding_box_edges(self) -> None:
        assert bounding_box(89.9, 10, 50)[2:] == (-180.0, 180.0)
        wrap = bounding_box(0, 179.9, 50)
        assert (wrap.min_lon, wrap.max_lon) == (-180.0, 180.0)
        with pytest.raises(ValueError):
            bounding_box(0, 0, -1)

    def test_validators_and_rounding(self) -> None:
        assert validate_coordinates(10, 20) == (10.0, 20.0)
        from app.core.errors import InvalidInputError

        for bad in ((91, 0), (0, 181), (float("nan"), 0)):
            with pytest.raises(InvalidInputError):
                validate_coordinates(*bad)
        assert round_coord(28.61394) == 28.61
        assert str(round_coord(-0.001)) == "0.0"


# ---------------------------------------------------------------------------------------------
# database
# ---------------------------------------------------------------------------------------------
class TestDatabase:
    def test_session_dependency(self, probe_client: TestClient) -> None:
        assert probe_client.get("/api/_probe/db").json() == {"users": 0}

    def test_models_roundtrip_utc(self, client: TestClient, run_db: Callable[..., Any]) -> None:
        naive = datetime(2026, 1, 1, 12, 0, 0)

        async def scenario(session: AsyncSession) -> tuple[datetime, datetime]:
            user = User(email="a@b.co", name="A", password_hash="x", created_at=naive)
            incident = Incident(
                lat=28.6,
                lon=77.2,
                disaster_type="flood",
                severity="high",
                description="Water rising fast",
                reporter_id="u1",
                reporter_name="A",
            )
            session.add_all([user, incident])
            await session.commit()
            session.expunge_all()
            loaded_user = await session.get(User, user.id)
            loaded_incident = await session.get(Incident, incident.id)
            assert loaded_user is not None and loaded_incident is not None
            assert loaded_incident.status == "open" and loaded_incident.upvotes == 0
            assert len(loaded_user.id) == 36
            return loaded_user.created_at, loaded_incident.created_at

        user_created, incident_created = run_db(scenario)
        assert user_created == naive.replace(tzinfo=UTC)
        assert incident_created.tzinfo is not None
        assert abs(utcnow() - incident_created) < timedelta(minutes=1)

    def test_unique_constraints(self, client: TestClient, run_db: Callable[..., Any]) -> None:
        async def duplicate(session: AsyncSession, *objects: Any) -> bool:
            session.add_all(objects)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return True
            return False

        async def scenario(session: AsyncSession) -> list[bool]:
            results = [
                await duplicate(
                    session,
                    User(email="dup@x.io", name="A", password_hash="h"),
                    User(email="dup@x.io", name="B", password_hash="h"),
                ),
                await duplicate(
                    session,
                    NotifiedEvent(source="gdacs", event_id="EQ-1"),
                    NotifiedEvent(source="gdacs", event_id="EQ-1"),
                ),
            ]
            incident = Incident(
                lat=1,
                lon=2,
                disaster_type="fire",
                severity="low",
                description="Smoke seen nearby",
                reporter_id="u1",
                reporter_name="A",
            )
            session.add(incident)
            await session.commit()
            results.append(
                await duplicate(
                    session,
                    IncidentVote(incident_id=incident.id, user_id="u2"),
                    IncidentVote(incident_id=incident.id, user_id="u2"),
                )
            )
            return results

        assert run_db(scenario) == [True, True, True]

    def test_database_errors_never_contain_row_values(
        self, client: TestClient, run_db: Callable[..., Any]
    ) -> None:
        """Regression: error texts (which handlers log) embedded the bound parameters —
        emails, password hashes, SOS names, messages and exact locations."""

        async def scenario(session: AsyncSession) -> str:
            session.add(User(email="priya@example.com", name="Priya", password_hash="$2b$x"))
            await session.commit()
            session.add(User(email="priya@example.com", name="Priya", password_hash="$2b$y"))
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                return str(exc)
            raise AssertionError("duplicate email was accepted")

        message = run_db(scenario)
        assert "UNIQUE" in message
        assert "priya@example.com" not in message
        assert "$2b$" not in message
        assert "hide_parameters" in message  # SQLAlchemy's placeholder text

    def test_foreign_keys_cascade(self, client: TestClient, run_db: Callable[..., Any]) -> None:
        async def scenario(session: AsyncSession) -> tuple[int, bool]:
            incident = Incident(
                lat=1,
                lon=2,
                disaster_type="fire",
                severity="low",
                description="Smoke seen nearby",
                reporter_id="u1",
                reporter_name="A",
            )
            session.add(incident)
            await session.flush()
            session.add(IncidentVote(incident_id=incident.id, user_id="u2"))
            await session.commit()
            await session.delete(incident)
            await session.commit()
            remaining = await session.scalar(select(func.count()).select_from(IncidentVote))
            orphan_rejected = False
            session.add(IncidentVote(incident_id="missing", user_id="u3"))
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                orphan_rejected = True
            return int(remaining or 0), orphan_rejected

        assert run_db(scenario) == (0, True)

    def test_push_subscription_helpers(self) -> None:
        sub = PushSubscription(
            endpoint="https://fcm.googleapis.com/fcm/send/abc",
            p256dh="p",
            auth="a",
            topics="incidents, disasters",
        )
        assert sub.topic_list == ["incidents", "disasters"]
        assert not sub.has_location
        assert sub.subscription_info() == {
            "endpoint": "https://fcm.googleapis.com/fcm/send/abc",
            "keys": {"p256dh": "p", "auth": "a"},
        }

    async def test_init_db_adds_columns_missing_from_older_databases(
        self, settings_factory: Callable[..., Settings]
    ) -> None:
        settings = settings_factory()
        engine = create_engine(settings)
        try:
            async with engine.begin() as conn:
                # push_subscriptions as created by the first release (no failure_count).
                await conn.execute(
                    text(
                        "CREATE TABLE push_subscriptions (id VARCHAR(36) PRIMARY KEY, "
                        "created_at DATETIME, updated_at DATETIME, endpoint VARCHAR(2048) "
                        "UNIQUE, p256dh VARCHAR(512), auth VARCHAR(256), user_id VARCHAR(128), "
                        "lat FLOAT, lon FLOAT, radius_km FLOAT, topics VARCHAR(128))"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, radius_km, "
                        "topics) VALUES ('old', 'https://fcm.googleapis.com/fcm/send/o', 'k', "
                        "'a', 50, 'incidents')"
                    )
                )
            await init_db(engine)
            await init_db(engine)  # idempotent
            async with engine.connect() as conn:
                value = await conn.scalar(
                    text("SELECT failure_count FROM push_subscriptions WHERE id = 'old'")
                )
            assert value == 0
        finally:
            await engine.dispose()


# ---------------------------------------------------------------------------------------------
# outbound HTTP
# ---------------------------------------------------------------------------------------------
class TestHttpClient:
    def test_shared_client_is_mockable_with_respx(
        self, client: TestClient, respx_mock: Any
    ) -> None:
        route = respx_mock.get("https://upstream.example/data").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        http: httpx.AsyncClient = client.app.state.http  # type: ignore[attr-defined]
        response = client.portal.call(http.get, "https://upstream.example/data")  # type: ignore[union-attr]
        assert response.json() == {"ok": True}
        assert route.calls.last.request.headers["user-agent"] == USER_AGENT
        assert USER_AGENT.startswith("ResQ-AI/2.0 (+https://github.com/")

    async def test_real_network_is_blocked(self) -> None:
        async with httpx.AsyncClient() as http:
            with pytest.raises(NetworkBlockedError):
                await http.get("https://example.org/")


# ---------------------------------------------------------------------------------------------
# shared schemas (contract rules other modules rely on)
# ---------------------------------------------------------------------------------------------
class TestSchemas:
    def test_sos_numbers_normalised_and_deduped(self) -> None:
        req = SOSRequest(
            lat=28.6,
            lon=77.2,
            contact_numbers=["+91 98765-43210", "+919876543210", "0044 20 7946 0958"],
        )
        assert req.contact_numbers == ["+919876543210", "+442079460958"]
        assert req.message == "SOS! I need help!"
        assert normalize_e164("+1 (415) 555-0123") == "+14155550123"

    @pytest.mark.parametrize(
        "bad", ["9876543210", "+0123456789", "+12", "+1234567890123456", "abc"]
    )
    def test_sos_rejects_non_e164(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            SOSRequest(lat=0, lon=0, contact_numbers=[bad])

    def test_sos_limits(self) -> None:
        with pytest.raises(ValidationError):
            SOSRequest(lat=0, lon=0, contact_numbers=[f"+9198765432{i:02d}" for i in range(11)])
        with pytest.raises(ValidationError):
            SOSRequest(lat=91, lon=0)
        with pytest.raises(ValidationError):
            SOSRequest(lat=0, lon=0, message="x" * 301)

    def test_incident_image_url(self) -> None:
        base = {
            "lat": 1,
            "lon": 2,
            "disaster_type": "flood",
            "severity": "high",
            "description": "Road under water",
        }
        assert IncidentCreate(**base, image_url="https://img.example/a.jpg").image_url
        assert IncidentCreate(**base, image_url="").image_url is None
        for bad in ("javascript:alert(1)", "ftp://x/y", "https://x/" + "a" * 500, "/relative"):
            with pytest.raises(ValidationError):
                IncidentCreate(**base, image_url=bad)
        with pytest.raises(ValidationError):
            IncidentCreate(**{**base, "disaster_type": "alien"})
        with pytest.raises(ValidationError):
            IncidentCreate(**{**base, "description": "   short   "})

    def test_push_subscribe_validation(self) -> None:
        keys = {"p256dh": VALID_P256DH, "auth": VALID_AUTH}
        sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": keys}
        req = PushSubscribeRequest(subscription=sub, topics=["disasters", "disasters"])
        assert req.topics == ["disasters"] and req.radius_km == 50
        with pytest.raises(ValidationError):
            PushSubscribeRequest(subscription=sub, lat=1)
        with pytest.raises(ValidationError):
            PushSubscribeRequest(subscription={**sub, "endpoint": "http://insecure"})
        with pytest.raises(ValidationError):
            PushSubscribeRequest(subscription=sub, topics=["weather"])

    @pytest.mark.parametrize(
        "endpoint",
        [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
            "https://web.push.apple.com/QGx",
            "https://api.push.apple.com/3/device/abc",
        ],
    )
    def test_push_endpoint_allows_browser_push_services(self, endpoint: str) -> None:
        sub = {"endpoint": endpoint, "keys": {"p256dh": VALID_P256DH, "auth": VALID_AUTH}}
        assert PushSubscribeRequest(subscription=sub).subscription.endpoint == endpoint

    @pytest.mark.parametrize(
        "endpoint",
        [
            "https://169.254.169.254/latest/api/token",  # cloud metadata (SSRF)
            "https://127.0.0.1:8000/api/users/register",
            "https://[::1]/x",
            "https://localhost/x",
            "https://internal.service/x",
            "https://fcm.googleapis.com:8443/fcm/send/x",  # explicit port
            "https://user:pw@fcm.googleapis.com/fcm/send/x",  # user-info
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilfcm.googleapis.com/x",
            "https://notify.windows.com/x",
            "http://fcm.googleapis.com/fcm/send/x",
            "https://fcm.googleapis.com/",
        ],
    )
    def test_push_endpoint_rejects_non_push_hosts(self, endpoint: str) -> None:
        sub = {"endpoint": endpoint, "keys": {"p256dh": VALID_P256DH, "auth": VALID_AUTH}}
        with pytest.raises(ValidationError):
            PushSubscribeRequest(subscription=sub)

    @pytest.mark.parametrize(
        ("p256dh", "auth"),
        [
            ("p", VALID_AUTH),
            (VALID_P256DH, "a"),
            ("A" * 87, VALID_AUTH),  # 65 bytes but not 0x04-prefixed / not on the curve
            ("BA" + "A" * 85, VALID_AUTH),  # 0x04 prefix, point not on the curve
            (VALID_P256DH, "AAAAAAAAAAAAAAAAAAAAAAAAAA"),  # 19 bytes
            (VALID_P256DH + "!", VALID_AUTH),
        ],
    )
    def test_push_keys_must_be_real_web_push_keys(self, p256dh: str, auth: str) -> None:
        sub = {
            "endpoint": "https://fcm.googleapis.com/fcm/send/x",
            "keys": {"p256dh": p256dh, "auth": auth},
        }
        with pytest.raises(ValidationError):
            PushSubscribeRequest(subscription=sub)

    def test_user_register_normalisation(self) -> None:
        req = UserRegisterRequest(
            email="  Asha@Example.COM ", password=" pass word ", name=" Asha  K "
        )
        assert req.email == "asha@example.com"
        assert req.password == " pass word "  # never stripped
        assert req.name == "Asha K"
        with pytest.raises(ValidationError):
            UserRegisterRequest(email="not-an-email", password="password1", name="A")
        with pytest.raises(ValidationError):
            UserRegisterRequest(email="a@b.co", password="short", name="A")
