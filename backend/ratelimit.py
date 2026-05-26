"""
BB-OPS-01: rate-limiter instance shared across routers.

Endpoints import `limiter` and decorate handlers with @limiter.limit(...).
The limiter uses in-memory storage by default — fine for Railway's
single-container deploy. If the service ever scales to multiple instances,
switch to Redis: Limiter(key_func=..., storage_uri="redis://...")
"""
import os
from slowapi import Limiter
from slowapi.util import get_remote_address

_storage_uri = os.getenv("RATELIMIT_STORAGE_URI", "memory://")

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_storage_uri,
    default_limits=[],
)
