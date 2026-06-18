"""
Tiny dependency-free TTL cache.

A thread-safe in-process key→value store with per-entry expiry, for caching
read-heavy, staleness-tolerant results (e.g. a global health metric hit on every
schedule load). Deliberately minimal — no eviction policy beyond TTL, no LRU.

In-process means each worker keeps its own copy; that's fine for short TTLs on
data that doesn't need to be consistent to the second. Reach for Redis only if a
value must be shared across workers.
"""
import threading
import time


class TTLCache:
    def __init__(self, ttl_seconds: float):
        self.ttl = ttl_seconds
        self._store: dict = {}
        self._lock = threading.Lock()

    def get(self, key):
        """Return the cached value, or None if absent/expired."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, expires_at = entry
            if time.monotonic() >= expires_at:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key, value):
        with self._lock:
            self._store[key] = (value, time.monotonic() + self.ttl)

    def clear(self):
        """Drop everything — used by tests and after known mutations."""
        with self._lock:
            self._store.clear()
