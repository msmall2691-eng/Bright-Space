"""Transactional outbox for Connecteam shift sync (durability hardening).

Calling Connecteam's API inline from a job-change path has two failure modes:
  1. the API call succeeds but the request then rolls back → an orphan shift
     with no local record;
  2. a double-submit or two concurrent paths both see connecteam_shift_ids
     empty and each create a shift → a DUPLICATE.

The outbox fixes both. A job-change path calls ``enqueue_sync`` in the SAME
transaction as the job change, so the intent commits (or rolls back) atomically
with it — a rolled-back job never leaves a queued sync, and a committed change
always has one. ``drain_outbox`` then performs the Connecteam call.

Idempotency guarantees:
  - ``dedupe_key`` is UNIQUE, so enqueuing the same desired state twice
    (double-submit, retry, two racing callers) collapses to one row.
  - the drain processes a row exactly once: it claims pending rows with
    ``FOR UPDATE SKIP LOCKED`` (Postgres) and flips status pending→done/failed
    under a re-check, so two workers can't both run it.

Together these make a duplicate shift structurally impossible for
enqueued-and-drained syncs. The one residual window — a crash after Connecteam
creates the shift but before we record its id — is swept by the read-back
reconcile (``read_back_reconcile``), which flags/repairs untracked shifts.

Everything is best-effort at the boundary: enqueue never raises into the job
lifecycle, and the drain isolates per-row failures (attempts + backoff) so one
bad row can't stall the queue.
"""
import hashlib
import logging
from datetime import datetime, timezone

from database.models import ConnecteamOutbox, Job
from integrations.connecteam import is_configured
from integrations.connecteam_auto import (
    auto_dispatch_job,
    remove_job_from_connecteam,
)

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5


def _utcnow():
    return datetime.now(timezone.utc)


def _state_fingerprint(job) -> str:
    """Stable (cross-process) fingerprint of the shift-affecting fields of a
    job's desired state. hashlib, not hash() — the latter is salted per process,
    which would make the same intent produce different dedupe keys per worker."""
    parts = [
        str(job.scheduled_date), str(job.start_time), str(job.end_time),
        job.job_type or "",
        ",".join(sorted(str(c) for c in (job.cleaner_ids or []))),
    ]
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def dedupe_key_for(job, op: str) -> str:
    """The unique intent fingerprint. A 'dispatch' is keyed by the desired
    state, so re-enqueuing the same state is a no-op but a reschedule (new
    state) enqueues afresh. A 'remove' is keyed by the shift set being pulled."""
    if op == "remove":
        shifts = ",".join(sorted(str(s) for s in (job.connecteam_shift_ids or [])))
        return f"remove:{job.id}:{hashlib.sha1(shifts.encode()).hexdigest()[:16]}"
    return f"dispatch:{job.id}:{_state_fingerprint(job)}"


def enqueue_sync(db, job, op: str, *, commit: bool = False):
    """Queue a Connecteam sync intent for ``job`` ('dispatch' | 'remove').

    Call INSIDE the job's transaction (commit=False) so the intent is atomic
    with the job change — a rolled-back job leaves no queued sync. Idempotent
    via an INSERT ... ON CONFLICT (dedupe_key) DO NOTHING, so a double-submit or
    two racing callers enqueue once without poisoning the caller's transaction
    (a plain insert would IntegrityError at flush and abort the whole unit of
    work). Requires job.id (flush the job first). Never raises into the caller.
    """
    if job is None or job.id is None:
        return None
    key = dedupe_key_for(job, op)
    now = _utcnow()
    values = dict(
        job_id=job.id, org_id=getattr(job, "org_id", None), op=op,
        dedupe_key=key, status="pending", attempts=0,
        created_at=now, updated_at=now,
    )
    dialect = db.bind.dialect.name if db.bind is not None else ""
    try:
        if dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as _ins
            stmt = _ins(ConnecteamOutbox).values(**values).on_conflict_do_nothing(
                index_elements=["dedupe_key"])
        elif dialect == "sqlite":
            from sqlalchemy.dialects.sqlite import insert as _ins
            stmt = _ins(ConnecteamOutbox).values(**values).on_conflict_do_nothing(
                index_elements=["dedupe_key"])
        else:  # pragma: no cover - other backends: plain insert, dedupe via unique
            from sqlalchemy import insert as _ins
            stmt = _ins(ConnecteamOutbox).values(**values)
        db.execute(stmt)
    except Exception as e:  # pragma: no cover - never break the job lifecycle
        logger.warning("Connecteam outbox enqueue failed for job %s: %s", job.id, e)
        return None
    if commit:
        try:
            db.commit()
        except Exception as e:  # pragma: no cover
            logger.warning("Connecteam outbox enqueue commit failed: %s", e)
            db.rollback()
    return key


