import os
import json
import google.generativeai as genai

genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))

async def generate_checklist(disaster_type: str, language: str = "en") -> list:
    """
    Generates a disaster-specific emergency checklist.
    """
    prompt = f"Generate a 5-item emergency kit checklist for a '{disaster_type}'. Language: {language}. Output ONLY a JSON array of strings, for example: [\"Item 1\", \"Item 2\"]."
    
    try:
        model = genai.GenerativeModel('gemini-1.5-flash', generation_config={"response_mime_type": "application/json"})
        response = await model.generate_content_async(prompt)
        content = response.text
        
        data = json.loads(content.strip())
        if isinstance(data, dict):
            return data.get("checklist", [])
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"Checklist Error: {e}")
        return ["Water", "Flashlight", "First aid kit", "Batteries", "Non-perishable food"]
