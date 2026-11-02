"""Chat & AI tool endpoints: ``/api/chat``, ``/api/classify``, ``/api/checklist``,
``/api/translate`` and ``/api/advisories``."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from app.schemas.common import APIModel, Coordinates

Urgency = Literal["low", "medium", "high"]

#: Language code/name accepted by the AI agents ("en", "hi", "Hindi", "pt-BR" ...).
Language = Annotated[str, Field(min_length=2, max_length=35)]


class ChatLocation(Coordinates):
    """User location attached to a chat message."""


class ChatRequest(APIModel):
    message: str = Field(min_length=1, max_length=2000)
    language: Language = "en"
    location: ChatLocation | None = None


class ChatResponse(APIModel):
    """Multi-agent chat answer (contract kept from v1)."""

    response: str
    agent_used: str
    urgency_level: Urgency = "low"
    detected_disaster: str | None = None
    advisory: str | None = None
    recommended_actions: list[str] = Field(default_factory=list)
    emergency_numbers: list[str] = Field(default_factory=list)
    steps_taken: list[str] = Field(default_factory=list)
    #: Agent artefacts, e.g. ``{"hospitals": [Place...], "shelters": [...], "checklist": [...]}``.
    data: dict[str, Any] = Field(default_factory=dict)


class ClassifyRequest(APIModel):
    message: str = Field(min_length=1, max_length=2000)


class ClassifyResponse(APIModel):
    disaster_type: str = "unknown"
    urgency: Urgency = "low"
    intent: str = "other"


class ChecklistRequest(APIModel):
    disaster_type: str = Field(min_length=1, max_length=64)
    language: Language = "en"


class ChecklistResponse(APIModel):
    checklist: list[str]


class TranslateRequest(APIModel):
    text: str = Field(min_length=1, max_length=5000)
    target_language: str = Field(min_length=2, max_length=35)


class TranslateResponse(APIModel):
    translated_text: str


class AdvisoryResponse(APIModel):
    """``GET /api/advisories?lat&lon`` (legacy) — AI summary of the local weather."""

    advisories: str
