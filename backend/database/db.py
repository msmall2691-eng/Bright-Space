from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from database.base import Base
import os
import logging

logger = logging.getLogger(__name__)

# BB-INFRA-01: DATABASE_URL is now required.
#
# Was: defaulted to "sqlite:///./brightbase.db". A deploy that ever lost the
# env var (a Railway service rebuild, a forked environment) would silently
# start a local SQLite at /data/brightbase.db on the brightbase-volume,
# apply the boot-time migration system there, and accept writes — diverging
# from the canonical Postgres DB with no alarm. The orphan brightbase-volume
# on Railway is a remnant of exactly that era.
#
# Now: missing env → RuntimeError at import. Tests that need SQLite still
# set DATABASE_URL=sqlite:///./test_*.db explicitly (test_pipeline.py etc.).
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Set it to a Postgres URL in production "
        "(or to sqlite:///./local.db for local dev / tests)."
    )

# Railway sometimes provides postgres:// but SQLAlchemy requires postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Only use check_same_thread for SQLite (it's SQLite-specific)
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False
else:
    # Phase 0 reliability: cap how long any single statement can run. A
    # pathological query (missing index, lock wait) now fails fast with an
    # error the request layer can surface as a retry, instead of hanging the
    # connection — and the request — indefinitely. 8s is generous for the OLTP
    # reads/writes this API does; genuine long jobs run outside the web path.
    connect_args["options"] = "-c statement_timeout=8000"

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def check_schema_drift() -> dict:
    """Compare the DB's applied Alembic revision to the code's head revision.

    Fail-soft: returns a dict and NEVER raises. Run at startup to LOUDLY surface a
    behind-on-migrations production DB — the usual cause of "column does not
    exist" 500s (e.g. the GET /api/quotes/ 500 in the June audit) — instead of
    letting individual endpoints fail mysteriously later. Returns:
      {"ok": True|False|None, "db_revision": str|None, "head_revision": str|None}
    ok is None when the check itself couldn't run (no alembic_version table on a
    fresh/SQLite DB, etc.).
    """
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cfg = Config(os.path.join(backend_dir, "alembic.ini"))
        cfg.set_main_option("script_location", os.path.join(backend_dir, "alembic"))
        head = ScriptDirectory.from_config(cfg).get_current_head()
        current = None
        try:
            with engine.connect() as conn:
                row = conn.execute(text("SELECT version_num FROM alembic_version")).fetchone()
                current = row[0] if row else None
        except Exception:
            return {"ok": None, "db_revision": None, "head_revision": head,
                    "error": "alembic_version table not found"}
        ok = current == head
        if not ok:
            logger.error(
                "[schema-drift] DB is at migration %r but code head is %r. "
                "Run 'alembic upgrade head' — endpoints that read newer columns "
                "may return 500 until migrations are applied.", current, head,
            )
        return {"ok": ok, "db_revision": current, "head_revision": head}
    except Exception as e:
        logger.warning("[schema-drift] could not verify migration state: %s", e)
        return {"ok": None, "error": str(e)}


def init_db():
    # Schema is Alembic's job — `python scripts/db_bootstrap.py` runs before
    # the app starts (Railway preDeployCommand) and applies every migration.
    # The historical in-Python ALTER TABLE list that used to live here was
    # removed once prod caught up to Alembic head (see the Phase 3 schema
    # cleanup PR); if you're editing a model, add an Alembic migration —
    # do not extend init_db.
    #
    # init_db still runs a small set of legacy one-time data backfills that
    # are AppSetting-guarded (idempotent no-ops after their first successful
    # run). Each is wrapped so a single failure can't block boot.

    # Phase 1 omnichannel: backfill legacy messages into conversations
    try:
        _backfill_conversations()
    except Exception as e:
        logger.warning(f"Backfill conversations failed (non-critical): {e}")

    # Auth: bootstrap admin user if env vars set
    try:
        _bootstrap_admin_user()
    except Exception as e:
        logger.warning(f"Bootstrap admin user failed (non-critical): {e}")


    # PR 2: Backfill missing properties for orphaned jobs
    try:
        _backfill_missing_properties()
    except Exception as e:
        logger.warning(f"Backfill properties failed (non-critical): {e}")

    # (visits backfill removed by migration 039 — Job/Visit unification.)

    # Fix STR turnover dates (RFC 5545 DTEND exclusivity)
    try:
        _fix_str_turnover_dates()
    except Exception as e:
        logger.warning(f"Fix STR turnover dates failed (non-critical): {e}")

    # One-time: move pre-split quote notes to internal_notes (they were intake
    # context, and leaked onto the public page on June 11).
    try:
        _migrate_quote_notes_to_internal()
    except Exception as e:
        logger.warning(f"Quote notes migration failed (non-critical): {e}")


