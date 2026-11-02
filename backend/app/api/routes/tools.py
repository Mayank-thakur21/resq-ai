"""AI tools: ``POST /api/classify``, ``POST /api/checklist``, ``POST /api/translate``.

Single-agent endpoints used by the frontend outside the chat flow. Each works without Gemini
(keyword classifier, built-in checklists, untranslated text). The legacy
``GET /api/advisories`` lives in :mod:`app.api.routes.weather` next to the weather data it
summarises. Paths are relative to the ``/api`` prefix; the default rate limit is applied by
``app.api``.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.agents.checklist_agent import generate_checklist
from app.agents.router_agent import classify_disaster
from app.agents.translation_agent import translate_text
from app.api.deps import LLMDep
from app.schemas.chat import (
    ChecklistRequest,
    ChecklistResponse,
    ClassifyRequest,
    ClassifyResponse,
    TranslateRequest,
    TranslateResponse,
)
from app.schemas.common import error_responses

router = APIRouter(tags=["tools"])

_RESPONSES = error_responses(422, 429)


@router.post(
    "/classify",
    response_model=ClassifyResponse,
    summary="Classify a message: disaster type, urgency and intent",
    responses=_RESPONSES,
)
async def classify(body: ClassifyRequest, llm: LLMDep) -> ClassifyResponse:
    """``urgency`` is ``low``/``medium``/``high``; ``intent`` is ``seeking_help``,
    ``asking_info``, ``reporting`` or ``other``; ``disaster_type`` is a snake_case label
    (``flood``, ``earthquake``, ... ``general`` or ``unknown``)."""
    return await classify_disaster(body.message, llm)


@router.post(
    "/checklist",
    response_model=ChecklistResponse,
    summary="Emergency-kit checklist for a disaster type",
    responses=_RESPONSES,
)
async def checklist(body: ChecklistRequest, llm: LLMDep) -> ChecklistResponse:
    """AI-generated in ``language`` when Gemini is configured; otherwise a built-in English
    checklist (core kit + type-specific items)."""
    return ChecklistResponse(
        checklist=await generate_checklist(body.disaster_type, body.language, llm)
    )


@router.post(
    "/translate",
    response_model=TranslateResponse,
    summary="Translate text into another language",
    responses=_RESPONSES,
)
async def translate(body: TranslateRequest, llm: LLMDep) -> TranslateResponse:
    """Returns the original text unchanged for English targets or when translation is
    unavailable (Gemini not configured or failing)."""
    return TranslateResponse(
        translated_text=await translate_text(body.text, body.target_language, llm)
    )
