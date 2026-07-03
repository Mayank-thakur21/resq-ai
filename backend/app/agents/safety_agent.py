from g4f.client import AsyncClient
import os

client = AsyncClient()

async def get_safety_instructions(disaster_type: str, location: dict = None) -> str:
    """
    Generates immediate safety instructions for a given disaster type.
    """
    prompt = f"Provide 3-5 critical, immediate safety instructions for a {disaster_type}."
    if location:
        prompt += f" Consider the general geographic context if applicable (Latitude: {location.get('lat')}, Longitude: {location.get('lon')})."
        
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a crisis response expert. Keep instructions brief, clear, and actionable. Use bullet points."},
                {"role": "user", "content": prompt}
            ]
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"Safety Agent Error: {e}")
        return "Stay calm. Follow local authority instructions. Move to safety if possible."
