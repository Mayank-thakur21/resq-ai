"""ResQ AI FastAPI application factory.

Run with ``uvicorn app.main:app`` from ``backend/``. Tests build isolated apps with
``create_app(Settings(...))``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import api_router
from app.core.config import Settings, get_settings
from app.core.errors import REQUEST_ID_HEADER, register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.core.rate_limit import setup_rate_limiting
from app.db.session import create_engine, create_sessionmaker, init_db
from app.schemas.common import RootResponse
from app.services import users as user_service
from app.services.alert_poller import AlertPoller
from app.services.cache import TTLCache
from app.services.disaster_feed import DisasterFeedService
from app.services.http import create_http_client
from app.services.llm import LLMService
from app.services.places import PlacesService
from app.services.push import PushService
from app.services.sms import SMSService
from app.services.weather import WeatherService

logger = logging.getLogger(__name__)

_MIN_SECRET_LENGTH = 32


def _warn_about_configuration(settings: Settings) -> None:
    """Log (never print) configuration problems that are not fatal."""
    if not settings.user_auth_enabled:
        logger.warning("BACKEND_JWT_SECRET is not set: authenticated endpoints will return 503")
    elif len(settings.backend_jwt_secret) < _MIN_SECRET_LENGTH:
        logger.warning(
            "BACKEND_JWT_SECRET is shorter than %d characters; use a long random secret",
            _MIN_SECRET_LENGTH,
        )
    if not settings.internal_api_enabled:
        logger.warning("INTERNAL_API_KEY is not set: /api/users/* will return 503")
    if not settings.push_enabled:
        logger.info("Web push disabled (VAPID keys not set)")
    elif not settings.alert_poller_enabled:
        logger.warning(
            "ALERT_POLLER_ENABLED is false: subscribers get incident pushes only, no GDACS "
            "disaster alerts"
        )
    if not settings.trusted_proxy_hops and not settings.internal_api_enabled:
        logger.warning(
            "No trustworthy client address source (INTERNAL_API_KEY unset, TRUSTED_PROXY_HOPS=0):"
            " anonymous rate limits apply to the proxy's address"
        )
    if not settings.twilio_enabled:
        logger.info("Twilio SMS disabled: SOS falls back to the native SMS app")
    if settings.is_production and "*" in settings.cors_origin_list:
        logger.warning("CORS_ORIGINS='*' in production; restrict it to the frontend origin")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Create every long-lived resource on startup and release them on shutdown."""
    settings: Settings = app.state.settings
    configure_logging(settings.log_level, settings.log_json)
    logger.info("Starting ResQ AI backend %s (env=%s)", __version__, settings.app_env)
    _warn_about_configuration(settings)

    async with AsyncExitStack() as stack:
        engine = create_engine(settings)
        stack.push_async_callback(engine.dispose)
        await init_db(engine)
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker = create_sessionmaker(engine)

        http = create_http_client(settings)
        stack.push_async_callback(http.aclose)
        app.state.http = http

        cache = TTLCache()
        app.state.cache = cache

        llm = LLMService(settings)
        stack.push_async_callback(llm.aclose)
        app.state.llm = llm

        app.state.weather = WeatherService(http, cache, settings)
        app.state.feeds = feeds = DisasterFeedService(http, cache, settings)
        app.state.places = PlacesService(http, cache, settings)
        # SMS, web push and bcrypt each run on their own thread pool, so neither can starve
        # the others (or the event loop's default executor).
        app.state.sms = sms = SMSService(settings)
        stack.callback(sms.close)
        app.state.push = push = PushService(settings)
        stack.callback(push.close)
        stack.callback(user_service.shutdown_executor)

        app.state.alert_poller = None
        if settings.alert_poller_enabled and not push.enabled:
            logger.warning(
                "ALERT_POLLER_ENABLED is true but web push is not configured (VAPID keys); "
                "disaster alerts are not polled"
            )
        elif settings.alert_poller_enabled:
            poller = AlertPoller(feeds, push, sessionmaker, settings)
            poller.start()
            stack.push_async_callback(poller.stop)
            app.state.alert_poller = poller
            logger.info("Alert poller started (every %ds)", settings.alert_poll_interval_seconds)

        logger.info("ResQ AI backend ready")
        try:
            yield
        finally:
            logger.info("Shutting down ResQ AI backend")
    logger.info("Shutdown complete")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build a fully wired FastAPI application.

    Args:
        settings: Explicit settings (tests); defaults to :func:`get_settings`.
    """
    settings = settings or get_settings()
    app = FastAPI(
        title="ResQ AI API",
        version=__version__,
        description=(
            "Multi-agent disaster-response assistant: AI chat, real weather, GDACS/ReliefWeb "
            "alerts, nearby help (OpenStreetMap), SOS SMS, community incidents and web push."
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings

    register_exception_handlers(app)
    setup_rate_limiting(app, settings)
    # Middleware order (outermost first): RequestContext -> CORS -> routes.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Accept-Language",
            REQUEST_ID_HEADER,
        ],
        expose_headers=[
            REQUEST_ID_HEADER,
            "Retry-After",
            "X-RateLimit-Limit",
            "X-RateLimit-Remaining",
            "X-RateLimit-Reset",
        ],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware)

    app.include_router(api_router)

    @app.get("/", response_model=RootResponse, include_in_schema=False)
    async def root() -> RootResponse:
        return RootResponse(name="ResQ AI API", version=__version__, docs="/docs")

    return app


app = create_app()
