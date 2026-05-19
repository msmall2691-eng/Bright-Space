import csv
import io
import logging
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import text
from pydantic import BaseModel

from database.db import get_db
from database.models import (
    Client, Property, PropertyIcal, ICalEvent, RecurringSchedule,
    Job, Visit, LeadIntake, Quote, Invoice, Conversation, Message,
    Opportunity, ContactEmail, ContactPhone, Activity,
)
from modules.auth.router import require_role
from utils.phone import normalize_e164, phone_tail

log = logging.getLogger(__name__)

router = APIRouter()


class ClientImportPreview(BaseModel):
    """Preview of clients to be imported."""
    total_rows: int
    valid_clients: int
    duplicates: List[dict]
    invalid_rows: List[dict]
    clients_to_create: List[dict]


class ClientImportResult(BaseModel):
    """Result of client import."""
    created: int
    updated: int
    skipped: int
    errors: List[str]


def _normalize_phone(phone_str: str) -> Optional[str]:
    """Normalize phone to E.164, handling various input formats."""
    return normalize_e164(phone_str)


@router.post("/import/clients", response_model=dict)
async def import_clients(
    file: UploadFile = File(...),
    dry_run: bool = True,
    db: Session = Depends(get_db)
):
    """
    Import clients from Jobber CSV export.

    Expected CSV columns:
    - Client Name
    - Status
    - Phone
    - Email
    - Created date
    - Tags
    - (other columns are ignored)

    dry_run=true: Return preview without applying changes
    dry_run=false: Apply changes to database
    """
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="File must be CSV format")

    try:
        contents = await file.read()
        csv_text = contents.decode('utf-8')
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {str(e)}")

    # Parse CSV
    csv_file = io.StringIO(csv_text)
    reader = csv.DictReader(csv_file)

    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    clients_data = []
    invalid_rows = []
    duplicates = []
    seen_phones = {}

    for row_num, row in enumerate(reader, start=2):  # start=2 because row 1 is header
        try:
            name = row.get('Client Name', '').strip()
            email = row.get('Email', '').strip() or None
            phone = row.get('Phone', '').strip()
            status = row.get('Status', 'Active').strip().lower()

            # Validate required fields
            if not name:
                invalid_rows.append({'row': row_num, 'error': 'Missing Client Name'})
                continue

            # Normalize phone
            normalized_phone = _normalize_phone(phone) if phone else None

            # Skip internal entries
            if any(skip_word in name for skip_word in ['Unit inventory', 'Team Resources', 'maintenance']):
                invalid_rows.append({'row': row_num, 'error': f'Skipped internal entry: {name}'})
                continue

            # Detect duplicates (by name or phone)
            if normalized_phone:
                if normalized_phone in seen_phones:
                    duplicates.append({
                        'row': row_num,
                        'name': name,
                        'phone': phone,
                        'normalized': normalized_phone,
                        'first_occurrence': seen_phones[normalized_phone]['row']
                    })
                    continue
                seen_phones[normalized_phone] = {'row': row_num, 'name': name}

            clients_data.append({
                'row': row_num,
                'name': name,
                'email': email,
                'phone': normalized_phone,
                'phone_display': phone,
                'status': 'active' if status == 'active' else 'lead',
            })

        except Exception as e:
            invalid_rows.append({'row': row_num, 'error': str(e)})

    # Check for existing clients (by phone or email)
    existing_clients = []
    for client_data in clients_data:
        existing = None

        if client_data['phone']:
            tail = phone_tail(client_data['phone'])
            existing = db.query(Client).filter(Client.phone_tail == tail).first()

        if not existing and client_data['email']:
            existing = db.query(Client).filter(Client.email == client_data['email']).first()

        if existing:
            existing_clients.append({
                'name': client_data['name'],
                # Store normalized phone for matching in apply mode (display version is separate)
                'phone': client_data['phone'],
                'phone_display': client_data['phone_display'],
                'email': client_data['email'],
                'existing_id': existing.id,
                'existing_name': existing.name,
                'existing_phone': existing.phone,
                'existing_email': existing.email,
            })

    # Prepare preview response
    preview = {
        'total_rows': row_num if 'row_num' in locals() else 0,
        'valid_clients': len(clients_data),
        'duplicates_in_csv': len(duplicates),
        'existing_in_db': len(existing_clients),
        # Renamed to avoid duplicate key collision with the detailed list below
        'invalid_count': len(invalid_rows),
        'clients_to_create': len(clients_data) - len(existing_clients),
        'duplicates': duplicates,
        'existing_clients': existing_clients,
        'invalid_rows': invalid_rows,
        'sample_clients': clients_data[:5],  # First 5 for preview
    }

    if dry_run:
        return {'mode': 'dry_run', 'preview': preview}

    # Apply changes: create new clients
    created_count = 0
    skipped_count = len(existing_clients)
    errors = []

    for client_data in clients_data:
        # Skip if already exists in DB (compare normalized phone, not display value)
        if any(ec['phone'] == client_data['phone'] and client_data['phone'] for ec in existing_clients):
            continue
        if any(ec['email'] == client_data['email'] and client_data['email'] for ec in existing_clients):
            continue

        try:
            new_client = Client(
                name=client_data['name'],
                email=client_data['email'],
                phone=client_data['phone'],
                phone_tail=phone_tail(client_data['phone']) if client_data['phone'] else None,
                status=client_data['status'],
            )
            db.add(new_client)
            created_count += 1
        except Exception as e:
            errors.append(f"Failed to create {client_data['name']}: {str(e)}")

    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database commit failed: {str(e)}")

    return {
        'mode': 'apply',
        'result': {
            'created': created_count,
            'skipped': skipped_count,
            'invalid': len(invalid_rows),
            'duplicates_in_csv': len(duplicates),
        },
        'errors': errors,
        'summary': f"Created {created_count} clients, skipped {skipped_count} existing, {len(invalid_rows)} invalid rows",
    }


