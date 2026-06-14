"""Saved views — per-user list presets (Twenty's "views").

CRUD for a member's named list-view presets, scoped to (current user, current
workspace). The `config` blob is opaque to the backend: each list page owns its
shape (filters / sort / visible columns / layout). At most one default per
(user, entity_type) — setting one clears the others.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import SavedView, User
from modules.auth.router import get_current_user, current_org_id

logger = logging.getLogger(__name__)
router = APIRouter()


class SavedViewCreate(BaseModel):
    entity_type: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=1, max_length=120)
    config: dict = Field(default_factory=dict)
    is_default: bool = False


class SavedViewUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    config: Optional[dict] = None
    is_default: Optional[bool] = None


class SavedViewResponse(BaseModel):
    id: int
    entity_type: str
    name: str
    config: dict
    is_default: bool


def _row(v: SavedView) -> dict:
    return {"id": v.id, "entity_type": v.entity_type, "name": v.name,
            "config": v.config or {}, "is_default": bool(v.is_default)}


def _clear_other_defaults(db: Session, user_id: int, org_id: int,
                          entity_type: str, keep_id: Optional[int] = None):
    q = db.query(SavedView).filter(
        SavedView.user_id == user_id, SavedView.org_id == org_id,
        SavedView.entity_type == entity_type, SavedView.is_default == True,  # noqa: E712
    )
    if keep_id is not None:
        q = q.filter(SavedView.id != keep_id)
    for other in q.all():
        other.is_default = False


def _get_owned(db: Session, view_id: int, user: User, org_id: int) -> SavedView:
    """Fetch a view the caller owns, or 404 — never reveals another user's/org's
    view exists."""
    v = db.query(SavedView).filter(
        SavedView.id == view_id, SavedView.user_id == user.id,
        SavedView.org_id == org_id,
    ).first()
    if not v:
        raise HTTPException(status_code=404, detail="View not found")
    return v


@router.get("", response_model=list[SavedViewResponse])
def list_views(entity_type: Optional[str] = Query(default=None),
               db: Session = Depends(get_db),
               current_user: User = Depends(get_current_user),
               org_id: int = Depends(current_org_id)):
    """The caller's saved views, optionally filtered to one entity type.
    Defaults float to the top, then alphabetical."""
    q = db.query(SavedView).filter(
        SavedView.user_id == current_user.id, SavedView.org_id == org_id,
    )
    if entity_type:
        q = q.filter(SavedView.entity_type == entity_type)
    views = q.all()
    views.sort(key=lambda v: (0 if v.is_default else 1, (v.name or "").lower()))
    return [_row(v) for v in views]


@router.post("", response_model=SavedViewResponse, status_code=201)
def create_view(data: SavedViewCreate, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    if data.is_default:
        _clear_other_defaults(db, current_user.id, org_id, data.entity_type)
    v = SavedView(user_id=current_user.id, org_id=org_id,
                  entity_type=data.entity_type, name=data.name.strip(),
                  config=data.config or {}, is_default=data.is_default)
    db.add(v)
    db.commit()
    db.refresh(v)
    return _row(v)


@router.patch("/{view_id}", response_model=SavedViewResponse)
def update_view(view_id: int, data: SavedViewUpdate, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    v = _get_owned(db, view_id, current_user, org_id)
    if data.name is not None:
        v.name = data.name.strip()
    if data.config is not None:
        v.config = data.config
    if data.is_default is not None:
        if data.is_default:
            _clear_other_defaults(db, current_user.id, org_id, v.entity_type, keep_id=v.id)
        v.is_default = data.is_default
    db.commit()
    db.refresh(v)
    return _row(v)


@router.delete("/{view_id}", status_code=204)
def delete_view(view_id: int, db: Session = Depends(get_db),
                current_user: User = Depends(get_current_user),
                org_id: int = Depends(current_org_id)):
    v = _get_owned(db, view_id, current_user, org_id)
    db.delete(v)
    db.commit()
