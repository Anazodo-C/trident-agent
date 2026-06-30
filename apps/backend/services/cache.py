"""
Lightweight in-memory TTL cache for external API responses.

Design:
  - Dict[str, (value, inserted_at)]
  - get() returns None when entry is older than ttl_seconds
  - set() stores with current timestamp
  - sweep() deletes entries older than max_age_seconds (run hourly)
  - No third-party deps — pure stdlib

Memory ceiling: FX cache stores at most ~20 entries (6 pairs × a few base currencies).
Each entry is a small dict < 1 KB → total < 20 KB even if cleanup lags.
"""

import time
import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

_store: dict[str, tuple[Any, float]] = {}   # key → (value, epoch_seconds)

# How fresh a cached value must be to be returned
DEFAULT_TTL = 15.0          # seconds

# Entries older than this are removed by the hourly sweep
MAX_AGE = 3600.0            # 1 hour


def get(key: str, ttl: float = DEFAULT_TTL) -> Any | None:
    """Return cached value if it exists and is younger than ttl. Otherwise None."""
    entry = _store.get(key)
    if entry is None:
        return None
    value, ts = entry
    if time.monotonic() - ts > ttl:
        return None          # stale — caller should re-fetch
    return value


def set(key: str, value: Any) -> None:
    """Store value with the current timestamp."""
    _store[key] = (value, time.monotonic())


def sweep() -> int:
    """
    Delete entries older than MAX_AGE.
    Returns number of entries removed.
    """
    now = time.monotonic()
    stale = [k for k, (_, ts) in _store.items() if now - ts > MAX_AGE]
    for k in stale:
        del _store[k]
    if stale:
        logger.info(f"[cache] swept {len(stale)} expired entries — {len(_store)} remaining")
    return len(stale)


def stats() -> dict:
    now = time.monotonic()
    return {
        "entries": len(_store),
        "keys": list(_store.keys()),
        "oldest_age_s": round(max((now - ts for _, ts in _store.values()), default=0), 1),
    }


async def start_sweep_task(interval: float = MAX_AGE) -> None:
    """Background coroutine: run sweep() every `interval` seconds (default 1h)."""
    while True:
        await asyncio.sleep(interval)
        try:
            removed = sweep()
            logger.info(f"[cache] hourly sweep: removed {removed} entries, {len(_store)} remain")
        except Exception as e:
            logger.warning(f"[cache] sweep error: {e}")
