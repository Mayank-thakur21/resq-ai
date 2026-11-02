"""SQLAlchemy 2.x ORM models (typed ``Mapped[]`` columns, string UUID primary keys).

All timestamps are timezone-aware UTC. :class:`UTCDateTime` guarantees that even on SQLite
(which has no native timezone support) values are written as UTC and read back as aware
``datetime`` objects.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

DEFAULT_PUSH_TOPICS = "incidents,disasters"


def utcnow() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(UTC)


def new_uuid() -> str:
    """Random UUID4 as a 36-char string (primary keys)."""
    return str(uuid.uuid4())


class UTCDateTime(TypeDecorator[datetime]):
    """``DateTime(timezone=True)`` that always stores UTC and returns aware datetimes."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            # Treat naive values as UTC (never local time).
            value = value.replace(tzinfo=UTC)
        value = value.astimezone(UTC)
        if dialect.name == "sqlite":
            # SQLite stores text; keep it naive-UTC so string ordering == time ordering.
            return value.replace(tzinfo=None)
        return value

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, str):  # pragma: no cover - defensive (raw SQL results)
            value = datetime.fromisoformat(value)
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    """Declarative base for all ResQ models."""


class User(Base):
    """Email/password account (OAuth users live only in the frontend session)."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # Always stored lower-cased (normalised by services.users).
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def __repr__(self) -> str:
        return f"User(id={self.id!r})"


class Incident(Base):
    """Community-reported incident."""

    __tablename__ = "incidents"
    __table_args__ = (
        Index("ix_incidents_lat_lon", "lat", "lon"),
        Index("ix_incidents_created_at", "created_at"),
        Index("ix_incidents_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    disaster_type: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16))
    description: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(500), default=None)
    status: Mapped[str] = mapped_column(String(16), default="open")
    reporter_id: Mapped[str] = mapped_column(String(128), index=True)
    reporter_name: Mapped[str] = mapped_column(String(80))
    upvotes: Mapped[int] = mapped_column(Integer, default=0)

    votes: Mapped[list[IncidentVote]] = relationship(
        back_populates="incident",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"Incident(id={self.id!r}, type={self.disaster_type!r}, status={self.status!r})"


class IncidentVote(Base):
    """One upvote per (incident, user) — makes upvoting idempotent."""

    __tablename__ = "incident_votes"
    __table_args__ = (UniqueConstraint("incident_id", "user_id", name="uq_incident_vote_user"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    incident_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("incidents.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    incident: Mapped[Incident] = relationship(back_populates="votes")


class SOSEvent(Base):
    """Audit record of an SOS trigger (phone numbers are never stored, only counts)."""

    __tablename__ = "sos_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    user_id: Mapped[str | None] = mapped_column(String(128), default=None, index=True)
    user_name: Mapped[str] = mapped_column(String(80), default="Anonymous")
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    accuracy_m: Mapped[float | None] = mapped_column(Float, default=None)
    message: Mapped[str] = mapped_column(String(300))
    contacts_count: Mapped[int] = mapped_column(Integer, default=0)
    sms_sent: Mapped[int] = mapped_column(Integer, default=0)
    sms_failed: Mapped[int] = mapped_column(Integer, default=0)
    # Keyed hash of the client IP (core.security.hash_identifier) — abuse analysis without PII.
    client_ip_hash: Mapped[str | None] = mapped_column(String(64), default=None)


class PushSubscription(Base):
    """Browser Web Push subscription (upserted by endpoint)."""

    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)
    endpoint: Mapped[str] = mapped_column(String(2048), unique=True)
    p256dh: Mapped[str] = mapped_column(String(512))
    auth: Mapped[str] = mapped_column(String(256))
    user_id: Mapped[str | None] = mapped_column(String(128), default=None, index=True)
    lat: Mapped[float | None] = mapped_column(Float, default=None)
    lon: Mapped[float | None] = mapped_column(Float, default=None)
    radius_km: Mapped[float] = mapped_column(Float, default=50.0)
    # Comma-separated topic names, e.g. "incidents,disasters".
    topics: Mapped[str] = mapped_column(String(128), default=DEFAULT_PUSH_TOPICS)
    # Consecutive failed deliveries (not 404/410); the row is deleted after
    # services.push.MAX_CONSECUTIVE_FAILURES and reset to 0 by any success or re-subscribe.
    failure_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    @property
    def topic_list(self) -> list[str]:
        """Topics as a list (``"incidents,disasters"`` -> ``["incidents", "disasters"]``)."""
        return [t.strip() for t in (self.topics or "").split(",") if t.strip()]

    @property
    def has_location(self) -> bool:
        return self.lat is not None and self.lon is not None

    def subscription_info(self) -> dict[str, Any]:
        """Shape expected by ``pywebpush.webpush(subscription_info=...)``."""
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": self.auth}}


class NotifiedEvent(Base):
    """De-duplication record for the alert poller (one push fan-out per upstream event)."""

    __tablename__ = "notified_events"
    __table_args__ = (UniqueConstraint("source", "event_id", name="uq_notified_source_event"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    source: Mapped[str] = mapped_column(String(32))
    event_id: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


__all__ = [
    "DEFAULT_PUSH_TOPICS",
    "Base",
    "Incident",
    "IncidentVote",
    "NotifiedEvent",
    "PushSubscription",
    "SOSEvent",
    "UTCDateTime",
    "User",
    "new_uuid",
    "utcnow",
]
