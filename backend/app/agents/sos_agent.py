"""
sos_agent.py — SOS alert system
Sends emergency SMS via Twilio (optional) and logs SOS events.
"""
import os
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger("sos_agent")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")

# In-memory SOS log (use a DB in production)
sos_log = []


async def send_sos(
    lat: float,
    lon: float,
    message: str = "SOS! I need help!",
    contact_numbers: Optional[list] = None,
    user_name: str = "Unknown",
) -> dict:
    """Send SOS alert with location to emergency contacts."""
    timestamp = datetime.utcnow().isoformat()
    maps_link = f"https://maps.google.com/?q={lat},{lon}"

    full_message = (
        f"🆘 SOS ALERT from {user_name}\n"
        f"Message: {message}\n"
        f"Location: {maps_link}\n"
        f"Time: {timestamp} UTC"
    )

    results = {
        "timestamp": timestamp,
        "location": {"lat": lat, "lon": lon},
        "maps_link": maps_link,
        "message": message,
        "sms_sent": [],
        "sms_failed": [],
        "twilio_available": bool(TWILIO_ACCOUNT_SID),
    }

    # Send SMS via Twilio if configured
    if TWILIO_ACCOUNT_SID and contact_numbers:
        try:
            from twilio.rest import Client
            client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
            for number in contact_numbers:
                try:
                    msg = client.messages.create(
                        body=full_message,
                        from_=TWILIO_FROM_NUMBER,
                        to=number,
                    )
                    results["sms_sent"].append(number)
                    logger.info(f"SOS SMS sent to {number}: {msg.sid}")
                except Exception as e:
                    results["sms_failed"].append({"number": number, "error": str(e)})
                    logger.error(f"SMS failed for {number}: {e}")
        except ImportError:
            logger.warning("twilio package not installed")
            results["note"] = "Install twilio package for SMS support"
    else:
        results["note"] = "Set TWILIO_* env vars to enable SMS alerts"

    # Log the SOS event
    sos_log.append({
        "timestamp": timestamp,
        "lat": lat,
        "lon": lon,
        "message": message,
        "user": user_name,
        "contacts_notified": len(results["sms_sent"]),
    })

    logger.warning(f"SOS triggered by {user_name} at {lat},{lon}")
    return results


async def get_sos_history() -> list:
    """Return recent SOS events."""
    return sos_log[-20:][::-1]
