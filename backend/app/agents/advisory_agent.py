import httpx
from g4f.client import AsyncClient
import os

client = AsyncClient()

async def fetch_weather_alerts(lat: float, lon: float) -> str:
    """
    Fetches weather alerts from Open-Meteo based on latitude and longitude.
    """
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
    
    try:
        async with httpx.AsyncClient() as http_client:
            response = await http_client.get(url)
            data = response.json()
            
            weather = data.get("current_weather", {})
            if weather:
                return f"Current Weather: {weather.get('temperature')}C, Wind Speed: {weather.get('windspeed')} km/h."
            return "No current weather data available."
    except Exception as e:
        print(f"Weather API Error: {e}")
        return "Failed to retrieve weather advisories."

async def summarize_advisory(raw_advisory: str, language: str = "en") -> str:
    """
    Uses AI to summarize the raw advisory data into simple, actionable language.
    """
    prompt = f"Summarize this weather data into a simple safety advisory in {language}:\n\n{raw_advisory}"
    
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a government advisory summarizer. Provide clear, simple language."},
                {"role": "user", "content": prompt}
            ]
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"Summarization Error: {e}")
        return raw_advisory
