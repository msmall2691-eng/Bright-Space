"""Sticky notes — a member's Home-dashboard notes, saved to their account.

CRUD scoped to (current user, current workspace) — mirrors modules/views. Notes
follow the person across devices instead of living in one browser. Newest first;
`sort_order` is reserved for a future drag-reorder and is honored when set.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session

from database.db import get_db
from database.models import StickyNote, User
from modules.auth.router import get_current_user, current_org_id

logger = logging.getLogger(__name__)
router = APIRouter()

# The palette the widget offers. An unknown value falls back to 'amber' rather
# than 422-ing, so a future palette addition on the frontend can't hard-fail an
# older backend.
_COLORS = {"amber", "blue", "green", "pink"}


def _color(value: Optional[str]) -> str:
    v = (value or "").strip().lower()
    return v if v in _COLORS else "amber"


class NoteCreate(BaseModel):
    body: str = Field(default="", max_length=4000)
    color: Optional[str] = None


class NoteUpdate(BaseModel):
    body: Optional[str] = Field(default=None, max_length=4000)
    color: Optional[str] = None
    sort_order: Optional[int] = None


class NoteResponse(BaseModel):
    id: int
    body: str
    color: str
    sort_order: int


def _row(n: StickyNote) -> dict:
    return {"id": n.id, "body": n.body or "", "color": n.color or "amber",
            "sort_order": n.sort_order or 0}


def _get_owned(db: Session, note_id: int, user: User, org_id: int) -> StickyNote:
    """A note the caller owns, or 404 — never reveals another user's/org's note."""
    n = db.query(StickyNote).filter(
        StickyNote.id == note_id, StickyNote.user_id == user.id,
        StickyNote.org_id == org_id,
    ).first()
    if not n:
        raise HTTPException(status_code=404, detail="Note not found")
    return n


@router.get("", response_model=list[NoteResponse])
def list_notes(db: Session = Depends(get_db),
               current_user: User = Depends(get_current_user),
               org_id: int = Depends(current_org_id)):
    """The caller's notes: by explicit sort_order first, then newest."""
    notes = db.query(StickyNote).filter(
        StickyNote.user_id == current_user.id, StickyNote.org_id == org_id,
    ).all()
    notes.sort(key=lambda n: (n.sort_order or 0, -(n.id or 0)))
    return [_row(n) for n in notes]


@router.post("", response_model=NoteResponse, status_code=201)
def create_note(data: NoteCreate, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    n = StickyNote(user_id=current_user.id, org_id=org_id,
                   body=data.body or "", color=_color(data.color), sort_order=0)
    db.add(n)
    db.commit()
    db.refresh(n)
    return _row(n)


@router.patch("/{note_id}", response_model=NoteResponse)
def update_note(note_id: int, data: NoteUpdate, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    n = _get_owned(db, note_id, current_user, org_id)
    if data.body is not None:
        n.body = data.body
    if data.color is not None:
        n.color = _color(data.color)
    if data.sort_order is not None:
        n.sort_order = data.sort_order
    db.commit()
    db.refresh(n)
    return _row(n)


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    n = _get_owned(db, note_id, current_user, org_id)
    db.delete(n)
    db.commit()
