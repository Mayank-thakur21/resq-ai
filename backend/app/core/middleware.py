"""Request-context middleware: request ids and access logging.

Pure ASGI (no ``BaseHTTPMiddleware``) so streaming responses and background tasks are not
affected.
"""

from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import REQUEST_ID_HEADER
from app.core.logging import request_id_var

access_logger = logging.getLogger("app.access")

_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")
_QUIET_PATHS = frozenset({"/api/health"})


def _incoming_request_id(scope: Scope) -> str | None:
    for name, value in scope.get("headers", ()):
        if name == b"x-request-id":
            candidate = value.decode("latin-1").strip()
            return candidate if _VALID_REQUEST_ID.match(candidate) else None
    return None


class RequestContextMiddleware:
    """Assign/propagate ``X-Request-ID`` and emit one access-log line per request.

    Accepts a well-formed inbound ``X-Request-ID`` (e.g. from the Next.js proxy), otherwise
    generates one; exposes it on ``request.state.request_id``, in the logging context var and
    on the response.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_holder: dict[str, int] = {"status": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status = int(message["status"])
                status_holder["status"] = status
                headers = MutableHeaders(scope=message)
                if REQUEST_ID_HEADER not in headers:
                    headers[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = (time.perf_counter() - started) * 1000
            path = scope.get("path", "")
            level = logging.DEBUG if path in _QUIET_PATHS else logging.INFO
            access_logger.log(
                level,
                "%s %s -> %d (%.1f ms)",
                scope.get("method", "-"),
                path,
                status_holder["status"],
                duration_ms,
            )
            request_id_var.reset(token)
