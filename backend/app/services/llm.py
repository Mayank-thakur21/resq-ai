"""Gemini access through the **new** Google Gen AI SDK (``google-genai``).

Verified against google-genai 2.34.0:

* ``genai.Client(api_key=..., http_options=types.HttpOptions(...))``
* ``await client.aio.models.generate_content(model=..., contents=..., config=...)``
  -> ``types.GenerateContentResponse`` whose ``.text`` is ``str | None``
* ``types.GenerateContentConfig(system_instruction=..., response_mime_type=...)``
* ``HttpOptions.timeout`` is in **milliseconds**; ``HttpRetryOptions(attempts=...)`` counts the
  original request; errors derive from ``google.genai.errors.APIError`` (``.code``).
* By default the async client would use aiohttp; we hand it a dedicated ``httpx.AsyncClient``
  (``HttpOptions.httpx_async_client``) so behaviour is uniform and tests can mock it with respx.

Contract: :class:`LLMService` methods **never raise** (except cancellation). They return
``None`` when the service is disabled or anything goes wrong, so every agent can fall back to
deterministic content.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app.core.config import Settings

logger = logging.getLogger(__name__)

#: Overall time budget for one LLM call (including the SDK's retry), in seconds. Requests
#: must finish below the Next.js proxy's 20 s upstream timeout (the chat pipeline makes up
#: to three sequential LLM stages and also enforces its own total budget), so a slow model
#: yields the deterministic fallback instead of a 504.
DEFAULT_LLM_TIMEOUT_SECONDS = 8.0
#: Per-HTTP-request timeout handed to the SDK, in seconds.
DEFAULT_REQUEST_TIMEOUT_SECONDS = 7.0

_JSON_FENCE = re.compile(r"^\s*```(?:json|JSON)?\s*(.*?)\s*```\s*$", re.DOTALL)


class LLMService:
    """Thin, failure-tolerant wrapper around ``client.aio.models.generate_content``.

    Args:
        settings: Application settings (``GEMINI_API_KEY`` / ``GEMINI_MODEL``).
        client: Pre-built ``genai.Client`` (tests); built from settings when omitted.
        timeout_seconds: Overall budget per call.
        request_timeout_seconds: Per-HTTP-request timeout passed to the SDK.
        max_attempts: SDK attempts per call (1 = no retry). Retries cover 408/429/5xx.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        client: genai.Client | None = None,
        timeout_seconds: float = DEFAULT_LLM_TIMEOUT_SECONDS,
        request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
        max_attempts: int = 2,
    ) -> None:
        self.model = settings.gemini_model
        self.timeout_seconds = timeout_seconds
        self._http: httpx.AsyncClient | None = None
        self._client: genai.Client | None = client
        if self._client is None and settings.gemini_api_key:
            self._client = self._build_client(
                settings.gemini_api_key, request_timeout_seconds, max_attempts
            )
        if self._client is None:
            logger.info("Gemini disabled (GEMINI_API_KEY not set): agents use fallbacks")
        else:
            logger.info("Gemini enabled (model=%s)", self.model)

    def _build_client(
        self, api_key: str, request_timeout_seconds: float, max_attempts: int
    ) -> genai.Client | None:
        try:
            self._http = httpx.AsyncClient(timeout=httpx.Timeout(request_timeout_seconds))
            http_options = types.HttpOptions(
                timeout=int(request_timeout_seconds * 1000),
                retry_options=types.HttpRetryOptions(
                    attempts=max(1, max_attempts), initial_delay=0.5, max_delay=4.0
                ),
                httpx_async_client=self._http,
            )
            return genai.Client(vertexai=False, api_key=api_key, http_options=http_options)
        except Exception:
            logger.exception("Failed to initialise the Gemini client; LLM features disabled")
            return None

    @property
    def enabled(self) -> bool:
        """``True`` when a Gemini client is configured."""
        return self._client is not None

    @staticmethod
    def build_config(
        system: str | None,
        *,
        json_output: bool = False,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> types.GenerateContentConfig:
        """Build the ``GenerateContentConfig`` for one call."""
        return types.GenerateContentConfig(
            system_instruction=system or None,
            response_mime_type="application/json" if json_output else None,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

    async def _generate(
        self,
        prompt: str,
        system: str | None,
        *,
        json_output: bool,
        temperature: float | None,
        max_output_tokens: int | None,
    ) -> str | None:
        if self._client is None:
            return None
        config = self.build_config(
            system,
            json_output=json_output,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        try:
            async with asyncio.timeout(self.timeout_seconds):
                response = await self._client.aio.models.generate_content(
                    model=self.model, contents=prompt, config=config
                )
        except TimeoutError:
            logger.warning("Gemini call timed out after %.0fs", self.timeout_seconds)
            return None
        except genai_errors.APIError as exc:
            logger.warning("Gemini API error %s: %s", exc.code, _short(str(exc.message or exc)))
            return None
        except Exception as exc:
            logger.warning("Gemini call failed: %s: %s", type(exc).__name__, _short(str(exc)))
            return None

        text = _response_text(response)
        if not text:
            logger.warning(
                "Gemini returned no text (prompt_chars=%d, block_reason=%s)",
                len(prompt),
                _block_reason(response),
            )
            return None
        return text

    async def generate_text(
        self,
        prompt: str,
        system: str | None = None,
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> str | None:
        """Generate free text; ``None`` when disabled or on any error."""
        text = await self._generate(
            prompt,
            system,
            json_output=False,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        return text.strip() if text else None

    async def generate_json(
        self,
        prompt: str,
        system: str | None = None,
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> Any | None:
        """Generate and parse JSON (``response_mime_type="application/json"``).

        Returns the decoded value (dict/list/...), or ``None`` when disabled, on errors or if
        the model output is not valid JSON.
        """
        text = await self._generate(
            prompt,
            system,
            json_output=True,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        if text is None:
            return None
        value = parse_json_text(text)
        if value is None:
            logger.warning("Gemini returned invalid JSON (%d chars)", len(text))
        return value

    async def aclose(self) -> None:
        """Release the SDK's HTTP resources (called on app shutdown)."""
        client, self._client = self._client, None
        if client is not None:
            try:
                await client.aio.aclose()
                client.close()
            except Exception:  # pragma: no cover - best effort on shutdown
                logger.debug("Error while closing the Gemini client", exc_info=True)
        if self._http is not None:
            await self._http.aclose()
            self._http = None


def parse_json_text(text: str) -> Any | None:
    """Decode model output as JSON, tolerating Markdown code fences and leading prose."""
    candidate = text.strip()
    fenced = _JSON_FENCE.match(candidate)
    if fenced:
        candidate = fenced.group(1)
    try:
        return json.loads(candidate)
    except ValueError:
        pass
    # Fall back to the first {...} or [...] block.
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = candidate.find(opener), candidate.rfind(closer)
        if 0 <= start < end:
            try:
                return json.loads(candidate[start : end + 1])
            except ValueError:
                continue
    return None


def _response_text(response: Any) -> str | None:
    try:
        text = response.text
    except Exception:  # pragma: no cover - SDK raises on some malformed payloads
        return None
    return text if isinstance(text, str) and text.strip() else None


def _block_reason(response: Any) -> str | None:
    feedback = getattr(response, "prompt_feedback", None)
    reason = getattr(feedback, "block_reason", None)
    return str(reason) if reason else None


def _short(message: str, limit: int = 200) -> str:
    message = " ".join(message.split())
    return message if len(message) <= limit else message[: limit - 3] + "..."
