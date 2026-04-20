"""Environment and configuration utilities."""

import os


def env_flag(name: str, default: bool = True) -> bool:
    """Parse environment boolean flag."""
    val = os.getenv(name, str(default)).lower()
    return val in ("true", "1", "yes", "on")


def env_int(name: str, default: int) -> int:
    """Parse environment integer with fallback to default on error."""
    try:
        return int(os.getenv(name, default))
    except (ValueError, TypeError):
        return default
