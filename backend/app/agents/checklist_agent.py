from g4f.client import AsyncClient
import os
import json

client = AsyncClient()

async def generate_checklist(disaster_type: str, language: str = "en") -> list:
    """
    Generates a disaster-specific emergency checklist.
    """
    prompt = f"Generate a 5-item emergency kit checklist for a '{disaster_type}'. Language: {language}. Output ONLY a JSON array of strings."
    
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a disaster preparedness expert. Output ONLY a valid JSON array."},
                {"role": "user", "content": prompt}
            ]
        )
        content = response.choices[0].message.content
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            content = content.split("```")[1].split("```")[0]
            
        data = json.loads(content.strip())
        if isinstance(data, dict):
            return data.get("checklist", [])
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"Checklist Error: {e}")
        return ["Water", "Flashlight", "First aid kit", "Batteries", "Non-perishable food"]