def _migrate_quote_notes_to_internal():
    """ONE-TIME (AppSetting-flagged, not just idempotent SQL): before the
    internal/customer split, `quotes.notes` held intake/operator context and
    was rendered on the public page. Move it to internal_notes once; after
    that, anything an operator types in `notes` is deliberately customer-
    facing and must never be migrated again."""
    from database.models import AppSetting
    db = SessionLocal()
    try:
        flag = db.query(AppSetting).filter(AppSetting.key == "migrated_quote_notes_to_internal").first()
        if flag and flag.value == "1":
            return
        db.execute(text(
            "UPDATE quotes SET internal_notes = notes, notes = NULL "
            "WHERE (internal_notes IS NULL OR internal_notes = '') "
            "AND notes IS NOT NULL AND notes != ''"
        ))
        db.add(AppSetting(key="migrated_quote_notes_to_internal", value="1"))
        db.commit()
        logger.info("[migration] moved legacy quote notes to internal_notes (one-time)")
    finally:
        db.close()


def _backfill_conversations():
    """
    Attach any legacy Messages lacking conversation_id to a Conversation.

    Groups messages by (client_id or external_contact, channel). Idempotent —
    safe to run on every boot. Legacy conversations are marked resolved so
    they don't show up in the active inbox.
    """
    from database.models import Message, Conversation

    db = SessionLocal()
    try:
        orphans = db.query(Message).filter(Message.conversation_id.is_(None)).all()
        if not orphans:
            return
        logger.info(f"[backfill] Linking {len(orphans)} legacy messages to conversations")

        for msg in orphans:
            external = msg.from_addr if msg.direction == "inbound" else msg.to_addr

            q = db.query(Conversation).filter(Conversation.channel == msg.channel)
            if msg.client_id:
                q = q.filter(Conversation.client_id == msg.client_id)
            elif external:
                q = q.filter(Conversation.external_contact == external)
            else:
                continue

            conv = q.order_by(Conversation.last_message_at.desc()).first()
            if conv is None:
                conv = Conversation(
                    client_id=msg.client_id,
                    external_contact=external,
                    channel=msg.channel,
                    subject=msg.subject,
                    status="resolved",
                    last_message_at=msg.created_at,
                )
                db.add(conv)
                db.flush()

            msg.conversation_id = conv.id
            # Roll up conversation activity timestamps
            if not conv.last_message_at or (msg.created_at and msg.created_at > conv.last_message_at):
                conv.last_message_at = msg.created_at
            if msg.direction == "inbound" and (
                not conv.last_inbound_at or (msg.created_at and msg.created_at > conv.last_inbound_at)
            ):
                conv.last_inbound_at = msg.created_at
            if msg.direction == "outbound" and (
                not conv.last_outbound_at or (msg.created_at and msg.created_at > conv.last_outbound_at)
            ):
                conv.last_outbound_at = msg.created_at

        db.commit()
    except Exception as exc:
        logger.warning(f"[backfill] conversation backfill skipped: {exc}")
        try: db.rollback()
        except Exception: pass
    finally:
        db.close()


