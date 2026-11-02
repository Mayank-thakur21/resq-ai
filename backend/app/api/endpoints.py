# pyrefly: ignore [missing-import]
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.models.schemas import (
    ChatRequest, ChatResponse, ClassifyRequest,
    ChecklistRequest, TranslateRequest
)
from app.agents.router_agent import process_chat, classify_disaster
from app.agents.mapping_agent import get_nearby_hospitals, get_nearby_shelters, get_nearby_police, get_nearby_fire_stations
from app.agents.advisory_agent import fetch_weather_alerts, summarize_advisory
from app.agents.checklist_agent import generate_checklist
from app.agents.translation_agent import translate_text
from app.agents.weather_agent import get_current_weather, get_disaster_alerts
from app.agents.sos_agent import send_sos, get_sos_history
from app.agents.incident_agent import report_incident, get_nearby_incidents, get_all_incidents, upvote_incident

router = APIRouter()

# ── Extra schemas ─────────────────────────────────────────────────────────────
class SOSRequest(BaseModel):
    lat: float
    lon: float
    message: str = "SOS! I need help!"
    contact_numbers: Optional[List[str]] = []
    user_name: str = "Anonymous"

class IncidentRequest(BaseModel):
    lat: float
    lon: float
    disaster_type: str
    description: str
    severity: str = "medium"
    reporter_name: str = "Anonymous"
    image_url: Optional[str] = None

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    result = await process_chat(request.message, request.language, request.location)
    return ChatResponse(
        response=result["response"],
        agent_used=result["agent_used"],
        urgency_level=result["urgency_level"],
        detected_disaster=result.get("detected_disaster"),
        advisory=result.get("advisory"),
        recommended_actions=result.get("recommended_actions"),
        emergency_numbers=result.get("emergency_numbers"),
        steps_taken=result.get("steps_taken"),
        data=result.get("data")
    )

@router.post("/classify")
async def classify(request: ClassifyRequest):
    return await classify_disaster(request.message)

@router.get("/shelters")
async def get_shelters(lat: float, lon: float, radius: int = 5000):
    results = await get_nearby_shelters(lat, lon, radius)
    return {"shelters": results}

@router.get("/hospitals")
async def get_hospitals(lat: float, lon: float, radius: int = 5000):
    results = await get_nearby_hospitals(lat, lon, radius)
    return {"hospitals": results}

@router.get("/police")
async def get_police(lat: float, lon: float, radius: int = 5000):
    results = await get_nearby_police(lat, lon, radius)
    return {"police": results}

@router.get("/fire-stations")
async def get_fire_stations(lat: float, lon: float, radius: int = 5000):
    results = await get_nearby_fire_stations(lat, lon, radius)
    return {"fire_stations": results}

@router.get("/advisories")
async def get_advisories(lat: float, lon: float):
    raw_weather = await fetch_weather_alerts(lat, lon)
    summary = await summarize_advisory(raw_weather)
    return {"advisories": summary}

@router.post("/checklist")
async def get_checklist(request: ChecklistRequest):
    checklist = await generate_checklist(request.disaster_type, request.language)
    return {"checklist": checklist}

@router.post("/translate")
async def translate(request: TranslateRequest):
    translated = await translate_text(request.text, request.target_language)
    return {"translated_text": translated}

# ── Real Weather ───────────────────────────────────────────────────────────────
@router.get("/weather")
async def get_weather(lat: float, lon: float):
    """Get real-time weather for a location."""
    weather = await get_current_weather(lat, lon)
    alerts = await get_disaster_alerts(lat, lon)
    return {"weather": weather, "alerts": alerts}

# ── SOS ───────────────────────────────────────────────────────────────────────
@router.post("/sos")
async def trigger_sos(request: SOSRequest):
    """Send SOS alert with location to emergency contacts via SMS."""
    result = await send_sos(
        lat=request.lat,
        lon=request.lon,
        message=request.message,
        contact_numbers=request.contact_numbers,
        user_name=request.user_name,
    )
    return result

@router.get("/sos/history")
async def sos_history():
    """Get recent SOS events."""
    return {"history": await get_sos_history()}

# ── Incident Reporting ────────────────────────────────────────────────────────
@router.post("/incidents")
async def create_incident(request: IncidentRequest):
    """Report a new disaster/emergency incident."""
    incident = await report_incident(
        lat=request.lat,
        lon=request.lon,
        disaster_type=request.disaster_type,
        description=request.description,
        severity=request.severity,
        reporter_name=request.reporter_name,
        image_url=request.image_url,
    )
    return incident

@router.get("/incidents")
async def list_incidents(lat: Optional[float] = None, lon: Optional[float] = None, radius: float = 50):
    """List recent incidents, optionally filtered by location."""
    if lat is not None and lon is not None:
        return {"incidents": await get_nearby_incidents(lat, lon, radius)}
    return {"incidents": await get_all_incidents()}

@router.post("/incidents/{incident_id}/upvote")
async def upvote(incident_id: str):
    """Upvote an incident to increase credibility."""
    return await upvote_incident(incident_id)
