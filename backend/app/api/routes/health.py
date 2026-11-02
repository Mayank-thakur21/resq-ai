"""``GET /api/health`` — readiness with a per-dependency summary (no auth, not rate limited)."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app import __version__
from app.api.deps import SettingsDep
from app.schemas.common import HealthResponse, HealthServices

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

DB_CHECK_TIMEOUT_SECONDS = 2.0


async def check_database(engine: AsyncEngine | None) -> Literal["ok", "error"]:
    """Run ``SELECT 1`` with a short timeout."""
    if engine is None:
        return "error"
    try:
        async with asyncio.timeout(DB_CHECK_TIMEOUT_SECONDS):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception as exc:
        logger.warning("Health check: database unavailable (%s: %s)", type(exc).__name__, exc)
        return "error"
    return "ok"


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Service health",
    responses={503: {"model": HealthResponse, "description": "Database unavailable"}},
)
async def health(request: Request, response: Response, settings: SettingsDep) -> HealthResponse:
    """Report overall status plus which optional integrations are configured.

    Returns HTTP 503 with ``status="degraded"`` when the database is unreachable so container
    health checks fail fast.
    """
    database = await check_database(getattr(request.app.state, "engine", None))
    llm = getattr(request.app.state, "llm", None)
    gemini = bool(llm.enabled) if llm is not None else settings.gemini_enabled
    # PushService disables itself when VAPID_PRIVATE_KEY is set but unparsable, so report the
    # live service state (as /api/push/vapid-public-key does) rather than "both keys present".
    push_service = getattr(request.app.state, "push", None)
    push = bool(push_service.enabled) if push_service is not None else settings.push_enabled
    status: Literal["ok", "degraded"] = "ok" if database == "ok" else "degraded"
    if status != "ok":
        response.status_code = 503
    return HealthResponse(
        status=status,
        version=__version__,
        services=HealthServices(
            database=database,
            gemini=gemini,
            openweathermap=settings.openweather_enabled,
            reliefweb=settings.reliefweb_enabled,
            twilio=settings.twilio_enabled,
            push=push,
            auth=settings.user_auth_enabled,
        ),
    )