def _bootstrap_admin_user():
    """Create bootstrap admin user if ADMIN_BOOTSTRAP_EMAIL env var is set."""
    admin_email = os.getenv("ADMIN_BOOTSTRAP_EMAIL", "").strip()
    admin_password = os.getenv("ADMIN_BOOTSTRAP_PASSWORD", "").strip()

    if not admin_email or not admin_password:
        logger.info("[bootstrap] Skipping admin user creation (no ADMIN_BOOTSTRAP_EMAIL/PASSWORD env vars)")
        return

    from database.models import User
    from auth_jwt import hash_password

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == admin_email).first()
        if existing:
            logger.info(f"[bootstrap] Admin user {admin_email} already exists, skipping")
            return

        password_hash = hash_password(admin_password)

        admin = User(
            email=admin_email,
            password_hash=password_hash,
            full_name="Administrator",
            role="admin",
            active=True,
        )
        db.add(admin)
        db.commit()
        logger.info(f"[bootstrap] Created admin user: {admin_email}")
    except Exception as exc:
        logger.warning(f"[bootstrap] Failed to create admin user: {exc}")
    finally:
        db.close()


def _backfill_missing_properties():
    """
    PR 2: Backfill property_id for orphaned jobs.

    For jobs without property_id but with an address:
    1. Auto-create a Property for each unique (client_id, address, job_type) combo
    2. Link the job to the new property
    3. Use address first line as property name

    Idempotent — safe to run every boot.
    """
    from database.models import Job, Property, Client

    db = SessionLocal()
    try:
        # Find jobs with address but no property_id
        orphan_jobs = db.query(Job).filter(
            Job.property_id.is_(None),
            Job.address.isnot(None),
            Job.address != ""
        ).all()

        if not orphan_jobs:
            db.close()
            return

        logger.info(f"[backfill_missing_properties] Found {len(orphan_jobs)} jobs without property_id")

        created_props = 0
        linked_jobs = 0

        for job in orphan_jobs:
            try:
                client = db.query(Client).filter(Client.id == job.client_id).first()
                if not client:
                    logger.warning(f"[backfill_missing_properties] Job {job.id} has no client, skipping")
                    continue

                # Extract first line of address as property name
                address_line = job.address.split("\n")[0] if job.address else f"Job {job.id}"

                # Check if property already exists for this client/address/type combo
                existing_prop = db.query(Property).filter(
                    Property.client_id == job.client_id,
                    Property.address == address_line
                ).first()

                if existing_prop:
                    job.property_id = existing_prop.id
                    linked_jobs += 1
                else:
                    # Infer property type from job type
                    property_type = "residential"
                    if job.job_type == "str_turnover":
                        property_type = "str"
                    elif job.job_type == "commercial":
                        property_type = "commercial"

                    # Create new property
                    prop = Property(
                        client_id=job.client_id,
                        name=address_line,
                        address=address_line,
                        property_type=property_type,
                    )
                    db.add(prop)
                    db.flush()
                    job.property_id = prop.id
                    created_props += 1
                    linked_jobs += 1
            except Exception as e:
                logger.warning(f"[backfill_missing_properties] Error processing job {job.id}: {e}")

        if created_props > 0 or linked_jobs > 0:
            db.commit()
            logger.info(f"[backfill_missing_properties] Created {created_props} properties, linked {linked_jobs} jobs")

    except Exception as exc:
        logger.warning(f"[backfill_missing_properties] Error during backfill: {exc}")
    finally:
        db.close()


