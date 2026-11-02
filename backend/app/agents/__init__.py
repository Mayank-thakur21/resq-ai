"""ResQ AI multi-agent chat.

The router agent (:mod:`app.agents.router_agent`) classifies a message and orchestrates the
specialist agents:

* :mod:`~app.agents.safety_agent`       immediate safety instructions per disaster type
* :mod:`~app.agents.advisory_agent`     weather advisory from real provider data
* :mod:`~app.agents.checklist_agent`    emergency-kit checklists
* :mod:`~app.agents.translation_agent`  translation of the final answer

Every agent receives the LLM service as a parameter (``app.state.llm``, an
:class:`~app.services.llm.LLMService`) and keeps a deterministic fallback for when Gemini is
disabled or fails (the service then returns ``None``). This package deliberately imports no
sub-modules so that importing one agent never drags in the others.
"""

from __future__ import annotations

from typing import Any, Protocol


class LLMClient(Protocol):
    """What the agents need from :class:`~app.services.llm.LLMService` (or a test fake).

    Both methods return ``None`` instead of raising when the model is unavailable.
    """

    async def generate_text(self, prompt: str, system: str | None = None) -> str | None: ...

    async def generate_json(self, prompt: str, system: str | None = None) -> Any | None: ...


__all__ = ["LLMClient"]
