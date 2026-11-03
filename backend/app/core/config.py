"""Application settings loaded from environment variables (and an optional ``.env`` file).

Every tunable of the backend lives here so that the rest of the code never reads
``os.environ`` directly. Tests build their own :class:`Settings` instance and pass it to
``create_app(settings)``; production code uses the cached :func:`get_settings`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from limits import parse_many
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AppEnv = Literal["development", "production", "test"]

_VALID_LOG_LEVELS = frozenset({"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"})


class Settings(BaseSettings):
    """Typed backend configuration.

    Field names map 1:1 to upper-cased environment variables (``app_env`` <- ``APP_ENV``).
    Secrets are plain strings (empty string = "not configured") but are hidden from ``repr``
    so they never end up in logs.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        str_strip_whitespace=True,
    )

    # --- runtime -------------------------------------------------------------------------
    app_env: AppEnv = "development"
    log_level: str = "INFO"
    log_json: bool = False
    cors_origins: str = "http://localhost:3000"
    database_url: str = "sqlite+aiosqlite:///./data/resq.db"

    # --- AI ---------------------------------------------------------------------------------
    gemini_api_key: str = Field(default="", repr=False)
    gemini_model: str = "gemini-2.5-flash"

    # --- data providers -------------------------------------------------------------------
    openweather_api_key: str = Field(default="", repr=False)
    # One Call 3.0 (weather alerts) needs a separate OpenWeatherMap subscription.
    openweather_onecall_enabled: bool = False
    # ReliefWeb requires an approved appname; empty => ReliefWeb is skipped.
    reliefweb_appname: str = ""

    # --- SMS (Twilio) ----------------------------------------------------------------------
    twilio_account_sid: str = Field(default="", repr=False)
    twilio_auth_token: str = Field(default="", repr=False)
    twilio_from_number: str = ""
    twilio_messaging_service_sid: str = ""

    # --- Web push (VAPID) ------------------------------------------------------------------
    vapid_public_key: str = ""
    vapid_private_key: str = Field(default="", repr=False)
    vapid_subject: str = "mailto:admin@example.com"

    # --- auth ---------------------------------------------------------------------------------
    # Shared HS256 secret with the Next.js proxy; empty => user-auth endpoints return 503.
    backend_jwt_secret: str = Field(default="", repr=False)
    # Shared key for the internal /api/users/* endpoints; empty => those endpoints return 503.
    internal_api_key: str = Field(default="", repr=False)

    # --- rate limiting -------------------------------------------------------------------------
    rate_limit_default: str = "120/minute"
    sos_rate_limit: str = "5/minute"
    # Reverse proxies directly in front of the backend whose ``X-Forwarded-For`` entry is
    # trusted (0 = ignore the header and use the socket peer). The Next.js server does not
    # need this: it reports the end client's address in ``X-ResQ-Client-IP`` together with
    # ``X-Internal-Key`` (see app.core.rate_limit.client_ip).
    trusted_proxy_hops: int = Field(default=0, ge=0, le=10)

    # --- SOS SMS budgets (independent of the caller's IP address) -------------------------------
    # Twilio SMS per destination number (keyed by a hash of the number).
    sos_sms_per_number_limit: str = "3/hour;10/day"
    # Twilio SMS per caller (signed-in user id, else client address with IPv6 by /64), so one
    # caller cannot drain the shared budgets below with made-up numbers.
    sos_sms_per_client_limit: str = "30/hour;100/day"
    # Twilio SMS per client address (IPv6 by /64) for everyone sending from it, signed in or
    # not, so a pile of cheap accounts created on one address shares one budget.
    sos_sms_per_address_limit: str = "60/hour;200/day"
    # Twilio SMS for all anonymous callers together (a part of the global budget that
    # anonymous traffic may use; it can never take more than this).
    sos_sms_anonymous_limit: str = "200/hour;1000/day"
    # Twilio SMS for the whole server (caps the operator's bill whatever the callers do).
    sos_sms_global_limit: str = "500/hour;3000/day"
    # true = only signed-in users get SOS SMS through Twilio; anonymous callers receive the
    # native-SMS fallback (``fallback_sms_uri``) only.
    sos_sms_require_auth: bool = False

    # --- background alert poller ---------------------------------------------------------------
    alert_poller_enabled: bool = False
    alert_poll_interval_seconds: int = Field(default=600, ge=30, le=86_400)

    # --- incidents -------------------------------------------------------------------------------
    incident_verify_threshold: int = Field(default=3, ge=1, le=1_000)
    # Incident reports per signed-in user (``POST /api/incidents``).
    incident_rate_limit: str = "5/hour;20/day"

    # --- HTTP & caching -----------------------------------------------------------------------
    http_timeout_seconds: float = Field(default=10.0, gt=0, le=120)
    weather_cache_ttl: int = Field(default=300, ge=0)
    feed_cache_ttl: int = Field(default=600, ge=0)
    places_cache_ttl: int = Field(default=3600, ge=0)

    # --- OpenStreetMap / Overpass -----------------------------------------------------------
    # Overpass API endpoint. The public instance allows ~2 concurrent queries per server IP;
    # multi-user deployments should point this at a self-hosted or commercial instance and
    # raise OVERPASS_MAX_CONCURRENCY to what that instance allows.
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    overpass_max_concurrency: int = Field(default=2, ge=1, le=64)

    # ------------------------------------------------------------------------------------------
    # validators
    # ------------------------------------------------------------------------------------------
    @field_validator("app_env", mode="before")
    @classmethod
    def _normalise_env(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("log_level", mode="before")
    @classmethod
    def _normalise_log_level(cls, value: object) -> str:
        level = str(value or "INFO").strip().upper()
        if level == "WARN":
            level = "WARNING"
        if level not in _VALID_LOG_LEVELS:
            raise ValueError(f"log_level must be one of {sorted(_VALID_LOG_LEVELS)}")
        return level

    @field_validator(
        "rate_limit_default",
        "sos_rate_limit",
        "sos_sms_per_number_limit",
        "sos_sms_per_client_limit",
        "sos_sms_per_address_limit",
        "sos_sms_anonymous_limit",
        "sos_sms_global_limit",
        "incident_rate_limit",
    )
    @classmethod
    def _validate_rate_limit(cls, value: str) -> str:
        """Fail fast on malformed limit strings such as ``"5 per minut"``."""
        try:
            parsed = parse_many(value)
        except ValueError as exc:
            raise ValueError(f"invalid rate limit {value!r}: {exc}") from exc
        if not parsed:
            raise ValueError(f"invalid rate limit {value!r}")
        return value

    @field_validator("overpass_url")
    @classmethod
    def _validate_overpass_url(cls, value: str) -> str:
        if not value.startswith(("https://", "http://")):
            raise ValueError("overpass_url must be an http(s) URL")
        return value

    @field_validator("database_url")
    @classmethod
    def _validate_database_url(cls, value: str) -> str:
        if not value:
            raise ValueError("database_url must not be empty")
        return value

    # ------------------------------------------------------------------------------------------
    # derived properties
    # ------------------------------------------------------------------------------------------
    @property
    def cors_origin_list(self) -> list[str]:
        """``CORS_ORIGINS`` split on commas, blanks removed (``["*"]`` allowed)."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def is_test(self) -> bool:
        return self.app_env == "test"

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def gemini_enabled(self) -> bool:
        return bool(self.gemini_api_key)

    @property
    def openweather_enabled(self) -> bool:
        return bool(self.openweather_api_key)

    @property
    def reliefweb_enabled(self) -> bool:
        return bool(self.reliefweb_appname)

    @property
    def twilio_enabled(self) -> bool:
        """Twilio needs credentials plus a sender (phone number or messaging service)."""
        return bool(
            self.twilio_account_sid
            and self.twilio_auth_token
            and (self.twilio_from_number or self.twilio_messaging_service_sid)
        )

    @property
    def push_enabled(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)

    @property
    def user_auth_enabled(self) -> bool:
        return bool(self.backend_jwt_secret)

    @property
    def internal_api_enabled(self) -> bool:
        return bool(self.internal_api_key)

    @property
    def disaster_alerts_enabled(self) -> bool:
        """GDACS disaster pushes are actually sent (poller on *and* web push configured)."""
        return self.alert_poller_enabled and self.push_enabled


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings (read once from the environment / ``.env``)."""
    return Settings()
