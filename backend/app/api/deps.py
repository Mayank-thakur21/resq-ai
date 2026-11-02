"""FastAPI dependency getters for everything stored on ``app.state`` + ready-made aliases.

Usage in a route module::

    from app.api.deps import CurrentUserDep, SessionDep, WeatherDep

    @router.get("/weather")
    async def weather(lat: float, lon: float, weather: WeatherDep) -> WeatherResponse:
        return await weather.get_weather(lat, lon)

Tests swap a service by assigning ``client.app.state.<name> = Fake()`` inside the
``client`` fixture (after the lifespan ran).
"""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.security import (
    CurrentUser,
    get_current_user,
    get_optional_user,
    require_internal_key,
)
from app.db.session import get_session
from app.services.cache import TTLCache
from app.services.disaster_feed import DisasterFeedService
from app.services.llm import LLMService
from app.services.places import PlacesService
from app.services.push import PushService
from app.services.sms import SMSService
from app.services.weather import WeatherService


def _state(request: Request, name: str) -> Any:
    try:
        return getattr(request.app.state, name)
    except AttributeError:
        raise RuntimeError(
            f"app.state.{name} is not initialised (did the application lifespan run?)"
        ) from None


def get_app_settings(request: Request) -> Settings:
    """Settings the app was created with (``create_app(settings)``)."""
    return _state(request, "settings")


def get_http_client(request: Request) -> httpx.AsyncClient:
    return _state(request, "http")


def get_cache(request: Request) -> TTLCache:
    return _state(request, "cache")


def get_llm(request: Request) -> LLMService:
    return _state(request, "llm")


def get_weather_service(request: Request) -> WeatherService:
    return _state(request, "weather")


def get_feeds_service(request: Request) -> DisasterFeedService:
    return _state(request, "feeds")


def get_places_service(request: Request) -> PlacesService:
    return _state(request, "places")


def get_sms_service(request: Request) -> SMSService:
    return _state(request, "sms")


def get_push_service(request: Request) -> PushService:
    return _state(request, "push")


def get_sessionmaker(request: Request) -> async_sessionmaker[AsyncSession]:
    """Session factory, for work that outlives the request (e.g. background tasks)."""
    return _state(request, "sessionmaker")


# --- Annotated aliases ---------------------------------------------------------------------
SettingsDep = Annotated[Settings, Depends(get_app_settings)]
HttpDep = Annotated[httpx.AsyncClient, Depends(get_http_client)]
CacheDep = Annotated[TTLCache, Depends(get_cache)]
LLMDep = Annotated[LLMService, Depends(get_llm)]
WeatherDep = Annotated[WeatherService, Depends(get_weather_service)]
FeedsDep = Annotated[DisasterFeedService, Depends(get_feeds_service)]
PlacesDep = Annotated[PlacesService, Depends(get_places_service)]
SMSDep = Annotated[SMSService, Depends(get_sms_service)]
PushDep = Annotated[PushService, Depends(get_push_service)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
SessionmakerDep = Annotated[async_sessionmaker[AsyncSession], Depends(get_sessionmaker)]
CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
OptionalUserDep = Annotated[CurrentUser | None, Depends(get_optional_user)]
#: Use as ``dependencies=[InternalKey]`` on a router/route.
InternalKey = Depends(require_internal_key)

__all__ = [
    "CacheDep",
    "CurrentUser",
    "CurrentUserDep",
    "FeedsDep",
    "HttpDep",
    "InternalKey",
    "LLMDep",
    "OptionalUserDep",
    "PlacesDep",
    "PushDep",
    "SMSDep",
    "SessionDep",
    "SessionmakerDep",
    "SettingsDep",
    "WeatherDep",
    "get_app_settings",
    "get_cache",
    "get_current_user",
    "get_feeds_service",
    "get_http_client",
    "get_llm",
    "get_optional_user",
    "get_places_service",
    "get_push_service",
    "get_session",
    "get_sessionmaker",
    "get_sms_service",
    "get_weather_service",
    "require_internal_key",
]