def _process_one(db, row) -> None:
    """Perform the Connecteam side of one outbox row. Raises on API failure so
    the caller can record the attempt; does its own DB bookkeeping via the
    connecteam_auto helpers (commit=False — the caller commits)."""
    job = db.query(Job).filter(Job.id == row.job_id).first()
    if job is None:
        return  # job deleted — nothing to sync; treat as done

    def _raise_if_failed(st, what):
        # auto_dispatch_job / remove_job_from_connecteam are best-effort and
        # swallow API errors into a status dict — so the drain must inspect it
        # and raise, or a transient Connecteam outage would silently mark the
        # intent done (shift never created) with no retry.
        if st and st.get("errors"):
            raise RuntimeError(f"{what} failed: {st['errors']}")

    if row.op == "remove":
        _raise_if_failed(remove_job_from_connecteam(db, job, commit=False), "remove")
        return
    # dispatch: make the job's shifts match its current desired state.
    if job.status in ("cancelled", "completed"):
        _raise_if_failed(remove_job_from_connecteam(db, job, commit=False), "remove")
    elif job.connecteam_shift_ids:
        # Existing shifts → re-sync (pull stale, push fresh) so a time/crew
        # change is applied. Delete is idempotent (404 = already gone).
        _raise_if_failed(remove_job_from_connecteam(db, job, commit=False), "remove")
        _raise_if_failed(auto_dispatch_job(db, job, commit=False), "dispatch")
    else:
        _raise_if_failed(auto_dispatch_job(db, job, commit=False), "dispatch")


def drain_outbox(db, *, limit: int = 50, max_attempts: int = MAX_ATTEMPTS) -> dict:
    """Process pending outbox rows. Claims a batch (FOR UPDATE SKIP LOCKED on
    Postgres so concurrent drains don't collide), then processes each by id
    under a status re-check and commits per row, so one failure can't lose the
    others. A row that keeps failing is retried until max_attempts, then parked
    as 'failed' for review."""
    if not is_configured():
        return {"processed": 0, "failed": 0, "skipped": "not_configured", "errors": []}

    q = (
        db.query(ConnecteamOutbox.id)
        .filter(ConnecteamOutbox.status == "pending")
        .order_by(ConnecteamOutbox.created_at)
        .limit(limit)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=True)
    row_ids = [r[0] for r in q.all()]

    done, failed, errors = 0, 0, []
    for row_id in row_ids:
        row = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.id == row_id).first()
        if row is None or row.status != "pending":
            continue  # already handled by another drain
        try:
            _process_one(db, row)
            row.status = "done"
            row.processed_at = _utcnow()
            db.commit()
            done += 1
        except Exception as e:
            # Discard any partial shift bookkeeping, then record the attempt on
            # a freshly-loaded row (rollback expired the one above).
            db.rollback()
            row = db.query(ConnecteamOutbox).filter(ConnecteamOutbox.id == row_id).first()
            if row is None:
                continue
            row.attempts = (row.attempts or 0) + 1
            row.last_error = str(e)[:500]
            if row.attempts >= max_attempts:
                row.status = "failed"
                failed += 1
            db.commit()
            errors.append({"outbox_id": row_id, "job_id": row.job_id, "error": str(e)})
    return {"processed": done, "failed": failed, "errors": errors}
