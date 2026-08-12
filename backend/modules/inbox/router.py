"""Inbox triage endpoints — list/dismiss the automated-email cards behind the
board's "Systems & Subscriptions" and "Safe to Ignore" sections.

Rows are captured + classified by services/inbox_triage during the Gmail sync.
These endpoints only let an operator clear them off the board (dismiss stamps
dismissed_at — the raw email in Gmail is never touched) and list what's pending.

Writes are admin/manager/member (require_role auto-includes member), matching the
capability the board's one-click actions require; a viewer sees the board's
triage cards but the dismiss action is stripped server-side.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import InboxTriageItem
from modules.auth.router import require_role, current_org_id, resolve_org_id

router = APIRouter()


def _org(oid: int):
    # Tolerate legacy NULL-org rows (shared inbox), same predicate as the board.
    return or_(InboxTriageItem.org_id == oid, InboxTriageItem.org_id.is_(None))


def _triage_dict(r: InboxTriageItem) -> dict:
    return {
        "id": r.id,
        "from_addr": r.from_addr,
        "from_name": r.from_name,
        "subject": r.subject,
        "snippet": r.snippet,
        "received_at": (r.received_at.isoformat() + "Z") if r.received_at else None,
        "category": r.category,
        "section": r.section,
        "vendor": r.vendor,
        "unsubscribe_url": r.unsubscribe_url,
        "classified_by": r.classified_by,
        "is_read": r.is_read,
        "dismissed": r.dismissed_at is not None,
    }


@router.get("/triage", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_triage(section: Optional[str] = Query(None),
                include_dismissed: bool = Query(False),
                db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Pending triage items for this workspace (newest first). Optionally filter
    to one board section; dismissed rows are hidden unless include_dismissed."""
    oid = resolve_org_id(org_id, db)
    q = db.query(InboxTriageItem).filter(_org(oid))
    if not include_dismissed:
        q = q.filter(InboxTriageItem.dismissed_at.is_(None))
    if section in ("systems", "safe_to_ignore"):
        q = q.filter(InboxTriageItem.section == section)
    rows = (
        q.order_by(InboxTriageItem.received_at.desc().nullslast(), InboxTriageItem.id.desc())
        .limit(200)
        .all()
    )
    return {"items": [_triage_dict(r) for r in rows], "count": len(rows)}


@router.post("/triage/{item_id}/dismiss", dependencies=[Depends(require_role("admin", "manager"))])
def dismiss_triage(item_id: int, db: Session = Depends(get_db),
                   org_id: int = Depends(current_org_id)):
    """Clear one triage card off the board (idempotent). Does not touch Gmail."""
    oid = resolve_org_id(org_id, db)
    row = db.query(InboxTriageItem).filter(_org(oid), InboxTriageItem.id == item_id).first()
    if not row:
        raise HTTPException(404, "triage item not found in this workspace")
    if row.dismissed_at is None:
        row.dismissed_at = datetime.now(timezone.utc)
        db.commit()
    return {"id": item_id, "dismissed": True}


@router.post("/triage/dismiss-all", dependencies=[Depends(require_role("admin", "manager"))])
def dismiss_all_triage(section: Optional[str] = Query(None),
                       db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Clear every pending triage card (optionally just one section) at once."""
    oid = resolve_org_id(org_id, db)
    q = db.query(InboxTriageItem).filter(_org(oid), InboxTriageItem.dismissed_at.is_(None))
    if section in ("systems", "safe_to_ignore"):
        q = q.filter(InboxTriageItem.section == section)
    n = q.update({InboxTriageItem.dismissed_at: datetime.now(timezone.utc)},
                 synchronize_session=False)
    db.commit()
    return {"dismissed": n}
