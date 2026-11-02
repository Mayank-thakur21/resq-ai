"""
weather_agent.py — Real weather & disaster alerts via OpenWeatherMap API
Falls back to mock data if API key not set.
"""
import os
import httpx
import logging
from typing import Optional

logger = logging.getLogger("weather_agent")

OWM_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OWM_BASE = "https://api.openweathermap.org/data/2.5"
OWM_ALERTS = "https://api.openweathermap.org/data/3.0/onecall"


async def get_current_weather(lat: float, lon: float) -> dict:
    """Fetch real current weather from OpenWeatherMap."""
    if not OWM_API_KEY:
        logger.warning("OPENWEATHER_API_KEY not set — returning mock weather")
        return _mock_weather(lat, lon)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{OWM_BASE}/weather",
                params={"lat": lat, "lon": lon, "appid": OWM_API_KEY, "units": "metric"}
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                "temperature": round(data["main"]["temp"], 1),
                "feels_like": round(data["main"]["feels_like"], 1),
                "humidity": data["main"]["humidity"],
                "wind_speed": round(data["wind"]["speed"] * 3.6, 1),  # m/s to km/h
                "description": data["weather"][0]["description"].title(),
                "city": data.get("name", "Unknown"),
                "country": data.get("sys", {}).get("country", ""),
                "icon": data["weather"][0]["icon"],
                "source": "openweathermap",
            }
    except Exception as e:
        logger.error(f"Weather API error: {e}")
        return _mock_weather(lat, lon)


async def get_disaster_alerts(lat: float, lon: float) -> list:
    """Fetch weather alerts/warnings from OpenWeatherMap One Call API."""
    if not OWM_API_KEY:
        return _mock_alerts()

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                OWM_ALERTS,
                params={
                    "lat": lat, "lon": lon,
                    "appid": OWM_API_KEY,
                    "exclude": "minutely,hourly,daily",
                    "units": "metric",
                }
            )
            resp.raise_for_status()
            data = resp.json()
            alerts = data.get("alerts", [])
            return [
                {
                    "event": a.get("event", "Weather Alert"),
                    "description": a.get("description", "")[:300],
                    "sender": a.get("sender_name", "National Weather Service"),
                    "start": a.get("start"),
                    "end": a.get("end"),
                    "severity": _classify_severity(a.get("event", "")),
                }
                for a in alerts
            ]
    except Exception as e:
        logger.error(f"Alerts API error: {e}")
        return _mock_alerts()


def _classify_severity(event: str) -> str:
    event_lower = event.lower()
    if any(w in event_lower for w in ["extreme", "emergency", "warning", "severe"]):
        return "high"
    elif any(w in event_lower for w in ["watch", "advisory", "moderate"]):
        return "medium"
    return "low"


def _mock_weather(lat: float, lon: float) -> dict:
    return {
        "temperature": 32.0,
        "feels_like": 36.0,
        "humidity": 65,
        "wind_speed": 12.0,
        "description": "Partly Cloudy",
        "city": "Demo City",
        "country": "IN",
        "icon": "02d",
        "source": "mock",
        "note": "Set OPENWEATHER_API_KEY for real weather data",
    }


def _mock_alerts() -> list:
    return [
        {
            "event": "Heat Advisory",
            "description": "Temperatures expected to reach 40°C. Stay hydrated and avoid outdoor activity during peak hours.",
            "sender": "Demo Weather Service",
            "severity": "medium",
        }
    ]