# ── Reset all transactional data ────────────────────────────────────────────

class ResetDataRequest(BaseModel):
    confirm: str  # must equal "RESET" — typed confirmation


# Order matters: children before parents to satisfy FKs.
# Reference/config tables (users, app_settings, field_definitions) are NOT
# included and remain untouched.
RESET_DELETE_ORDER = [
    Activity,
    ContactEmail,
    ContactPhone,
    Opportunity,
    Invoice,
    Quote,
    Visit,
    Job,
    RecurringSchedule,
    ICalEvent,
    PropertyIcal,
    Property,
    LeadIntake,
    Message,
    Conversation,
    Client,
]


@router.post("/reset-data", dependencies=[Depends(require_role("admin"))])
def reset_data(payload: ResetDataRequest, db: Session = Depends(get_db)):
    """
    DESTRUCTIVE. Deletes all transactional data (clients, properties, jobs,
    visits, quotes, invoices, conversations, messages, leads, opportunities,
    activities, contact emails/phones, recurring schedules, iCal data).

    Preserves: users, app_settings, field_definitions.

    Requires admin role and a typed confirmation token of exactly "RESET" in
    the request body. Runs in a single transaction; rolls back on error.
    """
    if payload.confirm != "RESET":
        raise HTTPException(
            status_code=400,
            detail='Confirmation token must be exactly "RESET"',
        )

    counts = {}
    try:
        for model in RESET_DELETE_ORDER:
            tablename = model.__tablename__
            # bulk delete returns affected row count; synchronize_session=False is
            # safe here because we delete every row and aren't using these objects
            # again in this session.
            n = db.query(model).delete(synchronize_session=False)
            counts[tablename] = n
            log.info("reset-data: deleted %d rows from %s", n, tablename)

        db.commit()
    except Exception as e:
        db.rollback()
        log.exception("reset-data failed")
        raise HTTPException(status_code=500, detail=f"Reset failed: {e}")

    total = sum(counts.values())
    return {
        "ok": True,
        "deleted_total": total,
        "deleted_by_table": counts,
        "preserved": ["users", "app_settings", "field_definitions"],
    }


# ── Unlink calendars: detach jobs/visits from GCal, deactivate iCal feeds ───

class UnlinkCalendarsRequest(BaseModel):
    confirm: str  # must equal "UNLINK"
    clear_gcal: bool = True            # null out gcal_event_id on jobs + visits
    deactivate_ical_feeds: bool = True  # set property_icals.active = false; null out properties.ical_url


