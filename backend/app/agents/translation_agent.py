from g4f.client import AsyncClient
import os

client = AsyncClient()

async def translate_text(text: str, target_language: str) -> str:
    """
    Translates text to the target language.
    """
    if target_language.lower() in ["en", "english"]:
        return text
        
    prompt = f"Translate the following text to {target_language}. Preserve the tone and urgency. Text: '{text}'"
    
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a professional crisis translator."},
                {"role": "user", "content": prompt}
            ]
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"Translation Error: {e}")
        return text
