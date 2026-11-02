"""Domain errors and the consistent JSON error envelope.

Every error response produced by the API has the shape::

    {"error": {"code": "<machine code>", "message": "<human text>", "request_id": "<id>"}}

Raise an :class:`AppError` subclass from services/routes; the handlers registered by
:func:`register_exception_handlers` turn it (and FastAPI/Starlette errors) into that envelope.
Rate limiting raises :class:`RateLimitExceeded` (429, code ``rate_limited``).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import TimeoutError as DatabasePoolTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import request_id_var

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "X-Request-ID"


class AppError(Exception):
    """Base class for expected, client-visible errors."""

    status_code: int = 500
    code: str = "internal_error"
    default_message: str = "An unexpected error occurred."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.message = message or self.default_message
        if code is not None:
            self.code = code
        self.headers: dict[str, str] = dict(headers or {})
        super().__init__(self.message)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, message={self.message!r})"


class InvalidInputError(AppError):
    status_code = 422
    code = "invalid_input"
    default_message = "The request contains invalid input."


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"
    default_message = "Authentication required."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        merged = {"WWW-Authenticate": "Bearer"}
        merged.update(headers or {})
        super().__init__(message, code=code, headers=merged)


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"
    default_message = "You are not allowed to perform this action."


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"
    default_message = "Resource not found."


class ConflictError(AppError):
    status_code = 409
    code = "conflict"
    default_message = "The resource already exists or is in a conflicting state."


class RateLimitExceeded(AppError):
    """429 raised by :mod:`app.core.rate_limit` (carries ``Retry-After``/``X-RateLimit-*``)."""

    status_code = 429
    code = "rate_limited"
    default_message = "Too many requests. Please retry later."


class UpstreamError(AppError):
    status_code = 502
    code = "upstream_error"
    default_message = "An upstream data provider is unavailable."


class ServiceNotConfiguredError(AppError):
    status_code = 503
    code = "not_configured"
    default_message = "This feature is not configured on the server."


class ServiceBusyError(AppError):
    """503 for a temporarily saturated shared resource (bcrypt queue, database pool).

    Answering straight away (with ``Retry-After``) instead of queueing without bound keeps
    one flood of requests from delaying everything else (SOS above all).
    """

    status_code = 503
    code = "service_busy"
    default_message = "The server is busy right now. Please retry in a few seconds."

    def __init__(
        self,
        message: str | None = None,
        *,
        retry_after: int = 2,
        code: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        merged = {"Retry-After": str(max(1, retry_after))}
        merged.update(headers or {})
        super().__init__(message, code=code, headers=merged)


# HTTP status -> envelope code for plain HTTPExceptions (routing 404/405, etc.).
_STATUS_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    406: "not_acceptable",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "invalid_input",
    429: "rate_limited",
    500: "internal_error",
    502: "upstream_error",
    503: "service_unavailable",
    504: "upstream_timeout",
}


def current_request_id(request: Request | None = None) -> str:
    """Best-effort request id: request state first, then the logging context var."""
    if request is not None:
        rid = getattr(request.state, "request_id", None)
        if rid:
            return str(rid)
    rid = request_id_var.get()
    return "" if rid == "-" else rid


def error_response(
    request: Request | None,
    status_code: int,
    code: str,
    message: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    """Build the standard error envelope response."""
    rid = current_request_id(request)
    response = JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "request_id": rid}},
        headers=dict(headers or {}),
    )
    if rid and REQUEST_ID_HEADER not in response.headers:
        response.headers[REQUEST_ID_HEADER] = rid
    return response


def format_validation_errors(errors: Sequence[Mapping[str, Any]]) -> str:
    """Flatten pydantic/FastAPI validation errors into one readable line.

    ``[{"loc": ("body", "lat"), "msg": "Input should be ..."}]`` ->
    ``"body.lat: Input should be ..."`` (multiple errors joined with ``"; "``).
    """
    parts: list[str] = []
    for err in errors:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p != "__root__")
        msg = str(err.get("msg", "invalid value"))
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts) or "Invalid request."


async def _app_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    if exc.status_code >= 500:
        logger.warning("%s: %s", type(exc).__name__, exc.message)
    else:
        logger.info("%s (%s): %s", type(exc).__name__, exc.code, exc.message)
    return error_response(request, exc.status_code, exc.code, exc.message, exc.headers)


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    status = exc.status_code
    code = _STATUS_CODES.get(status, "http_error")
    if isinstance(exc.detail, str) and exc.detail:
        message = exc.detail
    else:
        try:
            message = HTTPStatus(status).phrase
        except ValueError:
            message = "HTTP error"
    return error_response(request, status, code, message, exc.headers)


async def _validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    message = format_validation_errors(exc.errors())
    logger.info("Request validation failed: %s", message)
    return error_response(request, 422, "validation_error", message)


async def _database_busy_handler(request: Request, exc: Exception) -> JSONResponse:
    """SQLAlchemy could not get a pooled connection in time: 503 instead of a 500."""
    logger.error(
        "Database connection pool exhausted on %s %s (%s)",
        request.method,
        request.url.path,
        type(exc).__name__,
    )
    busy = ServiceBusyError("The server is busy right now. Please retry in a few seconds.")
    return error_response(request, busy.status_code, busy.code, busy.message, busy.headers)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Runs in Starlette's ServerErrorMiddleware (outside our request-context middleware),
    # so the request id is passed explicitly to the log record and response.
    rid = current_request_id(request)
    logger.error(
        "Unhandled error on %s %s",
        request.method,
        request.url.path,
        exc_info=exc,
        extra={"request_id": rid or "-"},
    )
    return error_response(request, 500, "internal_error", AppError.default_message)


def register_exception_handlers(app: FastAPI) -> None:
    """Install all envelope-producing exception handlers on ``app``."""
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(DatabasePoolTimeoutError, _database_busy_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
