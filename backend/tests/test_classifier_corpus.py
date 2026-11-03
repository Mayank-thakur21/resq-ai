"""Table-driven corpus for the keyword classifier (the chat's answer when no LLM is configured).

Each row is ``(message, disaster_type, urgency)``. Rows are grouped by what they protect:
hazards described in everyday words (so the chat gives the right protocol without the LLM),
questions that must stay low, and everyday sentences that must not raise false alarms.
"""

import pytest

from app.agents.router_agent import (
    GENERIC_RESPONSE,
    generic_safety_steps,
    keyword_classify,
    process_chat,
)
from app.schemas.chat import Urgency

#: Flood situations phrased without the word "flood" (water as the subject of a movement or
#: level verb in any tense, being cut off or surrounded by water, water everywhere, depth).
FLOOD_SITUATIONS: list[tuple[str, str, Urgency]] = [
    ("Water entered my house", "flood", "medium"),
    ("Water has entered our home, what do I do", "flood", "medium"),
    ("Water has entered the ground floor", "flood", "medium"),
    ("Rain water entered the house", "flood", "medium"),
    ("The water keeps rising", "flood", "medium"),
    ("The water has reached the first floor", "flood", "medium"),
    ("We are stranded on the roof, water all around", "flood", "high"),
    ("Our village is cut off by water", "flood", "medium"),
    ("There is water everywhere in our colony", "flood", "medium"),
    ("Water is coming in through the front door", "flood", "medium"),
    ("Flood water rose overnight and reached our beds", "flood", "medium"),
    ("Water started seeping into the basement", "flood", "medium"),
    ("The river is rising fast near our street", "flood", "medium"),
    ("Water flowing into the house from the drain", "flood", "medium"),
    ("We are surrounded by water", "flood", "medium"),
    ("Knee-deep water on our street", "flood", "medium"),
    ("The water outside is waist deep", "flood", "medium"),
    ("Rainwater has been entering the kitchen since morning", "flood", "medium"),
    ("Water got inside the shop", "flood", "medium"),
    ("Water is up to the first floor windows", "flood", "medium"),
    ("Our area is waterlogged", "flood", "medium"),
    ("Help! Water is entering our house", "flood", "high"),
    ("Help my house is filling with water", "flood", "high"),
]

#: Other hazards, one or more rows each.
OTHER_HAZARDS: list[tuple[str, str, Urgency]] = [
    ("The building is shaking", "earthquake", "medium"),
    ("Earthquake! Walls cracked and people are trapped", "earthquake", "high"),
    ("There is a fire in my kitchen", "fire", "medium"),
    ("Smoke is coming from the flat upstairs", "fire", "medium"),
    ("A cyclone is expected to hit our coast tonight", "cyclone", "medium"),
    ("Strong winds blew the roof off our shed", "storm", "medium"),
    ("Lightning struck a tree near our house", "storm", "medium"),
    ("My father collapsed in the heat, I think it is heat stroke", "heatwave", "high"),
    ("My grandfather has hypothermia", "coldwave", "medium"),
    ("A landslide has blocked the road to our village", "landslide", "medium"),
    ("Tsunami warning issued for our coast", "tsunami", "medium"),
    ("I smell gas in my kitchen", "gas_leak", "medium"),
    ("There is a chemical spill at the factory", "gas_leak", "medium"),
    ("The volcano near us is erupting", "volcano", "medium"),
    ("There was a car crash on the highway", "accident", "medium"),
    ("My friend is bleeding after a car accident", "accident", "high"),
    # "fell" with a person as the subject is a medical emergency.
    ("My grandmother fell and hit her head", "medical", "medium"),
    ("I fell down the stairs and my ankle hurts", "medical", "medium"),
    ("Grandpa slipped and fell in the bathroom", "medical", "medium"),
    ("She has fallen from the bus", "medical", "medium"),
    ("He fell off a ladder and is not breathing", "medical", "high"),
    ("My son has a high fever", "medical", "medium"),
    ("Someone fainted at the bus stop", "medical", "medium"),
]

#: No hazard named, but someone is in danger now: general / high.
DISTRESS: list[tuple[str, str, Urgency]] = [
    ("Help!", "general", "high"),
    ("help", "general", "high"),
    ("Help, please send someone", "general", "high"),
    ("Help needed at the bridge", "general", "high"),
    ("We are trapped in the lift", "general", "high"),
    ("Please help us", "general", "high"),
    ("SOS", "general", "high"),
    ("I'm stuck under the rubble", "general", "high"),
    ("My kids are stuck inside the building", "general", "high"),
]

