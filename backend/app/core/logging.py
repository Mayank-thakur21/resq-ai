"""Logging setup: request-id propagation, optional JSON output and PII masking helpers.

Rules for the whole backend (see spec):
* never ``print()`` — use ``logging.getLogger(__name__)``;
* never log full phone numbers (use :func:`mask_phone`) or tokens/API keys.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

#: Request id of the HTTP request currently being served ("-" outside of a request).
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_HANDLER_NAME = "resq-root-handler"
_TEXT_FORMAT = "%(asctime)s %(levelname)-8s [%(name)s] [rid=%(request_id)s] %(message)s"

# Third-party loggers that are either noisy or would leak secrets at INFO level
# (httpx logs full request URLs, which include e.g. the OpenWeatherMap ``appid``).
_QUIET_LOGGERS: dict[str, int] = {
    "httpx": logging.WARNING,
    "httpcore": logging.WARNING,
    "httpx2": logging.WARNING,
    "httpcore2": logging.WARNING,
    "google_genai": logging.WARNING,
    "google.auth": logging.WARNING,
    "aiosqlite": logging.WARNING,
    "sqlalchemy.engine": logging.WARNING,
    "twilio": logging.WARNING,
    "twilio.http_client": logging.WARNING,
    "urllib3": logging.WARNING,
    "slowapi": logging.WARNING,
    # uvicorn's access line includes the query string, i.e. users' coordinates
    # (?lat=..&lon=..); "app.access" logs the same requests without it.
    "uvicorn.access": logging.WARNING,
}


class RequestIdFilter(logging.Filter):
    """Attach ``record.request_id`` (from the context var unless passed via ``extra``)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "request_id", None):
            record.request_id = request_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line — friendly to log shippers (Loki, CloudWatch, ...)."""

    _RESERVED = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", request_id_var.get()),
        }
        # Include custom ``extra={...}`` fields.
        for key, value in vars(record).items():
            if key in self._RESERVED or key in payload or key.startswith("_"):
                continue
            payload[key] = value if _is_json_scalar(value) else repr(value)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def _is_json_scalar(value: object) -> bool:
    return value is None or isinstance(value, str | int | float | bool)


def configure_logging(level: str = "INFO", json: bool = False) -> None:
    """Configure the root logger (idempotent — safe to call on every app start).

    Args:
        level: Root log level name (``"INFO"``, ``"DEBUG"`` ...).
        json: Emit one JSON object per line instead of human-readable text.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())

    # Replace only the handler we installed previously; keep foreign handlers
    # (pytest's caplog, uvicorn's own handlers on its loggers) untouched.
    for handler in list(root.handlers):
        if handler.get_name() == _HANDLER_NAME:
            root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stderr)
    handler.set_name(_HANDLER_NAME)
    handler.addFilter(RequestIdFilter())
    handler.setFormatter(JsonFormatter() if json else logging.Formatter(_TEXT_FORMAT))
    root.addHandler(handler)

    for name, quiet_level in _QUIET_LOGGERS.items():
        logging.getLogger(name).setLevel(max(quiet_level, root.level))


def mask_phone(number: str | None) -> str:
    """Mask a phone number for logs/responses: ``+919876543210`` -> ``+91******3210``.

    Keeps the leading ``+`` and two digits (country hint) plus the last four digits.
    Short inputs are masked more aggressively so nothing useful leaks.
    """
    if not number:
        return ""
    value = str(number).strip()
    if len(value) <= 4:
        return "*" * len(value)
    if len(value) < 9:
        return "*" * (len(value) - 2) + value[-2:]
    head = value[:3]
    tail = value[-4:]
    return f"{head}{'*' * (len(value) - 7)}{tail}"


def mask_secret(value: str | None, visible: int = 4) -> str:
    """Mask a token/API key, keeping at most ``visible`` trailing characters."""
    if not value:
        return ""
    if len(value) <= visible * 2:
        return "*" * len(value)
    return f"{'*' * 8}{value[-visible:]}"
