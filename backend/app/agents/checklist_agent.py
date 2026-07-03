from openai import AsyncOpenAI
import os
import json

client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

async def generate_checklist(disaster_type: str, language: str = "en") -> list:
    """
    Generates a disaster-specific emergency checklist.
    """
    prompt = f"Generate a 5-item emergency kit checklist for a '{disaster_type}'. Language: {language}. Output as a JSON object with a key 'checklist' containing a list of strings."
    
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a disaster preparedness expert. Output ONLY a valid JSON object."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.2
        )
        data = json.loads(response.choices[0].message.content)
        return data.get("checklist", [])
    except Exception as e:
        print(f"Checklist Error: {e}")
        return ["Water", "Flashlight", "First aid kit", "Batteries", "Non-perishable food"]
