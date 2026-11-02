"""Internal user endpoints (``X-Internal-Key``): ``/api/users/register`` and ``/verify``."""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Pragmatic address check (the frontend validates too); full RFC 5322 is not the goal.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: str) -> str:
    """Trim + lower-case an email address and check its basic shape.

    Raises:
        ValueError: if the address is obviously invalid.
    """
    email = (value or "").strip().lower()
    if len(email) > 254 or not _EMAIL_RE.match(email):
        raise ValueError("invalid email address")
    return email


class _UserModel(BaseModel):
    # No global whitespace stripping: passwords must be used verbatim.
    model_config = ConfigDict(extra="ignore")


class UserRegisterRequest(_UserModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name:
            raise ValueError("name must not be blank")
        return name


class UserVerifyRequest(_UserModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return normalize_email(value)


class UserOut(BaseModel):
    id: str
    email: str
    name: str
