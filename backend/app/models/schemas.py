from pydantic import BaseModel
from typing import List, Optional, Dict, Any

class ChatRequest(BaseModel):
    message: str
    language: Optional[str] = "en"
    location: Optional[Dict[str, float]] = None  # e.g., {"lat": 12.34, "lon": 56.78}

class ChatResponse(BaseModel):
    response: str
    agent_used: str
    urgency_level: Optional[str] = "low"
    data: Optional[Dict[str, Any]] = None

class ClassifyRequest(BaseModel):
    message: str

class ChecklistRequest(BaseModel):
    disaster_type: str
    language: Optional[str] = "en"

class TranslateRequest(BaseModel):
    text: str
    target_language: str
