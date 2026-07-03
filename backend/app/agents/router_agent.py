import os
import json
from g4f.client import AsyncClient
from app.agents.safety_agent import get_safety_instructions
from app.agents.mapping_agent import get_nearby_hospitals, get_nearby_shelters
from app.agents.advisory_agent import fetch_weather_alerts, summarize_advisory
from app.agents.checklist_agent import generate_checklist
from app.agents.translation_agent import translate_text

client = AsyncClient()

async def classify_disaster(message: str) -> dict:
    prompt = f"""
    You are an emergency response classifier. Analyze the following user message and classify it.
    Message: "{message}"
    
    Output JSON exactly with the following keys:
    - disaster_type: (e.g., "flood", "earthquake", "fire", "cyclone", "heatwave", "general", "unknown")
    - urgency: ("high", "medium", "low")
    - intent: (e.g., "seeking_help", "asking_info", "reporting", "other")
    """
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "system", "content": "You are a helpful assistant that outputs JSON."},
                      {"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
            
        return json.loads(content.strip())
    except Exception as e:
        print(f"Classification error: {e}")
        return {"disaster_type": "unknown", "urgency": "low", "intent": "other"}

async def extract_recommended_actions(safety_text: str) -> list:
    """Uses a simple split logic to extract bullet points from safety text."""
    lines = safety_text.split('\n')
    actions = [line.strip('-* ').strip() for line in lines if line.strip().startswith(('-', '*')) or (len(line) > 0 and line[0].isdigit() and line[1:3] in ['. ', ') '])]
    if not actions:
        actions = [line.strip() for line in lines if line.strip()][:3]
    return actions

def get_emergency_numbers(disaster_type: str, location: dict = None) -> list:
    # In a real app, this would use location to fetch local numbers
    return ["112 (National Emergency)", "108 (Ambulance)", "100 (Police)", "101 (Fire)"]

async def process_chat(message: str, language: str = "en", location: dict = None) -> dict:
    steps_taken = ["Router Agent initialized"]
    classification = await classify_disaster(message)
    disaster_type = classification.get("disaster_type", "unknown")
    urgency = classification.get("urgency", "low")
    intent = classification.get("intent")
    
    steps_taken.append(f"Disaster classified: {disaster_type.capitalize()} (Urgency: {urgency})")
    
    response_text = ""
    data = {}
    advisory_summary = None
    recommended_actions = []
    
    if urgency in ["high", "medium"] or disaster_type != "unknown":
        steps_taken.append("Safety Agent fetched safety protocols")
        safety_text = await get_safety_instructions(disaster_type, location)
        response_text += f"{safety_text}\n\n"
        recommended_actions = await extract_recommended_actions(safety_text)

    if intent == "seeking_help" and location:
        steps_taken.append("Maps Agent located hospitals and shelters")
        lat = location.get("lat")
        lon = location.get("lon")
        hospitals = await get_nearby_hospitals(lat, lon)
        shelters = await get_nearby_shelters(lat, lon)
        data["hospitals"] = hospitals
        data["shelters"] = shelters
        response_text += f"I found {len(hospitals)} hospitals and {len(shelters)} shelters near you.\n\n"

    if disaster_type != "unknown" and intent == "asking_info":
        steps_taken.append("Checklist Agent generated preparedness checklist")
        checklist = await generate_checklist(disaster_type, language="en")
        data["checklist"] = checklist
        response_text += "Here is a quick checklist:\n" + "\n".join([f"- {item}" for item in checklist]) + "\n\n"

    if location and (intent == "asking_info" or urgency == "high"):
        steps_taken.append("Advisory Agent fetched live weather alerts")
        weather_raw = await fetch_weather_alerts(location.get("lat"), location.get("lon"))
        advisory_summary = await summarize_advisory(weather_raw, language="en")
        response_text += f"Advisory: {advisory_summary}\n\n"

    if not response_text.strip():
        response_text = "I'm here to help with emergency situations. Could you provide more details about what you need or what is happening?"

    if language.lower() not in ["en", "english"]:
        steps_taken.append(f"Translation Agent translated response to {language}")
        response_text = await translate_text(response_text, language)

    steps_taken.append("Response compiled successfully")

    return {
        "response": response_text.strip(),
        "agent_used": "Router Ensemble",
        "urgency_level": urgency,
        "detected_disaster": disaster_type,
        "advisory": advisory_summary,
        "recommended_actions": recommended_actions,
        "emergency_numbers": get_emergency_numbers(disaster_type, location),
        "steps_taken": steps_taken,
        "data": data
    }
