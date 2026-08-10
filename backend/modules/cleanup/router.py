"""
Tidy Up — retroactive data cleanup: find likely-duplicate clients & properties
and data-quality gaps across the existing book of business, and merge duplicates
safely.

BrightBase's intake pipeline dedups *at write time* (normalize.py) so new leads
don't spawn duplicates. This module handles the records that already drifted
apart — a returning customer entered under a typo'd email, the same property
under two clients — which intake-time dedup can't reach. It powers the /cleanup
review page and the board's "Tidy Up" nudge.

`GET  /api/cleanup/scan`          — read-only detection (admin/manager/viewer)
`POST /api/cleanup/clients/merge` — merge a duplicate into a primary (admin/manager)

The merge reassigns every FK that references clients.id (13 tables — kept in
sync with the model), preserves the duplicate's contact info as additional
emails/phones on the primary, back-fills missing primary fields, then deletes
the duplicate. It never runs implicitly — only on an explicit operator confirm.
"""
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import (
    Client, Property, Job, Invoice, Quote, Conversation, Message, Opportunity,
    RecurringSchedule, LeadIntake, ContactEmail, ContactPhone, Activity, User,
)
from modules.auth.router import require_role, current_org_id, resolve_org_id
from utils.contacts import phone_last10, add_contact_email, add_contact_phone
from utils.address import format_address

router = APIRouter()

# Every table with a client_id FK — the complete set the merge must reassign
# before the duplicate can be deleted. Keep in lockstep with the model
# (grep `ForeignKey("clients.id"`); a missing table would orphan rows or fail
# the delete on Postgres' FK constraint.
_CLIENT_FK_MODELS = [
    User, Property, RecurringSchedule, Job, LeadIntake, Invoice,
    Conversation, Message, Opportunity, ContactEmail, ContactPhone,
    Activity, Quote,
]

# Fill-if-missing scalar fields copied from the duplicate onto the primary.
_BACKFILL_FIELDS = (
    "first_name", "last_name", "email", "phone", "address", "city", "state",
    "zip_code", "billing_address", "billing_city", "billing_state",
    "billing_zip", "notes", "source", "source_detail",
)


def _name_key(name) -> str:
    """Loose name key: lowercased, punctuation→space, collapsed."""
    if not name:
        return ""
    return re.sub(r"[^a-z0-9]+", " ", str(name).lower()).strip()


def _addr_key(*parts) -> str:
    """Normalized address key from address/city/state/zip components."""
    joined = format_address(", ".join(p for p in parts if p and str(p).strip()))
    return re.sub(r"\s+", " ", joined.lower()).strip()


class _UF:
    """Tiny union-find over client ids."""
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


