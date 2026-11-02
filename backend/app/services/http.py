"""Shared outbound HTTP client (one ``httpx.AsyncClient`` per app, created in the lifespan)."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import Request

from app import __version__
from app.core.config import Settings

_MAJOR_MINOR = ".".join(__version__.split(".")[:2])
#: e.g. "ResQ-AI/2.0 (+https://github.com/Mayank-thakur21/resq-ai)"
USER_AGENT = f"ResQ-AI/{_MAJOR_MINOR} (+https://github.com/Mayank-thakur21/resq-ai)"


def create_http_client(settings: Settings) -> httpx.AsyncClient:
    """Create the shared client: timeouts from settings, identifying User-Agent, pooling.

    Upstream services (GDACS, Overpass, Open-Meteo ...) ask API consumers to send a
    descriptive User-Agent; tests intercept this client with ``respx``.
    """
    timeout = httpx.Timeout(
        settings.http_timeout_seconds, connect=min(5.0, settings.http_timeout_seconds)
    )
    return httpx.AsyncClient(
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
    )


def get_http(request: Request) -> httpx.AsyncClient:
    """Return ``app.state.http`` (FastAPI dependency / helper)."""
    client: httpx.AsyncClient | None = getattr(request.app.state, "http", None)
    if client is None:
        raise RuntimeError("HTTP client is not initialised (app lifespan has not run)")
    return client


class ProviderError(Exception):
    """An upstream provider call failed (network, HTTP status, malformed payload).

    The message is safe to log: it names the provider and the reason but never contains the
    request URL (which may carry an API key) or the response body. Services catch it to fall
    back to another provider / a cached copy, and translate it to
    :class:`app.core.errors.UpstreamError` (502) only when nothing else is left.

    Attributes:
        provider: Short provider id, e.g. ``"openweathermap"`` or ``"gdacs"``.
        reason: Human-readable, log-safe reason.
        status_code: Upstream HTTP status when the failure was a non-200 response.
    """

    def __init__(self, provider: str, reason: str, *, status_code: int | None = None) -> None:
        super().__init__(f"{provider}: {reason}")
        self.provider = provider
        self.reason = reason
        self.status_code = status_code


async def request_json(
    http: httpx.AsyncClient,
    provider: str,
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    json: Any = None,
) -> Any:
    """Send a request with the shared client and decode a JSON body.

    Every failure is mapped to :class:`ProviderError` (timeout, transport error, any non-200
    status, undecodable body), so callers handle exactly one exception type.

    Args:
        http: The shared ``httpx.AsyncClient`` (``app.state.http``).
        provider: Provider id used in the error message.
        method: HTTP method (``"GET"``, ``"POST"`` ...).
        url: Absolute URL *without* secrets in the path (query secrets go in ``params``).
        params: Query parameters.
        json: JSON request body.

    Returns:
        The decoded JSON document.
    """
    try:
        response = await http.request(method, url, params=params, json=json)
    except httpx.TimeoutException as exc:
        raise ProviderError(provider, "request timed out") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(provider, f"request failed ({type(exc).__name__})") from exc
    if response.status_code != httpx.codes.OK:
        raise ProviderError(
            provider, f"HTTP {response.status_code}", status_code=response.status_code
        )
    try:
        return response.json()
    except ValueError as exc:
        raise ProviderError(provider, "response is not valid JSON") from exc
