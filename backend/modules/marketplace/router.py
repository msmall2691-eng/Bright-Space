"""The Marketplace hub — one read, no writes.

Deliberately read-only. Every action this page surfaces already has a home
that owns it: approving an applicant lives in `modules/apply`, answering a
claim request in `modules/scheduling`, paying in `modules/payroll`. A hub that
also acted would put a second implementation of "a sub requests, the office
never assigns" in the codebase, and that rule is worker classification, not
convenience (brightbase-marketplace, Rule 0).

So this router has exactly one GET, and the page links out for everything else.
"""
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.db import get_db
from modules.auth.router import current_org_id, require_role, resolve_org_id

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", dependencies=[Depends(require_role("admin", "manager"))])
def overview(db: Session = Depends(get_db),
             org_id: int = Depends(current_org_id)):
    """Everything the Marketplace page draws, in ONE request.

    Office roles only. The bench, who is waiting on an answer, and what is
    owed are all internal operating facts — a cleaner sees their own side of
    this on My Day, built from `/api/crew/*` with its own scoping.
    """
    from services import marketplace_overview

    return marketplace_overview.build(db, resolve_org_id(org_id, db))
