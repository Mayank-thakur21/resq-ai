"""SOS endpoints: ``POST /api/sos`` and ``GET /api/sos/history``; SMS result models."""

from __future__ import annotations

import re
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import APIModel, Latitude, Longitude

#: E.164: "+", country code not starting with 0, 7..15 digits in total.
E164_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")
#: Characters removed before validating a phone number ("+91 98765-43210" -> "+919876543210").
_PHONE_SEPARATORS = re.compile(r"[\s\-().]")

MAX_SOS_CONTACTS = 10
DEFAULT_SOS_MESSAGE = "SOS! I need help!"
MAX_SMS_BODY_CHARS = 320


def normalize_e164(raw: str) -> str:
    """Strip separators and validate E.164.

    Raises:
        ValueError: when the result is not a valid E.164 number.
    """
    candidate = _PHONE_SEPARATORS.sub("", str(raw or ""))
    if candidate.startswith("00"):  # international "00" prefix -> "+"
        candidate = "+" + candidate[2:]
    if not E164_PATTERN.match(candidate):
        raise ValueError("phone numbers must be in international E.164 format, e.g. +919876543210")
    return candidate


class SOSRequest(APIModel):
    lat: Latitude
    lon: Longitude
    accuracy_m: float | None = Field(default=None, ge=0, le=100_000)
    message: str = Field(default=DEFAULT_SOS_MESSAGE, min_length=1, max_length=300)
    #: 0..10 numbers; separators stripped, validated as E.164 and de-duplicated (order kept).
    contact_numbers: list[str] = Field(default_factory=list, max_length=MAX_SOS_CONTACTS)
    user_name: str | None = Field(default=None, max_length=80)

    @field_validator("contact_numbers")
    @classmethod
    def _normalise_numbers(cls, numbers: list[str]) -> list[str]:
        result: list[str] = []
        for index, raw in enumerate(numbers):
            try:
                number = normalize_e164(raw)
            except ValueError as exc:
                raise ValueError(f"contact_numbers[{index}]: {exc}") from exc
            if number not in result:
                result.append(number)
        return result

    @field_validator("user_name")
    @classmethod
    def _blank_name_to_none(cls, value: str | None) -> str | None:
        return value or None


class SMSSent(BaseModel):
    #: Masked number (``+91******3210``) — full numbers never leave the SMS service.
    to: str
    sid: str
    status: str


class SMSFailed(BaseModel):
    #: Masked number.
    to: str
    error: str


class SMSResult(BaseModel):
    """Outcome of ``SMSService.send_bulk`` (``configured=False`` => nothing was sent)."""

    configured: bool
    sent: list[SMSSent] = Field(default_factory=list)
    failed: list[SMSFailed] = Field(default_factory=list)


class SOSResponse(BaseModel):
    id: str
    timestamp: datetime
    maps_link: str = Field(examples=["https://maps.google.com/?q=28.6139,77.209"])
    message: str
    sms: SMSResult
    #: ``sms:<numbers>?&body=<urlencoded>`` so the UI can open the native SMS app.
    fallback_sms_uri: str


class SOSHistoryItem(BaseModel):
    id: str
    timestamp: datetime
    lat: float
    lon: float
    message: str
    contacts_count: int
    sms_sent: int
    sms_failed: int


class SOSHistoryResponse(BaseModel):
    events: list[SOSHistoryItem]