#: Questions about hazards (preparedness, "what if"): the type is known, urgency stays low.
QUESTIONS: list[tuple[str, str, Urgency]] = [
    ("How do I prepare for an earthquake?", "earthquake", "low"),
    ("How should I prepare for a hurricane?", "cyclone", "low"),
    ("Tips for staying safe in a heatwave?", "heatwave", "low"),
    ("How do we save water during a drought?", "drought", "low"),
    ("How do I protect my house from floods?", "flood", "low"),
    ("What should I do if water enters my house?", "flood", "low"),
    ("What to do in case the river rises?", "flood", "low"),
    ("Can you help me prepare a checklist for floods?", "flood", "low"),
]

#: Everyday messages (and look-alikes of emergency phrases) that must not raise an alarm.
NEGATIVES: list[tuple[str, str, Urgency]] = [
    ("hello", "unknown", "low"),
    ("Thanks for the info", "unknown", "low"),
    ("Should I drink more water in summer?", "unknown", "low"),
    ("How much water should I store for my family?", "unknown", "low"),
    ("What should I pack in an emergency kit?", "unknown", "low"),
    ("Where is the nearest hospital?", "unknown", "low"),
    ("Where is the nearest fire station?", "unknown", "low"),
    ("Where is the fire extinguisher?", "unknown", "low"),
    ("The water bill is too high this month", "unknown", "low"),
    ("Is tap water safe to drink?", "unknown", "low"),
    ("The water is flowing from the tap again", "unknown", "low"),
    ("Water prices are rising", "unknown", "low"),
    # "fell" without a person as the subject.
    ("My phone fell off the table", "unknown", "low"),
    ("The tree fell down on the road", "unknown", "low"),
    ("A tree fell on the road", "unknown", "low"),
    ("Prices fell sharply this week", "unknown", "low"),
    ("The stock market fell off a cliff", "unknown", "low"),
    # "help" as part of a name or an ordinary request, not a cry for help.
    ("Help desk phone number?", "unknown", "low"),
    ("Help center opening hours", "unknown", "low"),
    ("Help me find the help line", "unknown", "low"),
    ("Can you help me understand the alerts page?", "unknown", "low"),
    # "SOS" and "stuck" about the app or things, not people.
    ("How does the SOS button work?", "unknown", "low"),
    ("I pressed the SOS but nothing happened", "unknown", "low"),
    ("My phone is stuck on the loading screen", "unknown", "low"),
    ("I'm stuck in traffic", "unknown", "low"),
    ("I'm knee-deep in paperwork", "unknown", "low"),
]

CORPUS = FLOOD_SITUATIONS + OTHER_HAZARDS + DISTRESS + QUESTIONS + NEGATIVES


def test_corpus_is_large_and_has_no_duplicates() -> None:
    messages = [message for message, _, _ in CORPUS]
    assert len(messages) >= 60
    assert len(set(messages)) == len(messages)


@pytest.mark.parametrize(("message", "disaster", "urgency"), CORPUS)
def test_keyword_classifier_corpus(message: str, disaster: str, urgency: Urgency) -> None:
    result = keyword_classify(message)
    assert (result.disaster_type, result.urgency) == (disaster, urgency)


@pytest.mark.parametrize(
    ("message", "intent"),
    [
        # A hazard happening now plus "what do I do" is a request for help (the chat then
        # also lists nearby shelters and hospitals when a location is shared).
        ("Water has entered our home, what do I do", "seeking_help"),
        ("Water is up to my waist, what should I do?", "seeking_help"),
        # The same words about a hypothetical stay a question.
        ("What should I do if water enters my house?", "asking_info"),
        ("Help desk phone number?", "seeking_help"),
        ("How does the SOS button work?", "asking_info"),
    ],
)
def test_keyword_classifier_intent(message: str, intent: str) -> None:
    assert keyword_classify(message).intent == intent


@pytest.mark.parametrize(
    "message",
    ["hello there", "Help desk phone number?", "asdf qwerty", "Thanks for the info"],
)
async def test_unrecognised_message_still_gets_basic_safety_steps(message: str) -> None:
    """Regression: an unrecognised message got only "tell me more" and no actions."""
    result = await process_chat(message, "en", None, llm=None)

    steps = generic_safety_steps("112")
    assert result.detected_disaster == "unknown"
    assert result.urgency_level == "low"
    assert result.response.startswith(GENERIC_RESPONSE)
    assert all(step in result.response for step in steps)
    assert result.recommended_actions == steps
    assert "112" in result.recommended_actions[0]


def test_generic_safety_steps_cover_the_basics() -> None:
    steps = " ".join(generic_safety_steps("911")).lower()
    assert "call 911" in steps
    assert "safe place" in steps
    assert "location" in steps
