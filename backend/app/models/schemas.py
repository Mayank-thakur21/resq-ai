from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    language: Optional[str] = "en"
    location: Optional[Dict[str, float]] = None  # e.g., {"lat": 12.34, "lon": 56.78}

class ChatResponse(BaseModel):
    response: str
    agent_used: str
    urgency_level: Optional[str] = "low"
    detected_disaster: Optional[str] = None
    advisory: Optional[str] = None
    recommended_actions: Optional[List[str]] = None
    emergency_numbers: Optional[List[str]] = None
    steps_taken: Optional[List[str]] = None
    data: Optional[Dict[str, Any]] = None

class ClassifyRequest(BaseModel):
    message: str = Field(..., min_length=1)

class ChecklistRequest(BaseModel):
    disaster_type: str = Field(..., min_length=1)
    language: Optional[str] = "en"

class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1)
    target_language: str = Field(..., min_length=1)
