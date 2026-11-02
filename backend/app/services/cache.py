"""Tiny in-process TTL cache with single-flight loading (one instance on ``app.state.cache``).

Used to keep upstream API usage low (weather, GDACS/ReliefWeb feeds, Overpass places).
Not shared between worker processes — good enough for a single-container deployment.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from typing import Any, TypeVar, cast

logger = logging.getLogger(__name__)

T = TypeVar("T")

_MISSING: Any = object()


@dataclass(slots=True)
class _Entry:
    value: Any
    expires_at: float


class TTLCache:
    """Async-safe TTL + LRU cache.

    * ``get_or_set`` runs at most one factory call per key at a time (concurrent callers
      wait for the first one instead of stampeding the upstream API).
    * Exceptions raised by the factory propagate and are **not** cached.
    * When ``max_size`` is exceeded, expired entries are purged first, then the least
      recently used entries are evicted.
    """

    def __init__(self, max_size: int = 1024, *, clock: Callable[[], float] = time.monotonic):
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        self.max_size = max_size
        self._clock = clock
        self._data: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._locks: dict[Hashable, asyncio.Lock] = {}
        self._lock_users: dict[Hashable, int] = {}
        self.hits = 0
        self.misses = 0

    # -- synchronous primitives -------------------------------------------------------------
    def get(self, key: Hashable, default: Any = None) -> Any:
        """Return the cached value or ``default`` if missing/expired."""
        entry = self._data.get(key)
        if entry is None:
            return default
        if entry.expires_at <= self._clock():
            self._data.pop(key, None)
            return default
        self._data.move_to_end(key)
        return entry.value

    def set(self, key: Hashable, value: Any, ttl: float) -> None:
        """Store ``value`` for ``ttl`` seconds (``ttl <= 0`` stores nothing)."""
        if ttl <= 0:
            self._data.pop(key, None)
            return
        self._data[key] = _Entry(value=value, expires_at=self._clock() + ttl)
        self._data.move_to_end(key)
        self._evict()

    def delete(self, key: Hashable) -> None:
        self._data.pop(key, None)

    def clear(self) -> None:
        """Drop everything (tests use this between scenarios)."""
        self._data.clear()
        self.hits = 0
        self.misses = 0

    def __contains__(self, key: object) -> bool:
        return self.get(cast(Hashable, key), _MISSING) is not _MISSING

    def __len__(self) -> int:
        return len(self._data)

    # -- async loader ----------------------------------------------------------------------------
    async def get_or_set(
        self,
        key: Hashable,
        ttl: float | Callable[[T], float],
        factory: Callable[[], Awaitable[T]],
    ) -> T:
        """Return the cached value for ``key`` or compute it with ``await factory()``.

        ``ttl`` may be a function of the computed value (e.g. a shorter lifetime for a
        partial upstream answer).
        """
        value = self.get(key, _MISSING)
        if value is not _MISSING:
            self.hits += 1
            return cast(T, value)

        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        self._lock_users[key] = self._lock_users.get(key, 0) + 1
        try:
            async with lock:
                # Another coroutine may have filled the entry while we waited.
                value = self.get(key, _MISSING)
                if value is not _MISSING:
                    self.hits += 1
                    return cast(T, value)
                self.misses += 1
                result = await factory()
                self.set(key, result, ttl(result) if callable(ttl) else ttl)
                return result
        finally:
            # Drop the per-key lock once nobody is using or waiting for it.
            remaining = self._lock_users.get(key, 1) - 1
            if remaining > 0:
                self._lock_users[key] = remaining
            else:
                self._lock_users.pop(key, None)
                self._locks.pop(key, None)

    # -- internals ---------------------------------------------------------------------------------
    def _evict(self) -> None:
        if len(self._data) <= self.max_size:
            return
        now = self._clock()
        for stale_key in [k for k, e in self._data.items() if e.expires_at <= now]:
            self._data.pop(stale_key, None)
        while len(self._data) > self.max_size:
            evicted, _ = self._data.popitem(last=False)
            logger.debug("Cache evicted key %r", evicted)