@router.post("/unlink-calendars", dependencies=[Depends(require_role("admin"))])
def unlink_calendars(payload: UnlinkCalendarsRequest, db: Session = Depends(get_db)):
    """
    Break the link between BrightBase records and external calendars without
    deleting the records themselves:

    - clear_gcal: null out `jobs.gcal_event_id` and `visits.gcal_event_id` so
      future deletes won't try to also remove events from Google Calendar.
    - deactivate_ical_feeds: set `property_icals.active = false` and null out
      `properties.ical_url` (legacy field) so no new iCal pulls happen.

    Local data (clients, properties, jobs, visits) is preserved.
    """
    if payload.confirm != "UNLINK":
        raise HTTPException(
            status_code=400,
            detail='Confirmation token must be exactly "UNLINK"',
        )

    result = {"jobs_unlinked": 0, "visits_unlinked": 0, "ical_feeds_deactivated": 0, "properties_ical_url_cleared": 0}
    try:
        if payload.clear_gcal:
            n = db.query(Job).filter(Job.gcal_event_id.isnot(None)).update(
                {Job.gcal_event_id: None, Job.calendar_invite_sent: False},
                synchronize_session=False,
            )
            result["jobs_unlinked"] = n
            n = db.query(Visit).filter(Visit.gcal_event_id.isnot(None)).update(
                {Visit.gcal_event_id: None}, synchronize_session=False,
            )
            result["visits_unlinked"] = n

        if payload.deactivate_ical_feeds:
            n = db.query(PropertyIcal).filter(PropertyIcal.active == True).update(
                {PropertyIcal.active: False}, synchronize_session=False,
            )
            result["ical_feeds_deactivated"] = n
            n = db.query(Property).filter(Property.ical_url.isnot(None)).update(
                {Property.ical_url: None}, synchronize_session=False,
            )
            result["properties_ical_url_cleared"] = n

        db.commit()
    except Exception as e:
        db.rollback()
        log.exception("unlink-calendars failed")
        raise HTTPException(status_code=500, detail=f"Unlink failed: {e}")

    log.info("unlink-calendars: %s", result)
    return {"ok": True, **result}


# ── Delete all scheduled visits ─────────────────────────────────────────────

class DeleteScheduledVisitsRequest(BaseModel):
    confirm: str  # must equal "DELETE"
    only_ical: bool = False  # if True, only delete visits sourced from iCal feeds
    include_dispatched: bool = False  # if True, also delete dispatched/en_route/in_progress visits


@router.post("/delete-scheduled-visits", dependencies=[Depends(require_role("admin"))])
def delete_scheduled_visits(payload: DeleteScheduledVisitsRequest, db: Session = Depends(get_db)):
    """
    Bulk-delete scheduled (uncompleted) visits. By default removes only visits
    in `status = 'scheduled'`. Useful after disabling iCal sync to clear out
    auto-generated turnover visits that are no longer wanted.

    - only_ical: restrict deletion to visits where `ical_source` is set
      (i.e. created from an iCal feed).
    - include_dispatched: also delete dispatched/en_route/in_progress visits.
      Completed, no_show, and cancelled visits are always preserved.
    """
    if payload.confirm != "DELETE":
        raise HTTPException(
            status_code=400,
            detail='Confirmation token must be exactly "DELETE"',
        )

    statuses = ["scheduled"]
    if payload.include_dispatched:
        statuses += ["dispatched", "en_route", "in_progress"]

    try:
        q = db.query(Visit).filter(Visit.status.in_(statuses))
        if payload.only_ical:
            q = q.filter(Visit.ical_source.isnot(None))
        n = q.delete(synchronize_session=False)
        db.commit()
    except Exception as e:
        db.rollback()
        log.exception("delete-scheduled-visits failed")
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")

    log.info(
        "delete-scheduled-visits: deleted %d visits (only_ical=%s, include_dispatched=%s)",
        n, payload.only_ical, payload.include_dispatched,
    )
    return {
        "ok": True,
        "deleted": n,
        "statuses_targeted": statuses,
        "only_ical": payload.only_ical,
    }


