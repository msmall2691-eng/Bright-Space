import re
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database.db import get_db
from database.models import FieldDefinition

router = APIRouter()


def slugify(name: str) -> str:
    """Convert 'Pet Name' → 'pet_name'"""
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def field_to_dict(f: FieldDefinition) -> dict:
    return {
        "id": f.id,
        "entity_type": f.entity_type,
        "name": f.name,
        "key": f.key,
        "field_type": f.field_type,
        "options": f.options or [],
        "required": f.required,
        "sort_order": f.sort_order,
        "created_at": f.created_at.isoformat() if f.created_at else None,
    }


class FieldCreate(BaseModel):
    entity_type: str              # 'client' | 'job' | 'invoice'
    name: str
    field_type: Optional[str] = "text"
    options: Optional[List[str]] = []
    required: Optional[bool] = False
    sort_order: Optional[int] = 0


class FieldUpdate(BaseModel):
    name: Optional[str] = None
    field_type: Optional[str] = None
    options: Optional[List[str]] = None
    required: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get("")
def list_fields(entity_type: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(FieldDefinition)
    if entity_type:
        q = q.filter(FieldDefinition.entity_type == entity_type)
    return [field_to_dict(f) for f in q.order_by(FieldDefinition.entity_type, FieldDefinition.sort_order, FieldDefinition.name).all()]


@router.post("", status_code=201)
def create_field(data: FieldCreate, db: Session = Depends(get_db)):
    key = slugify(data.name)
    # Ensure key is unique per entity_type
    existing = db.query(FieldDefinition).filter(
        FieldDefinition.entity_type == data.entity_type,
        FieldDefinition.key == key
    ).first()
    if existing:
        # Append id suffix to make unique
        count = db.query(FieldDefinition).filter(FieldDefinition.entity_type == data.entity_type).count()
        key = f"{key}_{count + 1}"

    field = FieldDefinition(
        entity_type=data.entity_type,
        name=data.name,
        key=key,
        field_type=data.field_type or "text",
        options=data.options or [],
        required=data.required or False,
        sort_order=data.sort_order or 0,
    )
    db.add(field)
    db.commit()
    db.refresh(field)
    return field_to_dict(field)


@router.patch("/{field_id}")
def update_field(field_id: int, data: FieldUpdate, db: Session = Depends(get_db)):
    field = db.query(FieldDefinition).filter(FieldDefinition.id == field_id).first()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    for attr in ["name", "field_type", "options", "required", "sort_order"]:
        val = getattr(data, attr)
        if val is not None:
            setattr(field, attr, val)
    db.commit()
    db.refresh(field)
    return field_to_dict(field)


@router.delete("/{field_id}", status_code=204)
def delete_field(field_id: int, db: Session = Depends(get_db)):
    field = db.query(FieldDefinition).filter(FieldDefinition.id == field_id).first()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    db.delete(field)
    db.commit()
