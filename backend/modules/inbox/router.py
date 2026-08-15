"""Inbox triage endpoints — list/dismiss the automated-email cards behind the
board's "Systems & Subscriptions" and "Safe to Ignore" sections.

Rows are captured + classified by services/inbox_triage during the Gmail sync.
These endpoints only let an operator clear them off the board (dismiss stamps
dismissed_at — the raw email in Gmail is never touched) and list what's pending.

Writes are admin/manager/member (require_role auto-includes member), matching the
capability the board's one-click actions require; a viewer sees the board's
triage cards but the dismiss action is stripped server-side.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import InboxTriageItem, UserGoogleAccount
from modules.auth.router import require_role, current_org_id, resolve_org_id

logger = logging.getLogger(__name__)

router = APIRouter()

# How many emails a single "delete all" will attempt to move to Gmail Trash.
# The board tombstone is applied to every matching row regardless (cheap); the
# Gmail API calls are per-message, so bound them so one click can't hang.
_DELETE_ALL_TRASH_CAP = 60


def _account_for(db: Session, row: InboxTriageItem) -> Optional[UserGoogleAccount]:
    if not row.source_account_id:
        return None
    return db.query(UserGoogleAccount).filter(UserGoogleAccount.id == row.source_account_id).first()


def _trash_in_gmail(db: Session, row: InboxTriageItem):
    """Best-effort: move the triaged email to Gmail Trash via the account that
    synced it. Returns (trashed: bool, reason: str|None). Never raises — a
    failure just means the board tombstone still applies and we say why Gmail
    wasn't touched (usually: reconnect Google to grant delete permission)."""
    if not row.external_id:
        return False, "no message id on record"
    acct = _account_for(db, row)
    if acct is None:
        return False, "synced from the shared inbox — no connected account to delete from"
    from integrations.gmail_api import has_gmail_modify, trash_by_rfc822
    if not has_gmail_modify(acct.scopes):
        return False, "reconnect Google to grant delete permission"
    try:
        from integrations.google_accounts import account_credentials, AccountCredentialsError
        try:
            creds = account_credentials(db, acct)
        except AccountCredentialsError:
            return False, "reconnect Google (access expired)"
        ok = trash_by_rfc822(creds, row.external_id)
        return (True, None) if ok else (False, "message not found in Gmail")
    except Exception as e:  # network / API / scope error — degrade to board-only
        logger.warning("[inbox] gmail trash failed for triage %s: %s", row.id, e)
        return False, "Gmail delete failed — cleared from the board only"


def _untrash_in_gmail(db: Session, row: InboxTriageItem) -> bool:
    """Best-effort restore of a previously trashed email from Gmail Trash."""
    acct = _account_for(db, row)
    if acct is None or not row.external_id:
        return False
    from integrations.gmail_api import has_gmail_modify, untrash_by_rfc822
    if not has_gmail_modify(acct.scopes):
        return False
    try:
        from integrations.google_accounts import account_credentials
        creds = account_credentials(db, acct)
        return untrash_by_rfc822(creds, row.external_id)
    except Exception as e:
        logger.warning("[inbox] gmail untrash failed for triage %s: %s", row.id, e)
        return False


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


@router.post("/triage/{item_id}/delete", dependencies=[Depends(require_role("admin", "manager"))])
def delete_triage(item_id: int, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    """Really delete a triaged email: move it to Gmail Trash (when the account
    granted delete permission) AND tombstone it on the board so it never
    resurfaces. Always clears the card; `gmail_trashed` says whether the real
    email was removed, `reason` explains any fallback to board-only."""
    oid = resolve_org_id(org_id, db)
    row = db.query(InboxTriageItem).filter(_org(oid), InboxTriageItem.id == item_id).first()
    if not row:
        raise HTTPException(404, "triage item not found in this workspace")
    trashed, reason = _trash_in_gmail(db, row)
    if trashed:
        row.gmail_trashed = True
    if row.dismissed_at is None:
        row.dismissed_at = datetime.now(timezone.utc)
    db.commit()
    return {"id": item_id, "deleted": True, "gmail_trashed": bool(trashed), "reason": reason}


@router.post("/triage/{item_id}/undo", dependencies=[Depends(require_role("admin", "manager"))])
def undo_triage(item_id: int, db: Session = Depends(get_db),
                org_id: int = Depends(current_org_id)):
    """Undo a dismiss/delete: restore the card to the board and, if the email was
    trashed in Gmail, pull it back out of Trash."""
    oid = resolve_org_id(org_id, db)
    row = db.query(InboxTriageItem).filter(_org(oid), InboxTriageItem.id == item_id).first()
    if not row:
        raise HTTPException(404, "triage item not found in this workspace")
    gmail_restored = False
    if row.gmail_trashed and _untrash_in_gmail(db, row):
        row.gmail_trashed = False
        gmail_restored = True
    row.dismissed_at = None
    db.commit()
    return {"id": item_id, "restored": True, "gmail_restored": gmail_restored}


@router.post("/triage/delete-all", dependencies=[Depends(require_role("admin", "manager"))])
def delete_all_triage(section: Optional[str] = Query(None),
                      db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Delete every pending triage card (optionally just one section) at once:
    tombstone all of them on the board, and move as many as possible to Gmail
    Trash (bounded so one click can't hang). Returns how many were cleared and
    how many actually left Gmail."""
    oid = resolve_org_id(org_id, db)
    q = db.query(InboxTriageItem).filter(_org(oid), InboxTriageItem.dismissed_at.is_(None))
    if section in ("systems", "safe_to_ignore"):
        q = q.filter(InboxTriageItem.section == section)
    rows = q.order_by(InboxTriageItem.received_at.desc().nullslast()).all()
    now = datetime.now(timezone.utc)
    trashed = 0
    for i, row in enumerate(rows):
        if i < _DELETE_ALL_TRASH_CAP:
            ok, _ = _trash_in_gmail(db, row)
            if ok:
                row.gmail_trashed = True
                trashed += 1
        row.dismissed_at = now
    db.commit()
    return {"deleted": len(rows), "gmail_trashed": trashed,
            "trash_capped": len(rows) > _DELETE_ALL_TRASH_CAP}