# ── Hard-delete helpers (bulk by ID) ────────────────────────────────────────

class BulkIdsRequest(BaseModel):
    ids: List[int]


@router.post("/properties/hard-delete", dependencies=[Depends(require_role("admin"))])
def hard_delete_properties(payload: BulkIdsRequest, db: Session = Depends(get_db)):
    """
    Hard-delete properties by ID (vs. the default soft-delete that just sets
    active=false). Removes property_icals rows first to satisfy FK.
    """
    if not payload.ids:
        return {"deleted": 0}
    db.query(PropertyIcal).filter(PropertyIcal.property_id.in_(payload.ids)).delete(synchronize_session=False)
    db.query(ICalEvent).filter(ICalEvent.property_id.in_(payload.ids)).delete(synchronize_session=False)
    n = db.query(Property).filter(Property.id.in_(payload.ids)).delete(synchronize_session=False)
    db.commit()
    return {"deleted": n}


@router.post("/visits/hard-delete", dependencies=[Depends(require_role("admin"))])
def hard_delete_visits(payload: BulkIdsRequest, db: Session = Depends(get_db)):
    """Hard-delete visits by ID (vs. the default cancel-by-status)."""
    if not payload.ids:
        return {"deleted": 0}
    n = db.query(Visit).filter(Visit.id.in_(payload.ids)).delete(synchronize_session=False)
    db.commit()
    return {"deleted": n}


@router.post("/comms/merge-duplicate-threads", dependencies=[Depends(require_role("admin"))])
def merge_duplicate_threads(db: Session = Depends(get_db)):
    """Phase 5 — one-time backfill. Iterate every client's phone numbers
    (primary + ContactPhone rows) and run the existing per-phone merge
    helper to:
      - absorb SMS-auto-created placeholder clients into the real client
      - link orphan Conversations / Messages by phone-tail match
      - collapse multiple SMS conversations for the same client into one

    Run this after deploying so historical duplicates from before the
    auto-merge-on-webhook hook get cleaned up. Idempotent.
    """
    from modules.clients.router import _link_and_merge_conversations

    totals = {"linked_conversations": 0, "linked_messages": 0,
              "merged_conversations": 0, "absorbed_clients": 0}
    clients_processed = 0
    phones_processed = 0

    for client in db.query(Client).all():
        phones = set()
        if client.phone:
            phones.add(client.phone)
        for cp in db.query(ContactPhone).filter(ContactPhone.client_id == client.id).all():
            if cp.phone:
                phones.add(cp.phone)

        for phone in phones:
            try:
                report = _link_and_merge_conversations(db, client.id, phone)
                for k, v in report.items():
                    totals[k] = totals.get(k, 0) + v
                phones_processed += 1
            except Exception as e:
                log.warning(f"merge-duplicate-threads: client #{client.id} phone {phone!r}: {e}")

        clients_processed += 1

    db.commit()
    log.info(
        "merge-duplicate-threads: %d clients, %d phones, totals=%s",
        clients_processed, phones_processed, totals,
    )
    return {
        "clients_processed": clients_processed,
        "phones_processed": phones_processed,
        **totals,
    }


# ---------------------------------------------------------------------------
# Schedule audit — diagnostics for stale property data showing up in jobs.
#
# Symptom that prompted these: a job titled "Turnover — Spin Drift" was
# rendering at address "5 Moors Point Road" on the Schedule. Possible
# causes: a duplicate Property row (e.g. an iCal feed auto-created a
# second "Spin Drift" at a different address), or a Job whose property_id
# was set to the wrong property. These endpoints surface both so an
# operator can fix the data manually.
# ---------------------------------------------------------------------------

def _norm_name(s: Optional[str]) -> str:
    """Loose normalization for property-name grouping: lower, trimmed,
    collapsed whitespace, stripped of common punctuation. Two rows with
    names 'Spin Drift' and 'Spin  Drift!' should group together."""
    if not s:
        return ""
    import re as _re
    s = s.lower().strip()
    s = _re.sub(r"[^a-z0-9 ]", " ", s)
    s = _re.sub(r"\s+", " ", s)
    return s


