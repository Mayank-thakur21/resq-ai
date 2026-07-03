from fastapi import APIRouter, HTTPException
from app.models.schemas import (
    ChatRequest, ChatResponse, ClassifyRequest, 
    ChecklistRequest, TranslateRequest
)
from app.agents.router_agent import process_chat, classify_disaster
from app.agents.mapping_agent import get_nearby_hospitals, get_nearby_shelters
from app.agents.advisory_agent import fetch_weather_alerts, summarize_advisory
from app.agents.checklist_agent import generate_checklist
from app.agents.translation_agent import translate_text

router = APIRouter()

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    result = await process_chat(request.message, request.language, request.location)
    return ChatResponse(
        response=result["response"],
        agent_used=result["agent_used"],
        urgency_level=result["urgency_level"],
        data=result["data"]
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
