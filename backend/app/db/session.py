"""Async engine / session factory and the ``get_session`` FastAPI dependency.

The engine is created in the app lifespan (``app.state.engine``) together with an
``async_sessionmaker`` (``app.state.sessionmaker``). Route handlers receive an
``AsyncSession`` through :func:`get_session`; services are responsible for ``commit()``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import Request
from sqlalchemy import Connection, event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

from app.core.config import Settings
from app.db.models import Base

logger = logging.getLogger(__name__)


def _ensure_sqlite_directory(database_url: str) -> None:
    """Create the parent directory of a file-based SQLite database if needed."""
    url = make_url(database_url)
    database = url.database
    if not database or database == ":memory:" or database.startswith("file:"):
        return
    Path(database).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)


def _enable_sqlite_foreign_keys(dbapi_connection: Any, _connection_record: Any) -> None:
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


#: Seconds a request waits for a pooled connection before failing with ``503 service_busy``
#: (SQLAlchemy's default of 30 s is longer than the frontend proxy's 20 s upstream timeout).
POOL_TIMEOUT_SECONDS = 10


def create_engine(settings: Settings) -> AsyncEngine:
    """Create the async engine for ``settings.database_url``.

    SQLite: creates the data directory, enables ``PRAGMA foreign_keys=ON`` on every
    connection and uses a static pool for in-memory databases.

    ``hide_parameters=True``: SQLAlchemy error messages (``StatementError`` and subclasses)
    otherwise embed the bound row values — SOS locations, names and messages, email
    addresses, password hashes — and error handlers log those messages.
    """
    url = settings.database_url
    kwargs: dict[str, Any] = {"hide_parameters": True}
    if settings.is_sqlite:
        _ensure_sqlite_directory(url)
        if ":memory:" in url:
            kwargs["poolclass"] = StaticPool
            kwargs["connect_args"] = {"check_same_thread": False}
        else:
            kwargs["pool_timeout"] = POOL_TIMEOUT_SECONDS
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_timeout"] = POOL_TIMEOUT_SECONDS
    engine = create_async_engine(url, **kwargs)
    if settings.is_sqlite:
        event.listen(engine.sync_engine, "connect", _enable_sqlite_foreign_keys)
    logger.info("Database engine created (%s)", make_url(url).render_as_string(hide_password=True))
    return engine


def create_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Session factory; ``expire_on_commit=False`` so ORM objects stay usable after commit."""
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


#: Columns added after the first release: (table, column, DDL type + default). ``create_all``
#: never alters existing tables, so :func:`init_db` adds these to older databases.
ADDITIVE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("push_subscriptions", "failure_count", "INTEGER NOT NULL DEFAULT 0"),
)


def _add_missing_columns(connection: Connection) -> list[str]:
    """``ALTER TABLE ... ADD COLUMN`` for every :data:`ADDITIVE_COLUMNS` entry that is missing."""
    inspector = inspect(connection)
    tables = set(inspector.get_table_names())
    added: list[str] = []
    for table, column, ddl in ADDITIVE_COLUMNS:
        if table not in tables:
            continue  # created by create_all with every column
        existing = {info["name"] for info in inspector.get_columns(table)}
        if column in existing:
            continue
        # Identifiers come from the constant above (never from input).
        connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        added.append(f"{table}.{column}")
    return added


async def init_db(engine: AsyncEngine) -> None:
    """Create missing tables (``Base.metadata.create_all``) and add newer columns."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        added = await conn.run_sync(_add_missing_columns)
    if added:
        logger.info("Database schema upgraded (added %s)", ", ".join(added))
    logger.info("Database schema ready")


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an ``AsyncSession`` bound to the app's engine.

    Rolls back on any exception raised while the request is handled; always closes.
    """
    sessionmaker: async_sessionmaker[AsyncSession] | None = getattr(
        request.app.state, "sessionmaker", None
    )
    if sessionmaker is None:
        raise RuntimeError("Database is not initialised (app lifespan has not run)")
    async with sessionmaker() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