@router.get("/properties/duplicates", dependencies=[Depends(require_role("admin", "manager"))])
def find_duplicate_properties(db: Session = Depends(get_db)):
    """Group Property rows by normalized name and return any group with
    more than one row. The most common source of duplicates is an iCal
    feed import: the listing's address didn't string-match an existing
    property, so a second Property got created."""
    props = db.query(Property).all()
    groups: dict[str, list[dict]] = {}
    for p in props:
        key = _norm_name(p.name)
        if not key:
            continue
        groups.setdefault(key, []).append({
            "id": p.id,
            "name": p.name,
            "address": p.address,
            "property_type": getattr(p, "property_type", None),
            "client_id": getattr(p, "client_id", None),
            "created_at": p.created_at.isoformat() if getattr(p, "created_at", None) else None,
        })
    dups = [{"normalized_name": k, "count": len(v), "rows": v}
            for k, v in groups.items() if len(v) > 1]
    dups.sort(key=lambda g: g["count"], reverse=True)
    return {"groups": dups, "total_duplicate_rows": sum(g["count"] for g in dups)}


@router.get("/jobs/property-mismatches", dependencies=[Depends(require_role("admin", "manager"))])
def find_job_property_mismatches(db: Session = Depends(get_db)):
    """Find Jobs where the title doesn't appear to reference the linked
    Property's name. Heuristic — looks for ANY normalized-name token of
    the property name inside the normalized job title. Skips Jobs with
    no property_id (no property to compare to). False positives are
    fine since this is just a manual-review surface."""
    jobs = (db.query(Job)
              .filter(Job.property_id.isnot(None))
              .order_by(Job.scheduled_date.desc().nullslast() if hasattr(Job.scheduled_date.desc(), "nullslast") else Job.scheduled_date.desc())
              .limit(2000)
              .all())
    prop_by_id = {p.id: p for p in db.query(Property).filter(
        Property.id.in_({j.property_id for j in jobs})
    ).all()}

    mismatches = []
    for j in jobs:
        prop = prop_by_id.get(j.property_id)
        if not prop:
            continue
        title_norm = _norm_name(j.title)
        prop_name_norm = _norm_name(prop.name)
        prop_address_norm = _norm_name(prop.address)
        if not prop_name_norm:
            continue
        # Skip properties where name == address. Those have no human-set
        # name, so comparing the job title to the address-as-name produces
        # false positives ("Residential bi-weekly" at "17 Oakmont Dr" was
        # being flagged even though the job_address matched perfectly).
        if prop_name_norm == prop_address_norm:
            continue
        # And if the job's own address matches the property's address,
        # the data is consistent — title divergence isn't a misrouting bug.
        if j.address and _norm_name(j.address) == prop_address_norm:
            continue
        # Any token of the prop name length >= 4 has to appear in the title.
        tokens = [t for t in prop_name_norm.split(" ") if len(t) >= 4]
        if not tokens:
            continue
        if any(t in title_norm for t in tokens):
            continue
        mismatches.append({
            "job_id": j.id,
            "job_title": j.title,
            "job_address": j.address,
            "scheduled_date": j.scheduled_date.isoformat() if j.scheduled_date else None,
            "property_id": prop.id,
            "property_name": prop.name,
            "property_address": prop.address,
        })
    return {"mismatches": mismatches, "count": len(mismatches)}


class ReassignJobPropertyRequest(BaseModel):
    job_ids: List[int]
    to_property_id: int


