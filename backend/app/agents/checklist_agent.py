"""Checklist Agent: emergency-kit / preparedness checklists per disaster type.

``generate_checklist(disaster_type, language, llm=...)`` asks the LLM for a JSON array of short
items in the requested language. When the LLM is disabled, fails or returns something unusable,
a built-in English checklist is returned: a core kit (:data:`CORE_KIT`) plus items specific to
the disaster type (:data:`TYPE_SPECIFIC_ITEMS`).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping
from typing import Any

from app.agents import LLMClient
from app.agents.advisory_agent import language_name
from app.agents.safety_agent import disaster_label, normalize_disaster_type

logger = logging.getLogger(__name__)

#: Items requested from the LLM / maximum items returned.
REQUESTED_ITEMS = 8
MAX_ITEMS = 12
MAX_ITEM_CHARS = 160

CORE_KIT: tuple[str, ...] = (
    "Drinking water: about 4 litres per person per day for at least 3 days",
    "Non-perishable food for 3 days (and a manual can opener)",
    "First-aid kit and at least a week of prescription medicines",
    "Torch with spare batteries",
    "Fully charged mobile phone, power bank and charging cable",
    "Copies of ID, insurance and medical documents in a waterproof pouch",
)

TYPE_SPECIFIC_ITEMS: dict[str, tuple[str, ...]] = {
    "flood": (
        "Waterproof bags for phones, documents and medicines",
        "Rubber boots, gloves and a raincoat",
        "Water purification tablets or a filter",
        "Rope and a life jacket or other flotation aid",
    ),
    "earthquake": (
        "Sturdy closed shoes and work gloves",
        "Dust masks",
        "Wrench or pliers to turn off gas and water",
        "Whistle to signal rescuers if trapped",
    ),
    "fire": (
        "ABC fire extinguisher and a fire blanket",
        "N95 masks for smoke",
        "Working smoke alarms with spare batteries",
        "Planned escape routes and a family meeting point",
    ),
    "cyclone": (
        "Battery-powered or hand-crank radio for official warnings",
        "Tarpaulin, rope and strong tape for emergency repairs",
        "Extra stored water: supplies may be cut for days",
        "Route to your nearest cyclone shelter",
    ),
    "storm": (
        "Battery-powered or hand-crank radio for weather warnings",
        "Surge protectors for important electronics",
        "Tarpaulin and rope",
        "Candles or lanterns and matches in a waterproof box",
    ),
    "heatwave": (
        "ORS (oral rehydration salts) packets",
        "Light, loose cotton clothing",
        "Wide-brimmed hat or umbrella for shade",
        "Wet cloths or a spray bottle to cool down",
    ),
    "coldwave": (
        "Warm layered clothing, caps, gloves and thick socks",
        "Blankets or sleeping bags",
        "Thermos for hot drinks",
        "Safe heating only: never charcoal or generators indoors",
    ),
    "landslide": (
        "Sturdy boots and gloves",
        "Battery-powered radio for heavy-rain warnings",
        "Route to safe ground away from slopes and valleys",
        "Whistle to signal rescuers",
    ),
    "tsunami": (
        "Grab-and-go bag kept near the door",
        "Route to high ground (30 m above sea level) or 3 km inland",
        "Sturdy shoes for walking over debris",
        "Battery-powered radio",
    ),
    "drought": (
        "Covered containers for storing water",
        "Water purification tablets",
        "ORS (oral rehydration salts) packets",
        "Dust masks",
    ),
    "volcano": (
        "N95 masks and goggles",
        "Plastic sheeting to cover electronics and water tanks",
        "Long-sleeved clothing",
        "Battery-powered radio",
    ),
    "gas_leak": (
        "Gas or carbon monoxide detector",
        "Know where the gas shut-off valve is",
        "Spanner for the gas valve",
        "Emergency numbers saved on your phone",
    ),
    "medical": (
        "Medical information card (conditions, allergies, blood group)",
        "Disposable gloves, bandages and antiseptic",
        "Basic first-aid guide",
        "List of nearby hospitals and ambulance numbers",
    ),
    "accident": (
        "Reflective warning triangle and high-visibility vest in the vehicle",
        "First-aid kit kept in the vehicle",
        "Torch",
        "Emergency contact list",
    ),
}

GENERAL_ITEMS: tuple[str, ...] = (
    "Whistle to signal for help",
    "Some cash in small notes",
    "Spare clothes and a blanket",
    "Emergency contact list on paper",
)

CHECKLIST_SYSTEM_PROMPT = """\
You are the Checklist Agent of ResQ AI, a disaster-response assistant.
Create an emergency-kit and preparedness checklist for the disaster type you are given.
Rules:
- Output ONLY a JSON array of {count} strings, e.g. ["Item 1", "Item 2"].
- Write every item in {language}; each item is under 15 words.
- Start with life-saving essentials (water, medicines, first aid), then type-specific items.
- No numbering, no emojis, no duplicates."""

_BULLET_PREFIX = re.compile(r"^\s*(?:[-*•]+|\d{1,2}[.)])\s*")


def static_checklist(disaster_type: str) -> list[str]:
    """Built-in English checklist for a (canonical or free-form) disaster type."""
    canonical = normalize_disaster_type(disaster_type)
    return [*CORE_KIT, *TYPE_SPECIFIC_ITEMS.get(canonical, GENERAL_ITEMS)]


def clean_checklist(value: Any) -> list[str]:
    """Validate LLM output: list of strings or ``{"checklist": [...]}`` / ``{"items": [...]}``.

    Strips bullets/numbering, drops non-strings, blanks and duplicates, caps item length and
    count. Returns ``[]`` when nothing usable is left.
    """
    if isinstance(value, Mapping):
        value = value.get("checklist", value.get("items"))
    if not isinstance(value, list):
        return []
    return _clean_items(value)


def _clean_items(values: Iterable[Any]) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        text = " ".join(_BULLET_PREFIX.sub("", value).replace("**", "").split())
        if not text:
            continue
        if len(text) > MAX_ITEM_CHARS:
            text = text[: MAX_ITEM_CHARS - 1].rstrip() + "…"
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        items.append(text)
        if len(items) >= MAX_ITEMS:
            break
    return items


async def generate_checklist(
    disaster_type: str,
    language: str = "en",
    llm: LLMClient | None = None,
) -> list[str]:
    """Checklist for ``disaster_type`` in ``language`` (built-in English list as fallback).

    Never raises for LLM failures (cancellation still propagates).
    """
    canonical = normalize_disaster_type(disaster_type)
    if llm is None:
        return static_checklist(canonical)

    system = CHECKLIST_SYSTEM_PROMPT.format(count=REQUESTED_ITEMS, language=language_name(language))
    label = disaster_label(canonical) if canonical not in {"unknown", "general"} else "any"
    prompt = f"Disaster type: {label}.\nReturn the JSON array now."
    try:
        value = await llm.generate_json(prompt, system=system)
    except Exception:
        # LLMService never raises; this guards alternative/fake implementations.
        logger.warning("Checklist LLM call failed; using built-in checklist", exc_info=True)
        value = None
    items = clean_checklist(value)
    if not items:
        if value is not None:
            logger.warning("Checklist LLM output unusable (%s); using built-in list", type(value))
        return static_checklist(canonical)
    return items


__all__ = [
    "CHECKLIST_SYSTEM_PROMPT",
    "CORE_KIT",
    "TYPE_SPECIFIC_ITEMS",
    "clean_checklist",
    "generate_checklist",
    "static_checklist",
]
