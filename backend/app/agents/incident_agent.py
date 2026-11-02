"""
incident_agent.py — Community incident reporting system
Users can report disasters/emergencies in their area.
"""
import logging
from datetime import datetime
from typing import Optional
from uuid import uuid4

logger = logging.getLogger("incident_agent")

# In-memory store (replace with DB in production)
incidents = []

DISASTER_TYPES = [
    "flood", "earthquake", "fire", "cyclone", "landslide",
    "drought", "heatwave", "accident", "medical", "other"
]


async def report_incident(
    lat: float,
    lon: float,
    disaster_type: str,
    description: str,
    severity: str = "medium",
    reporter_name: str = "Anonymous",
    image_url: Optional[str] = None,
) -> dict:
    """Submit a new incident report."""
    if disaster_type not in DISASTER_TYPES:
        disaster_type = "other"

    severity = severity if severity in ["low", "medium", "high", "critical"] else "medium"

    incident = {
        "id": str(uuid4())[:8],
        "timestamp": datetime.utcnow().isoformat(),
        "lat": lat,
        "lon": lon,
        "disaster_type": disaster_type,
        "description": description[:500],
        "severity": severity,
        "reporter": reporter_name,
        "image_url": image_url,
        "verified": False,
        "upvotes": 0,
    }
    incidents.append(incident)
    logger.info(f"Incident reported: {disaster_type} at {lat},{lon} by {reporter_name}")
    return incident


async def get_nearby_incidents(lat: float, lon: float, radius_km: float = 50) -> list:
    """Get incidents within radius_km of given coordinates."""
    import math

    def distance(lat1, lon1, lat2, lon2):
        R = 6371
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

    nearby = [
        i for i in incidents
        if distance(lat, lon, i["lat"], i["lon"]) <= radius_km
    ]
    return sorted(nearby, key=lambda x: x["timestamp"], reverse=True)


async def get_all_incidents(limit: int = 50) -> list:
    """Get recent incidents."""
    return sorted(incidents, key=lambda x: x["timestamp"], reverse=True)[:limit]


async def upvote_incident(incident_id: str) -> dict:
    """Upvote an incident to increase its credibility."""
    for incident in incidents:
        if incident["id"] == incident_id:
            incident["upvotes"] += 1
            return incident
    return {"error": "Incident not found"}
