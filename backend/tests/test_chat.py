"""Tests for the multi-agent chat (``/api/chat``), the AI tools (``/api/classify``,
``/api/checklist``, ``/api/translate``) and the agents behind them.

The LLM is either the real :class:`~app.services.llm.LLMService` without an API key (disabled,
so every agent uses its deterministic fallback) or :class:`conftest.FakeLLM`. Places and
weather services are replaced by in-memory fakes.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agents import router_agent
from app.agents.checklist_agent import CORE_KIT, clean_checklist, static_checklist
from app.agents.router_agent import (
    DEFAULT_EMERGENCY_NUMBERS,
    GENERIC_RESPONSE,
    extract_recommended_actions,
    get_emergency_numbers,
    keyword_classify,
    normalize_intent,
    normalize_urgency,
    process_chat,
)
from app.agents.safety_agent import (
    GENERAL_INSTRUCTIONS,
    STATIC_SAFETY_INSTRUCTIONS,
    get_safety_instructions,
    normalize_disaster_type,
    static_safety_instructions,
)
from app.agents.translation_agent import is_english, translate_many, translate_text
from app.core.errors import UpstreamError
from app.schemas.places import Place, PlaceType
from app.schemas.weather import CurrentWeather, ForecastItem, Hazard, WeatherResponse
from conftest import FakeLLM

DELHI = {"lat": 28.6139, "lon": 77.2090}
FLOOD_SOS = "There is a flood near my house, water is rising, please help!"


# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------
class FakePlaces:
    def __init__(self, *, error: Exception | None = None, count: int = 12) -> None:
        self.error = error
        self.count = count
        self.calls: list[tuple[float, float, str, int]] = []

    async def get_places(
        self, lat: float, lon: float, place_type: PlaceType, radius_m: int = 5000, **_: Any
    ) -> list[Place]:
        self.calls.append((lat, lon, place_type, radius_m))
        if self.error is not None:
            raise self.error
        return [
            Place(
                id=f"node/{i}",
                name=f"{place_type.title()} {i}",
                type=place_type,
                lat=lat + 0.01 * i,
                lon=lon,
                distance_km=round(1.1 * i, 3),
            )
            for i in range(1, self.count + 1)
        ]


def weather_response(country: str | None = "IN") -> WeatherResponse:
    observed = datetime(2026, 11, 2, 6, 0, tzinfo=UTC)
    return WeatherResponse(
        weather=CurrentWeather(
            temperature=27.0,
            feels_like=30.0,
            humidity=92,
            wind_speed_kmh=24.0,
            description="Heavy rain",
            icon="10d",
            weather_code=502,
            city="New Delhi",
            country=country,
            is_day=True,
            observed_at=observed,
            source="openweathermap",
        ),
        forecast=[
            ForecastItem(
                time=observed,
                temperature=26.0,
                description="Heavy rain",
                icon="10d",
                precipitation_probability=95,
            )
        ],
        hazards=[
            Hazard(
                type="heavy_rain",
                severity="high",
                message="Heavy rain is likely in the next hours. Avoid low-lying areas.",
            )
        ],
    )


class FakeWeather:
    def __init__(
        self, *, response: WeatherResponse | None = None, error: Exception | None = None
    ) -> None:
        self.response = response or weather_response()
        self.error = error
        self.calls: list[tuple[float, float]] = []

    async def get_weather(self, lat: float, lon: float) -> WeatherResponse:
        self.calls.append((lat, lon))
        if self.error is not None:
            raise self.error
        return self.response


@pytest.fixture
def places(client: TestClient) -> FakePlaces:
    fake = FakePlaces()
    client.app.state.places = fake  # type: ignore[attr-defined]
    return fake


@pytest.fixture
def weather(client: TestClient) -> FakeWeather:
    fake = FakeWeather()
    client.app.state.weather = fake  # type: ignore[attr-defined]
    return fake


def by_agent(**responders: Any) -> Any:
    """FakeLLM responder dispatching on the agent named in the system prompt."""

    def respond(prompt: str, system: str | None) -> Any:
        for marker, value in responders.items():
            if marker.replace("_", " ") in (system or ""):
                return value(prompt, system) if callable(value) else value
        return None

    return respond


def chat(client: TestClient, message: str, **extra: Any) -> dict[str, Any]:
    response = client.post("/api/chat", json={"message": message, **extra})
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------------------------
# /api/chat with the LLM disabled (deterministic fallbacks)
# ---------------------------------------------------------------------------------------------
def test_chat_without_llm_flood_emergency(
    client: TestClient, places: FakePlaces, weather: FakeWeather
) -> None:
    assert client.app.state.llm.enabled is False  # type: ignore[attr-defined]

    body = chat(client, FLOOD_SOS, location=DELHI)

    assert body["agent_used"] == "Router Ensemble"
    assert body["urgency_level"] == "high"
    assert body["detected_disaster"] == "flood"
    assert body["recommended_actions"] == list(STATIC_SAFETY_INSTRUCTIONS["flood"])
    assert "Move to higher ground" in body["response"]
    assert "I found 10 hospitals and 10 shelters near you." in body["response"]
    assert "Nearest hospital: Hospital 1 (1.1 km away)." in body["response"]
    assert "Advisory: - Current conditions in New Delhi (IN)" in body["response"]
    assert body["advisory"].startswith("- Current conditions in New Delhi (IN)")
    assert "Heavy rain is likely" in body["advisory"]

    assert len(body["data"]["hospitals"]) == 10
    assert body["data"]["hospitals"][0]["id"] == "node/1"
    assert body["data"]["shelters"][0]["type"] == "shelter"
    assert body["data"]["weather"]["weather"]["city"] == "New Delhi"
    assert "checklist" not in body["data"]
    assert body["emergency_numbers"] == [
        "112 (National Emergency)",
        "108 (Ambulance)",
        "100 (Police)",
        "101 (Fire)",
    ]
    assert body["steps_taken"] == [
        "Router Agent initialized",
        "Disaster classified: Flood (Urgency: high)",
        "Safety Agent fetched safety protocols",
        "Maps Agent located hospitals and shelters",
        "Advisory Agent fetched live weather alerts",
        "Response compiled successfully",
    ]
    assert sorted(call[2] for call in places.calls) == ["hospital", "shelter"]
    assert all(call[3] == 5000 for call in places.calls)
    assert weather.calls == [(DELHI["lat"], DELHI["lon"])]


def test_chat_generic_message(client: TestClient, places: FakePlaces, weather: FakeWeather) -> None:
    body = chat(client, "hello there", location=DELHI)

    assert body["response"] == GENERIC_RESPONSE
    assert body["urgency_level"] == "low"
    assert body["detected_disaster"] == "unknown"
    assert body["recommended_actions"] == []
    assert body["advisory"] is None
    assert body["data"] == {}
    assert body["emergency_numbers"] == list(DEFAULT_EMERGENCY_NUMBERS)
    assert body["emergency_numbers"][0].startswith("112")
    assert body["steps_taken"] == [
        "Router Agent initialized",
        "Disaster classified: Unknown (Urgency: low)",
        "Response compiled successfully",
    ]
    assert places.calls == []
    assert weather.calls == []


def test_chat_preparedness_question_runs_checklist(client: TestClient, places: FakePlaces) -> None:
    body = chat(client, "How do I prepare for an earthquake?")

    assert body["detected_disaster"] == "earthquake"
    assert body["urgency_level"] == "low"
    assert body["data"] == {"checklist": static_checklist("earthquake")}
    assert "Here is a quick checklist:\n- " + CORE_KIT[0] in body["response"]
    assert "Drop, Cover and Hold On" in body["response"]
    assert "Checklist Agent generated preparedness checklist" in body["steps_taken"]
    assert places.calls == []


def test_chat_without_location_skips_maps_and_weather(
    client: TestClient, places: FakePlaces, weather: FakeWeather
) -> None:
    body = chat(client, FLOOD_SOS)

    assert body["urgency_level"] == "high"
    assert places.calls == []
    assert weather.calls == []
    assert "hospitals" not in body["data"]


def test_chat_survives_places_failure(client: TestClient, weather: FakeWeather) -> None:
    client.app.state.places = FakePlaces(error=UpstreamError("Overpass down"))  # type: ignore[attr-defined]

    body = chat(client, FLOOD_SOS, location=DELHI)

    assert "Maps Agent could not reach OpenStreetMap" in body["steps_taken"]
    assert "I couldn't load nearby hospitals and shelters right now" in body["response"]
    assert "call 112 if you need urgent help" in body["response"]
    assert "hospitals" not in body["data"]
    assert body["recommended_actions"]  # safety still answered


def test_chat_partial_places_failure(client: TestClient, weather: FakeWeather) -> None:
    class HalfBroken(FakePlaces):
        async def get_places(
            self, lat: float, lon: float, place_type: PlaceType, *a: Any, **k: Any
        ):
            if place_type == "shelter":
                raise RuntimeError("bug in provider")
            return await super().get_places(lat, lon, place_type, *a, **k)

    client.app.state.places = HalfBroken(count=2)  # type: ignore[attr-defined]
    body = chat(client, FLOOD_SOS, location=DELHI)

    assert "Maps Agent located hospitals and shelters" in body["steps_taken"]
    assert "I found 2 hospitals near you." in body["response"]
    assert "Nearby shelters could not be loaded right now." in body["response"]
    assert len(body["data"]["hospitals"]) == 2
    assert "shelters" not in body["data"]


@pytest.mark.parametrize(
    ("count", "sentence"),
    [
        (1, "I found 1 hospital and 1 shelter near you."),
        (0, "I found no hospitals and no shelters near you."),
    ],
)
def test_chat_nearby_sentence_counts(
    client: TestClient, weather: FakeWeather, count: int, sentence: str
) -> None:
    client.app.state.places = FakePlaces(count=count)  # type: ignore[attr-defined]
    body = chat(client, FLOOD_SOS, location=DELHI)
    assert sentence in body["response"]
    assert len(body["data"]["hospitals"]) == count
    assert len(body["data"]["shelters"]) == count


def test_chat_survives_weather_failure(client: TestClient, places: FakePlaces) -> None:
    client.app.state.weather = FakeWeather(error=UpstreamError("Weather providers unavailable"))  # type: ignore[attr-defined]

    body = chat(client, FLOOD_SOS, location=DELHI)

    assert body["advisory"] is None
    assert "Advisory Agent could not fetch live weather" in body["steps_taken"]
    assert "weather" not in body["data"]
    assert body["emergency_numbers"] == list(DEFAULT_EMERGENCY_NUMBERS)


def test_chat_uses_country_from_weather_for_numbers(client: TestClient, places: FakePlaces) -> None:
    client.app.state.weather = FakeWeather(response=weather_response("US"))  # type: ignore[attr-defined]
    body = chat(client, FLOOD_SOS, location=DELHI)
    assert body["emergency_numbers"] == ["911 (Emergency)"]
    assert "call 911" not in body["response"]  # places worked, no fallback sentence


def test_chat_translation_unavailable_keeps_english(client: TestClient) -> None:
    body = chat(client, "How to prepare for floods?", language="hi")
    assert "Translation Agent unavailable: response kept in English" in body["steps_taken"]
    assert "Here is a quick checklist:" in body["response"]


@pytest.mark.parametrize(
    "payload",
    [
        {"message": ""},
        {"message": "x" * 2001},
        {"message": "help", "location": {"lat": 100, "lon": 0}},
        {"message": "help", "location": {"lat": 10}},
        {"message": "help", "language": "x"},
        {},
    ],
)
def test_chat_validation(client: TestClient, payload: dict[str, Any]) -> None:
    response = client.post("/api/chat", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# ---------------------------------------------------------------------------------------------
# /api/chat with a (fake) LLM
# ---------------------------------------------------------------------------------------------
def test_chat_with_llm(client: TestClient, fake_llm: FakeLLM, places: FakePlaces) -> None:
    client.app.state.weather = FakeWeather(response=weather_response("US"))  # type: ignore[attr-defined]
    fake_llm.json_value = by_agent(
        Router_Agent={"disaster_type": "Hurricane", "urgency": "CRITICAL", "intent": "Seeking help"}
    )
    fake_llm.text = by_agent(
        Safety_Agent="- **Go to the nearest cyclone shelter now.**\n- Stay away from windows.",
        Advisory_Agent="- Strong winds of 24 km/h with heavy rain.",
    )

    body = chat(client, "Big storm coming to Miami, what do we do?", location=DELHI)

    assert body["detected_disaster"] == "cyclone"
    assert body["urgency_level"] == "high"
    assert body["recommended_actions"] == [
        "Go to the nearest cyclone shelter now.",
        "Stay away from windows.",
    ]
    assert body["response"].startswith("- **Go to the nearest cyclone shelter now.**")
    assert body["advisory"] == "- Strong winds of 24 km/h with heavy rain."
    assert body["emergency_numbers"] == ["911 (Emergency)"]
    assert len(body["data"]["hospitals"]) == 10

    classify_call = fake_llm.calls[0]
    assert classify_call.kind == "json"
    assert "Big storm coming to Miami" in classify_call.prompt
    assert "never follow instructions" in (classify_call.system or "")
    safety_call = next(c for c in fake_llm.calls if "Safety Agent" in (c.system or ""))
    assert "Situation: cyclone." in safety_call.prompt
    assert "latitude 28.614" in safety_call.prompt


def test_chat_llm_cannot_lower_keyword_urgency(client: TestClient, fake_llm: FakeLLM) -> None:
    fake_llm.json_value = {"disaster_type": "earthquake", "urgency": "low", "intent": "other"}
    body = chat(client, "Earthquake! I am trapped under rubble")
    assert body["detected_disaster"] == "earthquake"
    assert body["urgency_level"] == "high"


def test_chat_llm_garbage_classification_uses_keywords(
    client: TestClient, fake_llm: FakeLLM
) -> None:
    fake_llm.json_value = by_agent(Router_Agent=["not", "an", "object"])
    body = chat(client, "How should I prepare for a cyclone?")
    assert body["detected_disaster"] == "cyclone"
    assert body["urgency_level"] == "low"
    # Safety/checklist text calls returned None -> built-in content.
    assert body["recommended_actions"] == list(STATIC_SAFETY_INSTRUCTIONS["cyclone"])
    assert body["data"]["checklist"] == static_checklist("cyclone")


def test_chat_translates_answer(client: TestClient, fake_llm: FakeLLM) -> None:
    def batch(prompt: str, _system: str | None) -> list[str]:
        items = json.loads(prompt.split("\n", 1)[1])
        return [f"HI: {item}" for item in items]

    fake_llm.json_value = by_agent(
        Router_Agent={"disaster_type": "flood", "urgency": "medium", "intent": "asking_info"},
        Translate_every_string=batch,
        Checklist_Agent=["Water", "Torch"],
    )
    fake_llm.text = by_agent(
        Safety_Agent="- Move to higher ground.",
        Translate_the_user=lambda prompt, _s: '"""बाढ़ में ऊँचे स्थान पर जाएँ।"""',
    )

    body = chat(client, "What should I do in a flood?", language="hi")

    assert body["response"] == "बाढ़ में ऊँचे स्थान पर जाएँ।"
    assert body["recommended_actions"] == ["HI: Move to higher ground."]
    assert body["data"]["checklist"] == ["HI: Water", "HI: Torch"]
    assert "Translation Agent translated response to Hindi" in body["steps_taken"]
    translate_call = next(c for c in fake_llm.calls if "Translate the user" in (c.system or ""))
    assert "Hindi" in (translate_call.system or "")
    assert "Here is a quick checklist:" in translate_call.prompt


# ---------------------------------------------------------------------------------------------
# /api/classify, /api/checklist, /api/translate
# ---------------------------------------------------------------------------------------------
def test_classify_without_llm(client: TestClient) -> None:
    response = client.post("/api/classify", json={"message": "Help! I'm trapped"})
    assert response.status_code == 200
    assert response.json() == {
        "disaster_type": "general",
        "urgency": "high",
        "intent": "seeking_help",
    }


def test_classify_with_llm_normalises_output(client: TestClient, fake_llm: FakeLLM) -> None:
    fake_llm.json_value = {
        "disaster_type": "Flash flood",
        "urgency": "moderate",
        "intent": "asking information",
    }
    response = client.post("/api/classify", json={"message": "what to do in floods"})
    assert response.json() == {
        "disaster_type": "flood",
        "urgency": "medium",
        "intent": "asking_info",
    }


def test_classify_validation(client: TestClient) -> None:
    assert client.post("/api/classify", json={"message": ""}).status_code == 422


def test_checklist_without_llm(client: TestClient) -> None:
    flood = client.post("/api/checklist", json={"disaster_type": "flood"}).json()["checklist"]
    assert flood == static_checklist("flood")
    assert "Waterproof bags for phones, documents and medicines" in flood
    assert flood[: len(CORE_KIT)] == list(CORE_KIT)

    other = client.post("/api/checklist", json={"disaster_type": "alien attack"}).json()
    assert other["checklist"][: len(CORE_KIT)] == list(CORE_KIT)
    assert "Whistle to signal for help" in other["checklist"]


def test_checklist_with_llm(client: TestClient, fake_llm: FakeLLM) -> None:
    fake_llm.json_value = {"checklist": ["1. Water", "- water", "  Torch  ", 5, "**Radio**", ""]}
    response = client.post("/api/checklist", json={"disaster_type": "Typhoon", "language": "hi"})
    assert response.json() == {"checklist": ["Water", "Torch", "Radio"]}
    call = fake_llm.calls[-1]
    assert call.kind == "json"
    assert "Hindi" in (call.system or "")
    assert "Disaster type: cyclone." in call.prompt


@pytest.mark.parametrize("garbage", [None, {"items": "nope"}, [1, 2, 3], "text"])
def test_checklist_llm_garbage_falls_back(
    client: TestClient, fake_llm: FakeLLM, garbage: Any
) -> None:
    fake_llm.json_value = garbage
    body = client.post("/api/checklist", json={"disaster_type": "fire"}).json()
    assert body["checklist"] == static_checklist("fire")


def test_translate_endpoint(client: TestClient, fake_llm: FakeLLM) -> None:
    fake_llm.text = "Bonjour"
    english = client.post("/api/translate", json={"text": "Hello", "target_language": "en-IN"})
    assert english.json() == {"translated_text": "Hello"}
    assert fake_llm.calls == []  # English targets never call the LLM

    french = client.post("/api/translate", json={"text": "Hello", "target_language": "fr"})
    assert french.json() == {"translated_text": "Bonjour"}
    assert "French" in (fake_llm.calls[-1].system or "")


def test_translate_without_llm_returns_original(client: TestClient) -> None:
    response = client.post("/api/translate", json={"text": "Stay safe", "target_language": "ta"})
    assert response.json() == {"translated_text": "Stay safe"}


def test_translate_validation(client: TestClient) -> None:
    assert client.post("/api/translate", json={"text": "hi"}).status_code == 422
    assert (
        client.post("/api/translate", json={"text": "", "target_language": "hi"}).status_code == 422
    )


# ---------------------------------------------------------------------------------------------
# Agent units
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (FLOOD_SOS, ("flood", "high", "seeking_help")),
        ("How do I prepare for an earthquake?", ("earthquake", "low", "asking_info")),
        ("Where is the nearest hospital?", ("unknown", "low", "seeking_help")),
        ("Where is the nearest fire station?", ("unknown", "low", "seeking_help")),
        ("Can you help me prepare a checklist for floods?", ("flood", "low", "asking_info")),
        ("There's a fire in the building next door", ("fire", "medium", "reporting")),
        ("My friend is bleeding after a car accident", ("accident", "high", "other")),
        ("I smell gas in my kitchen", ("gas_leak", "medium", "other")),
        ("What should I pack in an emergency kit?", ("unknown", "low", "asking_info")),
        ("hello", ("unknown", "low", "other")),
    ],
)
def test_keyword_classify(message: str, expected: tuple[str, str, str]) -> None:
    result = keyword_classify(message)
    assert (result.disaster_type, result.urgency, result.intent) == expected


@pytest.mark.parametrize(
    ("message", "disaster", "urgency"),
    [
        # Regression: without Gemini these all got unknown/low and a generic "tell me more".
        ("Water is entering my house after heavy rain. What should I do?", "flood", "medium"),
        ("Heavy rain and the water level is up to my knees inside the house", "flood", "medium"),
        ("My street is under water", "flood", "medium"),
        ("Water entering home, kids with me", "flood", "medium"),
        ("The river overflowed into our village", "flood", "medium"),
        ("Our home is submerged", "flood", "medium"),
        ("Water coming into the house", "flood", "medium"),
        ("The river burst its banks", "flood", "medium"),
        ("The dam broke", "flood", "medium"),
        ("My basement is full of water", "flood", "medium"),
        ("The ground is shaking", "earthquake", "medium"),
        ("Strong winds are tearing roofs off", "storm", "medium"),
        ("It is extremely hot and my father is dizzy", "heatwave", "medium"),
        ("My grandmother fell and hit her head", "medical", "medium"),
        ("Help, water is entering my house", "flood", "high"),
        # Questions about the future stay low; an ongoing hazard does not.
        ("Will there be heavy rain tomorrow?", "flood", "low"),
        ("How do I protect my house from floods?", "flood", "low"),
        ("Water is up to my waist, what should I do?", "flood", "medium"),
        # No false alarms from everyday words.
        ("A tree fell on the road", "unknown", "low"),
        ("Should I drink more water in summer?", "unknown", "low"),
    ],
)
def test_keyword_classify_everyday_descriptions(message: str, disaster: str, urgency: str) -> None:
    result = keyword_classify(message)
    assert (result.disaster_type, result.urgency) == (disaster, urgency)


async def test_flood_description_without_llm_gets_safety_steps() -> None:
    """Regression: "Water is entering my house" got URGENCY: LOW and the generic reply."""
    from app.agents.router_agent import GENERIC_RESPONSE, process_chat

    result = await process_chat(
        "Water is entering my house after heavy rain. What should I do?",
        "en",
        None,
        llm=None,
    )
    assert result.detected_disaster == "flood"
    assert result.urgency_level == "medium"
    assert result.response != GENERIC_RESPONSE
    assert result.recommended_actions


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hurricane", "cyclone"),
        ("flash flood", "flood"),
        ("Heat-Wave", "heatwave"),
        ("EQ", "earthquake"),
        ("avalanche", "avalanche"),
        ("", "unknown"),
        (None, "unknown"),
        ("drop table; --", "unknown"),
        ("other", "general"),
    ],
)
def test_normalize_disaster_type(raw: Any, expected: str) -> None:
    assert normalize_disaster_type(raw) == expected


def test_normalize_urgency_and_intent() -> None:
    assert normalize_urgency("CRITICAL") == "high"
    assert normalize_urgency("Medium") == "medium"
    assert normalize_urgency("purple") is None
    assert normalize_intent("Seeking help") == "seeking_help"
    assert normalize_intent("question") == "asking_info"
    assert normalize_intent(42) is None


@pytest.mark.parametrize(
    ("country", "first"),
    [
        ("IN", "112 (National Emergency)"),
        ("us", "911 (Emergency)"),
        ("GB", "999 (Emergency)"),
        ("FR", "112 (Emergency)"),
        ("AU", "000 (Emergency)"),
        ("KE", "112 (International Emergency)"),
        (None, "112 (International Emergency)"),
    ],
)
def test_emergency_numbers(country: str | None, first: str) -> None:
    numbers = get_emergency_numbers(country)
    assert numbers[0] == first
    if country is None:
        assert numbers == list(DEFAULT_EMERGENCY_NUMBERS)
        assert any("108" in n for n in numbers)
    if country == "GB":
        assert numbers == ["999 (Emergency)", "112 (Emergency)"]


def test_extract_recommended_actions() -> None:
    text = "Stay safe:\n1. Move uphill\n2) **Avoid** water\n- Call 112\n* Move uphill\n\n10. Ten"
    assert extract_recommended_actions(text) == ["Move uphill", "Avoid water", "Call 112", "Ten"]
    assert extract_recommended_actions("Line one\nLine two\nLine three\nLine four") == [
        "Line one",
        "Line two",
        "Line three",
    ]
    assert extract_recommended_actions("") == []
    assert len(extract_recommended_actions("\n".join(f"- a{i}" for i in range(10)))) == 6


def test_static_safety_instructions_cover_common_types() -> None:
    for disaster in ("flood", "earthquake", "fire", "cyclone", "heatwave", "landslide", "medical"):
        assert 3 <= len(static_safety_instructions(disaster)) <= 5
    assert static_safety_instructions("unknown") == list(GENERAL_INSTRUCTIONS)
    assert static_safety_instructions("Typhoon") == list(STATIC_SAFETY_INSTRUCTIONS["cyclone"])


async def test_safety_agent_survives_raising_llm() -> None:
    def boom(prompt: str, system: str | None) -> str:
        raise RuntimeError("bad fake")

    text = await get_safety_instructions("fire", llm=FakeLLM(text=boom))
    assert text.startswith("- Get out immediately")


async def test_translation_helpers() -> None:
    assert is_english("en") and is_english("English") and is_english("en-GB") and is_english("")
    assert not is_english("hi")
    llm = FakeLLM(json_value=["uno"])  # wrong length -> originals
    assert await translate_many(["one", "two"], "es", llm) == ["one", "two"]
    assert await translate_many([], "es", llm) == []
    assert await translate_text("   ", "es", FakeLLM(text="x")) == "   "


def test_clean_checklist() -> None:
    assert clean_checklist(["a", "A", " b "]) == ["a", "b"]
    assert clean_checklist({"items": ["x"]}) == ["x"]
    assert len(clean_checklist([f"item {i}" for i in range(30)])) == 12
    assert clean_checklist("nope") == []


async def test_process_chat_without_services() -> None:
    """The agent works stand-alone (no places/weather services, no LLM)."""
    result = await process_chat(FLOOD_SOS, "en", DELHI)
    assert result.detected_disaster == "flood"
    assert "hospitals" not in result.data
    assert result.advisory is None
    assert result.agent_used == router_agent.AGENT_NAME


# ---------------------------------------------------------------------------------------------
# Time budget (the frontend proxy gives up after 20 s)
# ---------------------------------------------------------------------------------------------
class HangingLLM(FakeLLM):
    """An LLM that never answers in time (Gemini overloaded / network blackhole)."""

    async def generate_text(self, prompt: str, system: str | None = None, **_: Any) -> str | None:
        await asyncio.sleep(30)
        return "too late"

    async def generate_json(self, prompt: str, system: str | None = None, **_: Any) -> Any:
        await asyncio.sleep(30)
        return {"disaster_type": "earthquake", "urgency": "low", "intent": "other"}


class HangingWeather(FakeWeather):
    async def get_weather(self, lat: float, lon: float) -> WeatherResponse:
        await asyncio.sleep(30)
        return self.response


def test_chat_budgets_stay_below_the_proxy_timeout() -> None:
    from app.services import llm as llm_module

    assert router_agent.CHAT_TIME_BUDGET_SECONDS < 20
    assert llm_module.DEFAULT_LLM_TIMEOUT_SECONDS < 20
    assert router_agent.CLASSIFY_BUDGET_SECONDS + router_agent.TRANSLATION_RESERVE_SECONDS < (
        router_agent.CHAT_TIME_BUDGET_SECONDS
    )


async def test_hanging_llm_yields_the_deterministic_answer_within_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(router_agent, "CHAT_TIME_BUDGET_SECONDS", 0.9)
    monkeypatch.setattr(router_agent, "CLASSIFY_BUDGET_SECONDS", 0.2)
    monkeypatch.setattr(router_agent, "TRANSLATION_RESERVE_SECONDS", 0.2)
    monkeypatch.setattr(router_agent, "MIN_STAGE_SECONDS", 0.05)
    started = time.perf_counter()
    result = await process_chat(
        FLOOD_SOS,
        "hi",
        DELHI,
        llm=HangingLLM(),
        places=FakePlaces(),
        weather=HangingWeather(),
    )
    elapsed = time.perf_counter() - started

    assert elapsed < 2.0
    # Keyword classification + built-in flood protocol instead of a 504.
    assert result.detected_disaster == "flood"
    assert result.urgency_level == "high"
    assert any("higher ground" in action.lower() for action in result.recommended_actions)
    assert "hospitals" in result.data  # the fast specialists still contributed
    assert "Translation Agent unavailable: response kept in English" in result.steps_taken
    assert "Advisory Agent could not fetch live weather" in result.steps_taken


def test_advisories_fall_back_when_the_llm_hangs(
    client: TestClient, weather: FakeWeather, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import weather as weather_routes

    monkeypatch.setattr(weather_routes, "ADVISORY_LLM_BUDGET_SECONDS", 0.2)
    client.app.state.llm = HangingLLM()  # type: ignore[attr-defined]
    response = client.get("/api/advisories", params=DELHI)
    assert response.status_code == 200
    assert response.json()["advisories"]