def _fix_str_turnover_dates():
    """
    Fix STR turnover dates to account for RFC 5545 DTEND exclusivity.

    This is a Python-based migration (not SQL) because scheduled_date is stored
    as a string. It's idempotent - safe to run on every boot.
    """
    from database.models import Job, ICalEvent
    from datetime import datetime, timedelta, timezone

    db = SessionLocal()
    try:
        # Fix Job scheduled_dates for STR turnovers
        jobs = db.query(Job).filter(
            Job.job_type == "str_turnover",
            Job.status.in_(["scheduled", "dispatched"])
        ).all()

        fixed_jobs = 0
        for job in jobs:
            try:
                # Parse the date string and subtract 1 day
                if not job.scheduled_date:
                    continue
                job_date = datetime.strptime(str(job.scheduled_date), "%Y-%m-%d").date()
                # Only fix if it looks like it hasn't been fixed (heuristic: if it's in the future relative to today+1)
                # Actually, let's check if there's a corresponding iCal event with a different date
                if job_date:
                    # For now, we'll check the raw_event to see if adjustment is needed
                    # This is safer than blindly subtracting 1 day from all
                    ical_event = db.query(ICalEvent).filter(ICalEvent.job_id == job.id).first()
                    if ical_event and ical_event.checkout_date:
                        try:
                            ical_date = datetime.strptime(ical_event.checkout_date, "%Y-%m-%d").date()
                            # If job date is 1 day after iCal date, fix it
                            if job_date == ical_date + timedelta(days=1):
                                job.scheduled_date = ical_date.isoformat()
                                fixed_jobs += 1
                        except ValueError:
                            pass
            except ValueError:
                # Skip if date parsing fails
                pass

        if fixed_jobs > 0:
            db.commit()
            logger.info(f"[fix_str_turnover_dates] Fixed {fixed_jobs} job dates")

        # Fix ICalEvent checkout_dates
        ical_events = db.query(ICalEvent).filter(
            ICalEvent.event_type == "reservation"
        ).all()

        fixed_events = 0
        for event in ical_events:
            try:
                if not event.checkout_date:
                    continue
                # Handle both string and date object
                if isinstance(event.checkout_date, str):
                    event_date = datetime.strptime(event.checkout_date, "%Y-%m-%d").date()
                else:
                    event_date = event.checkout_date
                # Check raw_event to see original DTEND
                # For now, mark as fixed if job is already linked and has correct date
                if event.job_id:
                    job = db.query(Job).filter(Job.id == event.job_id).first()
                    if job and job.scheduled_date:
                        if isinstance(job.scheduled_date, str):
                            job_date = datetime.strptime(job.scheduled_date, "%Y-%m-%d").date()
                        else:
                            job_date = job.scheduled_date
                        # If event date is 1 day after job date, event needs fixing
                        if event_date == job_date + timedelta(days=1):
                            event.checkout_date = job_date.isoformat()
                            fixed_events += 1
            except ValueError:
                pass

        if fixed_events > 0:
            db.commit()
            logger.info(f"[fix_str_turnover_dates] Fixed {fixed_events} iCal event dates")

    except Exception as exc:
        logger.warning(f"[fix_str_turnover_dates] Error during fix: {exc}")
    finally:
        db.close()


def update_ical_feed_status(
    property_ical_id: int,
    status: str,
    error_message: str = None,
):
    """
    Update sync status for an iCal feed.

    Args:
        property_ical_id: ID of the PropertyIcal record
        status: 'ok', 'failed', 'retrying', or 'paused'
        error_message: Optional error details for 'failed' status
    """
    from database.models import PropertyIcal
    from datetime import datetime, timezone

    db = SessionLocal()
    try:
        feed = db.query(PropertyIcal).filter(PropertyIcal.id == property_ical_id).first()
        if not feed:
            logger.warning(f"[update_ical_feed_status] Feed {property_ical_id} not found")
            return

        feed.last_sync_status = status
        feed.last_synced_at = datetime.now(timezone.utc)

        if status == "failed":
            feed.last_sync_error = error_message
            feed.sync_retry_count = (feed.sync_retry_count or 0) + 1
        elif status == "ok":
            feed.last_sync_error = None
            feed.sync_retry_count = 0

        db.commit()
        logger.info(f"[update_ical_feed_status] Feed {property_ical_id} → {status}")
    except Exception as e:
        logger.warning(f"[update_ical_feed_status] Error updating feed {property_ical_id}: {e}")
    finally:
        db.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
