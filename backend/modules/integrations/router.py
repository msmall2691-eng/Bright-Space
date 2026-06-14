"""Public webhook endpoints for inbound integration push notifications.

Currently: Google Calendar events.watch (Audit #4 Upgrade 2B). Google POSTs here
when a watched calendar changes; we authenticate by the channel token (no API key
— Google can't send one), then run an incremental sync for that calendar.
"""
import logging

from fastapi import APIRouter, Request, Depends
from sqlalchemy.orm import Session

from database.db import get_db

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/gcal/notifications")
async def gcal_notification(request: Request, db: Session = Depends(get_db)):
    """Google Calendar push channel callback. Always 200s (a non-2xx makes Google
    retry); authentication + the actual work happen in handle_notification."""
    from integrations.gcal_watch import handle_notification
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        result = handle_notification(db, headers)
    except Exception as e:  # never 500 at Google — it would retry-storm
        logger.warning("[gcal-watch] notification handling failed: %s", e)
        result = {"ok": False, "error": "internal"}
    return result
