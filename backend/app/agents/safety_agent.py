import os
import google.generativeai as genai

genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))

async def get_safety_instructions(disaster_type: str, location: dict = None) -> str:
    """
    Generates immediate safety instructions for a given disaster type.
    """
    prompt = f"Provide 3-5 critical, immediate safety instructions for a {disaster_type}."
    if location:
        prompt += f" Consider the general geographic context if applicable (Latitude: {location.get('lat')}, Longitude: {location.get('lon')})."
        
    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = await model.generate_content_async(
            prompt,
            system_instruction="You are a crisis response expert. Keep instructions brief, clear, and actionable. Use bullet points."
        )
        return response.text
    except Exception as e:
        print(f"Safety Agent Error: {e}")
        return "Stay calm. Follow local authority instructions. Move to safety if possible."
