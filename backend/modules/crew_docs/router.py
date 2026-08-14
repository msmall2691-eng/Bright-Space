"""Crew training/docs library — office-side CRUD (crew app Phase 5).

The office writes and curates the library (this router, admin/manager to
write, viewer to read); cleaners read published docs via GET /api/crew/docs
in the crew module. Bodies are plain text rendered as-is on the phone —
deliberately no attachments or rich markup, so the library stays
maintainable by one person.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import CrewDoc, User
from modules.auth.router import get_current_user, require_role, current_org_id, resolve_org_id

log = logging.getLogger("uvicorn.error")
router = APIRouter()

# Fixed vocabulary keeps the Learn tab's grouping sane; "other" is the
# catch-all so an unknown value can't scatter the list.
CATEGORIES = ("training", "how-to", "products", "policy", "safety", "other")
MAX_BODY = 20_000


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _doc_dict(d: CrewDoc) -> dict:
    return {
        "id": d.id,
        "title": d.title,
        "body": d.body or "",
        "url": d.url,
        "category": d.category or "other",
        "pinned": bool(d.pinned),
        "published": bool(d.published),
        "updated_by": d.updated_by,
        "created_at": d.created_at.isoformat() + "Z" if d.created_at else None,
        "updated_at": d.updated_at.isoformat() + "Z" if d.updated_at else None,
    }


class DocBody(BaseModel):
    title: str
    body: str = ""
    url: Optional[str] = None
    category: str = "how-to"
    pinned: bool = False
    published: bool = True


class DocPatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    url: Optional[str] = None
    category: Optional[str] = None
    pinned: Optional[bool] = None
    published: Optional[bool] = None


def _clean_url(url: Optional[str]) -> Optional[str]:
    """Empty -> None; anything kept must be http(s) — a javascript: or data:
    link must never render as a tap target on a phone."""
    if url is None:
        return None
    url = url.strip()[:500]
    if not url:
        return None
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=422, detail="Link must start with http:// or https://")
    return url


def _clean(title: Optional[str], body: Optional[str], category: Optional[str]):
    if title is not None:
        title = title.strip()[:200]
        if not title:
            raise HTTPException(status_code=422, detail="Title is required.")
    if body is not None:
        body = body.replace("\r\n", "\n").strip()[:MAX_BODY]
    if category is not None:
        category = category.strip().lower()
        if category not in CATEGORIES:
            category = "other"
    return title, body, category


@router.get("", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_docs(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Everything, including unpublished drafts — this is the office list."""
    oid = resolve_org_id(org_id, db)
    rows = (db.query(CrewDoc)
            .filter(or_(CrewDoc.org_id == oid, CrewDoc.org_id.is_(None)),
                    # Private notes (owner_user_id set, migration 089) are
                    # the cleaner's own — invisible even to the office.
                    CrewDoc.owner_user_id.is_(None))
            .order_by(CrewDoc.pinned.desc(), CrewDoc.updated_at.desc())
            .all())
    return [_doc_dict(d) for d in rows]


@router.post("")
def create_doc(
    payload: DocBody,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("admin", "manager")),
):
    title, body, category = _clean(payload.title, payload.body, payload.category)
    d = CrewDoc(org_id=resolve_org_id(org_id, db), title=title, body=body,
                url=_clean_url(payload.url),
                category=category, pinned=payload.pinned, published=payload.published,
                updated_by=getattr(current_user, "full_name", None) or current_user.email,
                created_at=_now(), updated_at=_now())
    db.add(d); db.commit(); db.refresh(d)
    return _doc_dict(d)


@router.patch("/{doc_id}")
def update_doc(
    doc_id: int,
    payload: DocPatch,
    db: Session = Depends(get_db),
    org_id: int = Depends(current_org_id),
    current_user: User = Depends(require_role("admin", "manager")),
):
    oid = resolve_org_id(org_id, db)
    d = db.query(CrewDoc).filter(
        CrewDoc.id == doc_id,
        or_(CrewDoc.org_id == oid, CrewDoc.org_id.is_(None)),
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Doc not found.")
    title, body, category = _clean(payload.title, payload.body, payload.category)
    if title is not None:
        d.title = title
    if body is not None:
        d.body = body
    if payload.url is not None:
        d.url = _clean_url(payload.url)
    if category is not None:
        d.category = category
    if payload.pinned is not None:
        d.pinned = payload.pinned
    if payload.published is not None:
        d.published = payload.published
    d.updated_by = getattr(current_user, "full_name", None) or current_user.email
    d.updated_at = _now()
    db.commit(); db.refresh(d)
    return _doc_dict(d)


@router.delete("/{doc_id}", dependencies=[Depends(require_role("admin", "manager"))])
def delete_doc(doc_id: int, db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    oid = resolve_org_id(org_id, db)
    d = db.query(CrewDoc).filter(
        CrewDoc.id == doc_id,
        or_(CrewDoc.org_id == oid, CrewDoc.org_id.is_(None)),
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Doc not found.")
    db.delete(d); db.commit()
    return {"ok": True}
