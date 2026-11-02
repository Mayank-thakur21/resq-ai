"""Tests for ``LLMService`` (google-genai) and the ``FakeLLM`` test helper."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors
from google.genai import types

from app.core.config import Settings
from app.services.llm import LLMService, parse_json_text
from conftest import FakeLLM

GEMINI_URL = (
    r"https://generativelanguage\.googleapis\.com/v1beta/models/gemini-2\.5-flash:generateContent"
)


def gemini_reply(text: str) -> dict[str, Any]:
    """Minimal ``GenerateContentResponse`` JSON as returned by the REST API."""
    return {
        "candidates": [
            {"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}
        ],
        "modelVersion": "gemini-2.5-flash",
    }


class _FakeModels:
    def __init__(self, behaviour: Callable[..., Any]) -> None:
        self.behaviour = behaviour
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, *, model: str, contents: Any, config: Any) -> Any:
        self.calls.append({"model": model, "contents": contents, "config": config})
        return await self.behaviour()


class _FakeGenaiClient:
    """Mimics ``genai.Client`` (only ``.aio.models.generate_content`` is used)."""

    def __init__(self, behaviour: Callable[..., Any]) -> None:
        self.models = _FakeModels(behaviour)
        self.aio = SimpleNamespace(models=self.models, aclose=self._aclose)
        self.closed = False

    async def _aclose(self) -> None:
        self.closed = True

    def close(self) -> None:
        pass


def _reply(text: str | None) -> Callable[[], Any]:
    async def behaviour() -> Any:
        return SimpleNamespace(text=text, prompt_feedback=None)

    return behaviour


def _raise(exc: BaseException) -> Callable[[], Any]:
    async def behaviour() -> Any:
        raise exc

    return behaviour


# ---------------------------------------------------------------------------------------------
# disabled
# ---------------------------------------------------------------------------------------------
async def test_disabled_without_api_key(settings: Settings) -> None:
    llm = LLMService(settings)
    assert llm.enabled is False
    assert await llm.generate_text("hi") is None
    assert await llm.generate_json("hi") is None
    await llm.aclose()


# ---------------------------------------------------------------------------------------------
# behaviour with an injected client
# ---------------------------------------------------------------------------------------------
async def test_generate_text_passes_model_prompt_and_system(settings: Settings) -> None:
    fake = _FakeGenaiClient(_reply("  Stay calm.\n"))
    llm = LLMService(settings, client=fake)  # type: ignore[arg-type]
    assert llm.enabled
    assert await llm.generate_text("What now?", system="You are a crisis expert") == "Stay calm."
    call = fake.models.calls[0]
    assert call["model"] == "gemini-2.5-flash"
    assert call["contents"] == "What now?"
    config = call["config"]
    assert isinstance(config, types.GenerateContentConfig)
    assert config.system_instruction == "You are a crisis expert"
    assert config.response_mime_type is None


async def test_generate_json_requests_json_and_parses(settings: Settings) -> None:
    fake = _FakeGenaiClient(_reply('```json\n{"disaster_type": "flood", "urgency": "high"}\n```'))
    llm = LLMService(settings, client=fake)  # type: ignore[arg-type]
    result = await llm.generate_json("classify", system="classifier")
    assert result == {"disaster_type": "flood", "urgency": "high"}
    assert fake.models.calls[0]["config"].response_mime_type == "application/json"


@pytest.mark.parametrize(
    "behaviour",
    [
        _reply(None),
        _reply("   "),
        _raise(genai_errors.APIError(400, {"error": {"message": "bad", "status": "INVALID"}})),
        _raise(genai_errors.ServerError(503, {"error": {"message": "overloaded"}})),
        _raise(httpx.ConnectError("offline")),
        _raise(ValueError("unexpected")),
    ],
    ids=["none", "blank", "api-error", "server-error", "network", "other"],
)
async def test_failures_return_none(settings: Settings, behaviour: Callable[[], Any]) -> None:
    llm = LLMService(settings, client=_FakeGenaiClient(behaviour))  # type: ignore[arg-type]
    assert await llm.generate_text("x") is None
    assert await llm.generate_json("x") is None


async def test_invalid_json_returns_none(settings: Settings) -> None:
    llm = LLMService(settings, client=_FakeGenaiClient(_reply("not json at all")))  # type: ignore[arg-type]
    assert await llm.generate_json("x") is None


async def test_timeout_returns_none(settings: Settings) -> None:
    async def slow() -> Any:
        await asyncio.sleep(1)
        return SimpleNamespace(text="late")

    llm = LLMService(settings, client=_FakeGenaiClient(slow), timeout_seconds=0.05)  # type: ignore[arg-type]
    assert await llm.generate_text("x") is None


async def test_cancellation_propagates(settings: Settings) -> None:
    llm = LLMService(settings, client=_FakeGenaiClient(_raise(asyncio.CancelledError())))  # type: ignore[arg-type]
    with pytest.raises(asyncio.CancelledError):
        await llm.generate_text("x")


async def test_aclose_closes_client(settings: Settings) -> None:
    fake = _FakeGenaiClient(_reply("x"))
    llm = LLMService(settings, client=fake)  # type: ignore[arg-type]
    await llm.aclose()
    assert fake.closed and not llm.enabled
    assert await llm.generate_text("x") is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"a": 1}', {"a": 1}),
        ("```json\n[1, 2]\n```", [1, 2]),
        ('```\n{"a": true}\n```', {"a": True}),
        ('Sure! Here it is: {"a": "b"} Hope that helps', {"a": "b"}),
        ('Items: ["x", "y"]', ["x", "y"]),
        ("nothing here", None),
        ("{broken", None),
    ],
)
def test_parse_json_text(text: str, expected: Any) -> None:
    assert parse_json_text(text) == expected


# ---------------------------------------------------------------------------------------------
# end-to-end through the real google-genai SDK (HTTP mocked with respx)
# ---------------------------------------------------------------------------------------------
async def test_real_sdk_request_shape(
    settings_factory: Callable[..., Settings], respx_mock: Any
) -> None:
    route = respx_mock.post(url__regex=GEMINI_URL).mock(
        return_value=httpx.Response(200, json=gemini_reply('{"urgency": "high"}'))
    )
    llm = LLMService(settings_factory(gemini_api_key="test-key"), max_attempts=1)
    try:
        assert llm.enabled
        result = await llm.generate_json("Flood in my street", system="Classify emergencies")
    finally:
        await llm.aclose()

    assert result == {"urgency": "high"}
    request = route.calls.last.request
    assert request.headers["x-goog-api-key"] == "test-key"
    body = json.loads(request.content)
    assert body["contents"][0]["parts"][0]["text"] == "Flood in my street"
    assert body["systemInstruction"]["parts"][0]["text"] == "Classify emergencies"
    assert body["generationConfig"]["responseMimeType"] == "application/json"


@pytest.mark.parametrize("status", [400, 403, 429, 500])
async def test_real_sdk_http_errors_return_none(
    settings_factory: Callable[..., Settings], respx_mock: Any, status: int
) -> None:
    respx_mock.post(url__regex=GEMINI_URL).mock(
        return_value=httpx.Response(status, json={"error": {"code": status, "message": "nope"}})
    )
    llm = LLMService(settings_factory(gemini_api_key="test-key"), max_attempts=1)
    try:
        assert await llm.generate_text("hello") is None
    finally:
        await llm.aclose()


async def test_real_sdk_network_error_returns_none(
    settings_factory: Callable[..., Settings], respx_mock: Any
) -> None:
    respx_mock.post(url__regex=GEMINI_URL).mock(side_effect=httpx.ConnectError("offline"))
    llm = LLMService(settings_factory(gemini_api_key="test-key"), max_attempts=1)
    try:
        assert await llm.generate_text("hello") is None
    finally:
        await llm.aclose()


# ---------------------------------------------------------------------------------------------
# app wiring + FakeLLM helper
# ---------------------------------------------------------------------------------------------
def test_app_state_llm_is_llm_service(client: TestClient) -> None:
    llm = client.app.state.llm  # type: ignore[attr-defined]
    assert isinstance(llm, LLMService)
    assert llm.enabled is False


async def test_fake_llm_helper() -> None:
    fake = FakeLLM(text="hello", json_value=lambda prompt, system: {"echo": prompt})
    assert await fake.generate_text("p1", system="s") == "hello"
    assert await fake.generate_json("p2") == {"echo": "p2"}
    assert [(c.kind, c.prompt, c.system) for c in fake.calls] == [
        ("text", "p1", "s"),
        ("json", "p2", None),
    ]
    fake.enabled = False
    assert await fake.generate_text("p3") is None


def test_fake_llm_fixture_installs_on_app(client: TestClient, fake_llm: FakeLLM) -> None:
    assert client.app.state.llm is fake_llm  # type: ignore[attr-defined]
