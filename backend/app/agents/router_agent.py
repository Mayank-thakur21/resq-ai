import os
from g4f.client import AsyncClient
from app.agents.safety_agent import get_safety_instructions
from app.agents.mapping_agent import get_nearby_hospitals, get_nearby_shelters
from app.agents.advisory_agent import fetch_weather_alerts, summarize_advisory
from app.agents.checklist_agent import generate_checklist
from app.agents.translation_agent import translate_text

# Use g4f (free alternative) instead of OpenAI
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
        import json
        content = response.choices[0].message.content
        
        # g4f might wrap JSON in markdown blocks, so clean it
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
            
        return json.loads(content.strip())
    except Exception as e:
        print(f"Classification error: {e}")
        return {"disaster_type": "unknown", "urgency": "low", "intent": "other"}

async def process_chat(message: str, language: str = "en", location: dict = None) -> dict:
    """
    Orchestrates the response by delegating to specialized agents based on classification.
    """
    # 1. Classify
    classification = await classify_disaster(message)
    disaster_type = classification.get("disaster_type", "general")
    urgency = classification.get("urgency", "low")
    
    response_text = ""
    data = {}
    
    # 2. Safety First if high urgency or a specific disaster
    if urgency in ["high", "medium"] or disaster_type != "unknown":
        safety_text = await get_safety_instructions(disaster_type, location)
        response_text += f"{safety_text}\n\n"
        
    # 3. Check for specific intents
    intent = classification.get("intent")
    
    if intent == "seeking_help" and location:
        # Get mapping data
        lat = location.get("lat")
        lon = location.get("lon")
        hospitals = await get_nearby_hospitals(lat, lon)
        shelters = await get_nearby_shelters(lat, lon)
        data["hospitals"] = hospitals
        data["shelters"] = shelters
        
        response_text += f"I found {len(hospitals)} hospitals and {len(shelters)} shelters near you. Check the map for details.\n\n"
        
    if disaster_type != "unknown" and intent == "asking_info":
        checklist = await generate_checklist(disaster_type, language="en")
        data["checklist"] = checklist
        response_text += "Here is a quick checklist:\n" + "\n".join([f"- {item}" for item in checklist]) + "\n\n"
        
    if location and intent == "asking_info":
        weather_raw = await fetch_weather_alerts(location.get("lat"), location.get("lon"))
        weather_summary = await summarize_advisory(weather_raw, language="en")
        response_text += f"Advisory: {weather_summary}\n\n"
        
    if not response_text.strip():
        response_text = "I'm here to help with emergency situations. Could you provide more details about what you need or what is happening?"

    # Translate if necessary
    if language.lower() not in ["en", "english"]:
        response_text = await translate_text(response_text, language)

    return {
        "response": response_text.strip(),
        "agent_used": "Router (Safety, Mapping, Checklist)",
        "urgency_level": urgency,
        "data": data
    }