@router.post("/jobs/reassign-property", dependencies=[Depends(require_role("admin"))])
def reassign_job_property(payload: ReassignJobPropertyRequest, db: Session = Depends(get_db)):
    """Bulk-update Job.property_id for the given job_ids. Companion to the
    /jobs/property-mismatches diagnostic — once a misrouting is confirmed
    (e.g. 12 Spin Drift turnovers pointing at property_id=3 when they
    should point at property_id=5), this endpoint applies the fix
    transactionally.

    Validates that the target property exists and that the requested job
    ids actually exist; returns which IDs were updated vs skipped. Safe
    to retry — re-running on already-updated rows is a no-op."""
    if not payload.job_ids:
        return {"updated": 0, "skipped": [], "missing": []}

    target = db.query(Property).filter(Property.id == payload.to_property_id).first()
    if not target:
        raise HTTPException(status_code=404, detail=f"Property {payload.to_property_id} not found")

    found = db.query(Job).filter(Job.id.in_(payload.job_ids)).all()
    found_ids = {j.id for j in found}
    missing = [jid for jid in payload.job_ids if jid not in found_ids]

    updated = 0
    skipped = []
    for j in found:
        if j.property_id == payload.to_property_id:
            skipped.append(j.id)  # already on the target — no-op
            continue
        j.property_id = payload.to_property_id
        updated += 1

    db.commit()
    log.info(
        "reassign-property: %d jobs → property %d (target=%s, skipped=%d, missing=%d)",
        updated, payload.to_property_id, target.name, len(skipped), len(missing),
    )
    return {
        "updated": updated,
        "skipped_already_on_target": skipped,
        "missing": missing,
        "to_property_id": payload.to_property_id,
        "to_property_name": target.name,
        "to_property_address": target.address,
    }


class SyncFlagsBody(BaseModel):
    ical_auto_sync_enabled: Optional[bool] = None
    gcal_auto_sync_enabled: Optional[bool] = None
    recurring_auto_generate_enabled: Optional[bool] = None


@router.get("/settings", dependencies=[Depends(require_role("admin", "manager"))])
def get_settings(db: Session = Depends(get_db)):
    """Return current sync flags (DB-backed) and read-only env-derived config
    so the Settings page can render company info, calendar IDs, and webhook
    URLs without exposing secrets.
    """
    import os
    from database.models import AppSetting

    def _flag(key: str, default: bool = True) -> bool:
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        if row is None or row.value is None:
            env_val = os.getenv(key.upper(), "1" if default else "0")
            return str(env_val).strip().lower() in {"1", "true", "yes", "on"}
        return str(row.value).strip().lower() in {"1", "true", "yes", "on"}

    return {
        "sync_flags": {
            "ical_auto_sync_enabled": _flag("ical_auto_sync_enabled", True),
            "gcal_auto_sync_enabled": _flag("gcal_auto_sync_enabled", True),
            "recurring_auto_generate_enabled": _flag("recurring_auto_generate_enabled", True),
        },
        "intervals": {
            "ical_minutes": int(os.getenv("ICAL_AUTO_SYNC_INTERVAL_MINUTES", "15")),
            "gcal_minutes": int(os.getenv("GCAL_AUTO_SYNC_INTERVAL_MINUTES", "10")),
            "recurring_hours": int(os.getenv("RECURRING_AUTO_GENERATE_INTERVAL_HOURS", "24")),
        },
        "company": {
            "name": os.getenv("FROM_NAME", "Maine Cleaning Co"),
            "email": os.getenv("SMTP_USER", ""),
            "phone": os.getenv("TWILIO_PHONE_NUMBER", ""),
            "notify_email": os.getenv("NOTIFY_EMAIL", ""),
            "app_url": os.getenv("APP_URL", "https://maineclean.co"),
        },
        "gcal_calendar_ids": {
            "residential": os.getenv("GCAL_RESIDENTIAL_CALENDAR_ID", ""),
            "str": os.getenv("GCAL_STR_CALENDAR_ID", ""),
            "commercial": os.getenv("GCAL_COMMERCIAL_CALENDAR_ID", ""),
        },
        "smtp_configured": bool(os.getenv("SMTP_PASS")),
    }


@router.patch("/settings/sync-flags", dependencies=[Depends(require_role("admin", "manager"))])
def update_sync_flags(body: SyncFlagsBody, db: Session = Depends(get_db)):
    """Update DB-backed sync feature flags. These override env defaults at
    runtime (see scheduler._db_flag)."""
    from database.models import AppSetting

    payload = body.model_dump(exclude_none=True)
    if not payload:
        return {"updated": []}

    updated = []
    for key, value in payload.items():
        row = db.query(AppSetting).filter(AppSetting.key == key).first()
        val_str = "1" if value else "0"
        if row:
            row.value = val_str
        else:
            row = AppSetting(key=key, value=val_str)
            db.add(row)
        updated.append({"key": key, "value": value})
    db.commit()
    return {"updated": updated}