@router.get("/scan", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def cleanup_scan(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """Find likely-duplicate clients & properties and data-quality gaps.

    Read-only. Clients cluster when they share a strong signal — same email,
    same phone (last 10 digits), or the same name + ZIP. Properties cluster on
    normalized address. Nothing is changed; the operator reviews and merges."""
    oid = resolve_org_id(org_id, db)
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    clients = db.query(Client).filter(org(Client)).all()

    # --- Cluster clients by strong keys (union-find) ------------------------
    uf = _UF()
    by_email, by_phone, by_namezip = {}, {}, {}
    for c in clients:
        uf.find(c.id)  # ensure present even if singleton
        email = (c.email or "").strip().lower()
        if email:
            by_email.setdefault(email, []).append(c.id)
        tail = phone_last10(c.phone)
        if tail:
            by_phone.setdefault(tail, []).append(c.id)
        nk = _name_key(c.name)
        zip5 = (c.zip_code or "")[:5]
        if nk and zip5:
            by_namezip.setdefault(f"{nk}|{zip5}", []).append(c.id)

    def _union_all(groups):
        for ids in groups.values():
            for other in ids[1:]:
                uf.union(ids[0], other)

    for g in (by_email, by_phone, by_namezip):
        _union_all(g)

    # Reasons per client id (why it matched something).
    reasons = {}
    for key, ids in by_email.items():
        if len(ids) > 1:
            for i in ids:
                reasons.setdefault(i, set()).add("email")
    for key, ids in by_phone.items():
        if len(ids) > 1:
            for i in ids:
                reasons.setdefault(i, set()).add("phone")
    for key, ids in by_namezip.items():
        if len(ids) > 1:
            for i in ids:
                reasons.setdefault(i, set()).add("name + ZIP")

    clusters = {}
    for c in clients:
        root = uf.find(c.id)
        clusters.setdefault(root, []).append(c)
    dup_client_groups = [g for g in clusters.values() if len(g) > 1]

    # Record counts for the clustered clients (bounded → grouped queries).
    clustered_ids = [c.id for g in dup_client_groups for c in g]
    counts = {cid: {"jobs": 0, "invoices": 0, "quotes": 0, "properties": 0} for cid in clustered_ids}
    if clustered_ids:
        for model, key in ((Job, "jobs"), (Invoice, "invoices"), (Quote, "quotes"), (Property, "properties")):
            rows = (
                db.query(model.client_id, func.count(model.id))
                .filter(model.client_id.in_(clustered_ids))
                .group_by(model.client_id)
                .all()
            )
            for cid, n in rows:
                if cid in counts:
                    counts[cid][key] = n

    def _client_card(c):
        cnt = counts.get(c.id, {})
        return {
            "id": c.id,
            "name": c.name or "(no name)",
            "email": c.email or "",
            "phone": c.phone or "",
            "address": format_address(", ".join(p for p in (c.address, c.city, c.state, c.zip_code) if p)),
            "status": c.status or "",
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "records": cnt,
            "record_total": sum(cnt.values()) if cnt else 0,
        }

    duplicate_clients = []
    for g in dup_client_groups:
        cards = [_client_card(c) for c in g]
        # Richest first → a sensible default "primary" for the UI.
        cards.sort(key=lambda x: (x["record_total"], x["id"]), reverse=True)
        why = sorted({r for c in g for r in reasons.get(c.id, set())}) or ["name + ZIP"]
        duplicate_clients.append({
            "key": f"c{g[0].id}",
            "reason": " · ".join(why),
            "clients": cards,
        })
    duplicate_clients.sort(key=lambda grp: sum(c["record_total"] for c in grp["clients"]), reverse=True)

    # --- Duplicate properties (normalized address) --------------------------
    props = db.query(Property).filter(org(Property)).all()
    client_names = {c.id: (c.name or "") for c in clients}
    by_addr = {}
    for p in props:
        k = _addr_key(p.address, p.city, p.state, p.zip_code) or _addr_key(p.name)
        if not k:
            continue
        by_addr.setdefault(k, []).append(p)
    duplicate_properties = []
    for k, group in by_addr.items():
        if len(group) < 2:
            continue
        duplicate_properties.append({
            "key": k,
            "address": format_address(", ".join(x for x in (group[0].address, group[0].city, group[0].state, group[0].zip_code) if x)) or group[0].name,
            "properties": [
                {"id": p.id, "name": p.name or "", "client_id": p.client_id,
                 "client_name": client_names.get(p.client_id, ""),
                 "property_type": p.property_type or ""}
                for p in group
            ],
        })

    # --- Data-quality flags -------------------------------------------------
    def _sample(pred, limit=8):
        out = []
        for c in clients:
            if pred(c):
                out.append({"id": c.id, "name": c.name or "(no name)"})
                if len(out) >= limit:
                    break
        return out

    prop_client_ids = {p.client_id for p in props}
    no_contact = [c for c in clients if not (c.email or "").strip() and not phone_last10(c.phone)]
    no_property = [c for c in clients if (c.status == "active") and c.id not in prop_client_ids]

    quality = {
        "no_contact": {"count": len(no_contact),
                       "samples": [{"id": c.id, "name": c.name or "(no name)"} for c in no_contact[:8]]},
        "no_property": {"count": len(no_property),
                        "samples": [{"id": c.id, "name": c.name or "(no name)"} for c in no_property[:8]]},
    }

    return {
        "scanned": {"clients": len(clients), "properties": len(props)},
        "summary": {
            "duplicate_client_groups": len(duplicate_clients),
            "duplicate_property_groups": len(duplicate_properties),
            "quality_flags": quality["no_contact"]["count"] + quality["no_property"]["count"],
        },
        "duplicate_clients": duplicate_clients,
        "duplicate_properties": duplicate_properties,
        "quality": quality,
    }


class MergeClientsBody(BaseModel):
    primary_id: int
    duplicate_id: int


@router.post("/clients/merge", dependencies=[Depends(require_role("admin", "manager"))])
def merge_clients(body: MergeClientsBody, db: Session = Depends(get_db),
                  org_id: int = Depends(current_org_id)):
    """Merge `duplicate_id` into `primary_id`: reassign every client-scoped
    record to the primary, keep the duplicate's contact info as additional
    emails/phones, back-fill missing primary fields, then delete the duplicate.

    Hard to undo — the caller (the /cleanup review page) confirms first."""
    if body.primary_id == body.duplicate_id:
        raise HTTPException(400, "primary and duplicate are the same client")

    oid = resolve_org_id(org_id, db)
    org = lambda model: or_(model.org_id == oid, model.org_id.is_(None))

    primary = db.query(Client).filter(org(Client), Client.id == body.primary_id).first()
    dup = db.query(Client).filter(org(Client), Client.id == body.duplicate_id).first()
    if not primary or not dup:
        raise HTTPException(404, "client not found in this workspace")

    # Preserve the duplicate's primary contact points as additional values.
    if (dup.email or "").strip().lower() != (primary.email or "").strip().lower():
        add_contact_email(db, primary, dup.email, source="merge")
    if phone_last10(dup.phone) and phone_last10(dup.phone) != phone_last10(primary.phone):
        add_contact_phone(db, primary, dup.phone, source="merge")

    # Reassign every client-scoped record to the primary.
    moved = {}
    for model in _CLIENT_FK_MODELS:
        n = (
            db.query(model)
            .filter(model.client_id == dup.id)
            .update({model.client_id: primary.id}, synchronize_session=False)
        )
        if n:
            moved[model.__tablename__] = n

    # Back-fill missing scalar fields from the duplicate.
    for field in _BACKFILL_FIELDS:
        if not (getattr(primary, field, None) or "") and getattr(dup, field, None):
            setattr(primary, field, getattr(dup, field))
    primary.updated_at = datetime.now(timezone.utc)

    # Delete the (now childless) duplicate directly — no ORM cascade surprises.
    db.flush()
    db.query(Client).filter(Client.id == dup.id).delete(synchronize_session=False)
    db.commit()
    db.refresh(primary)

    return {
        "merged_into": {"id": primary.id, "name": primary.name},
        "removed": body.duplicate_id,
        "moved": moved,
    }
