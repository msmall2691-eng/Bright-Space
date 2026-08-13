from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import User
from modules.auth.router import require_role, current_org_id, resolve_org_id

router = APIRouter()


@router.get("/employees", dependencies=[Depends(require_role("admin", "manager", "viewer"))])
def list_employees(db: Session = Depends(get_db), org_id: int = Depends(current_org_id)):
    """The crew roster for assignment UIs (Schedule, dispatch board, job
    create/edit, dashboard workload tile).

    Native as of the Connecteam removal: this reads our own users table —
    cleaner-role accounts managed on the /crew page — never Connecteam. `id` is
    the user's crew ID (User.cleaner_id), because that's the value assignment
    writes into Job.cleaner_ids and the value My Day matches against; rows
    without a crew ID are omitted (nothing valid to assign). The add-crew flow
    auto-issues a crew ID, so in practice that's only legacy rows.

    Gated to internal roles: the roster is staff PII (names, emails) and must
    not be reachable by cleaner/client logins. Before this, only the global
    API-key/JWT middleware gated it, so ANY authenticated principal could pull
    the full roster (docs/audit-2026-04-23.md §6).
    """
    oid = resolve_org_id(org_id, db)
    rows = (
        db.query(User)
        .filter(
            User.role == "cleaner",
            User.active == True,  # noqa: E712 — deactivated crew drop out of assignment
            or_(User.org_id == oid, User.org_id.is_(None)),
            User.cleaner_id.isnot(None),
        )
        .all()
    )
    out = [
        {
            "id": u.cleaner_id,
            "name": u.full_name or u.email,
            # Extra context the admin UIs may use; harmless to older callers,
            # which normalize down to {id, name}.
            "user_id": u.id,
            "email": u.email,
            "activated": bool(u.password_hash) or u.last_login_at is not None,
        }
        for u in rows
        if (u.status or "active") != "disabled" and (u.cleaner_id or "").strip()
    ]
    out.sort(key=lambda r: (r["name"] or "").lower())
    return out
