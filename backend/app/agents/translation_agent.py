import os
import google.generativeai as genai

genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))

async def translate_text(text: str, target_language: str) -> str:
    """
    Translates text to the target language.
    """
    if target_language.lower() in ["en", "english"]:
        return text
        
    prompt = f"Translate the following text to {target_language}. Preserve the tone and urgency. Text: '{text}'. Output ONLY the translated text."
    
    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = await model.generate_content_async(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"Translation Error: {e}")
        return text
