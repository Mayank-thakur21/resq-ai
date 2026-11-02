"""Multi-agent AI chat: ``POST /api/chat``.

The Router Agent classifies the message and combines the Safety, Maps (OpenStreetMap places),
Checklist, Advisory (real weather) and Translation agents. Works without Gemini: every agent
has a deterministic fallback, so the endpoint never fails because the LLM is unavailable.
Paths are relative to the ``/api`` prefix; the default rate limit is applied by ``app.api``.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.agents.router_agent import process_chat
from app.api.deps import LLMDep, PlacesDep, WeatherDep
from app.schemas.chat import ChatRequest, ChatResponse
from app.schemas.common import error_responses

router = APIRouter(tags=["chat"])


@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="Ask the multi-agent emergency assistant",
    responses=error_responses(422, 429),
)
async def chat(
    body: ChatRequest, llm: LLMDep, places: PlacesDep, weather: WeatherDep
) -> ChatResponse:
    """Answer an emergency question.

    * ``urgency_level`` / ``detected_disaster``: the router's classification.
    * ``recommended_actions``: the safety instructions as a list.
    * ``emergency_numbers``: local numbers (112 first unless the country is known).
    * ``data``: ``hospitals`` / ``shelters`` (Place lists) when a location was sent and help is
      needed, ``checklist`` for preparedness questions, ``weather`` (WeatherResponse) when the
      advisory ran.
    * ``steps_taken``: which agents ran (and which providers were unavailable).
    """
    return await process_chat(
        body.message,
        body.language,
        body.location,
        llm=llm,
        places=places,
        weather=weather,
    )
