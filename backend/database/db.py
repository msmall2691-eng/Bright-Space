from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from database.models import Base
import os
import logging

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./brightbase.db")

# Railway sometimes provides postgres:// but SQLAlchemy requires postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Only use check_same_thread for SQLite (it's SQLite-specific)
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db():
    Base.metadata.create_all(bind=engine)
    # Safe migrations: add new columns if they don't exist yet
    _run_migrations()
    # Phase 1 omnichannel: backfill legacy messages into conversations
    _backfill_conversations()
    # Auth: bootstrap admin user if env vars set
    _bootstrap_admin_user()
    # PR 1: Backfill new data types (DATE, TIME instead of VARCHAR)
    _migrate_data_types()
    # Fix STR turnover dates (RFC 5545 DTEND exclusivity)
    _fix_str_turnover_dates()


def _run_migrations():
    """
    Idempotent, dialect-aware ALTER TABLE migrations.

    Each entry is (sql, reason_ok_to_skip). We log loud warnings on any
    failure that *isn't* the expected "column already exists" case so
    we can diagnose in Railway logs.
    """
    is_pg = DATABASE_URL.startswith("postgresql")

    # Use BOOLEAN on Postgres (strict type matching with SQLAlchemy Boolean),
    # INTEGER on SQLite (which stores booleans as int anyway).
    bool_col = "BOOLEAN DEFAULT FALSE" if is_pg else "INTEGER DEFAULT 0"

    migrations = [
        # PR 1: Fix data types — VARCHAR dates become DATE, TIME, TIMESTAMPTZ
        "ALTER TABLE jobs ADD COLUMN scheduled_date_new DATE",
        "ALTER TABLE jobs ADD COLUMN start_time_new TIME",
        "ALTER TABLE jobs ADD COLUMN end_time_new TIME",
        "ALTER TABLE recurring_schedules ADD COLUMN start_time_new TIME",
        "ALTER TABLE recurring_schedules ADD COLUMN end_time_new TIME",
        "ALTER TABLE quotes ADD COLUMN intake_id INTEGER REFERENCES lead_intakes(id)",
        "ALTER TABLE quotes ADD COLUMN quote_number TEXT",
        "ALTER TABLE quotes ADD COLUMN address TEXT",
        "ALTER TABLE quotes ADD COLUMN service_type TEXT",
        # Custom fields
        "ALTER TABLE clients ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        "ALTER TABLE jobs ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        "ALTER TABLE invoices ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        # Multi-day recurring + GCal two-way sync
        "ALTER TABLE recurring_schedules ADD COLUMN days_of_week TEXT",
        "ALTER TABLE jobs ADD COLUMN gcal_event_id TEXT",
        # Client name & billing address
        "ALTER TABLE clients ADD COLUMN first_name TEXT",
        "ALTER TABLE clients ADD COLUMN last_name TEXT",
        "ALTER TABLE clients ADD COLUMN billing_address TEXT",
        "ALTER TABLE clients ADD COLUMN billing_city TEXT",
        "ALTER TABLE clients ADD COLUMN billing_state TEXT",
        "ALTER TABLE clients ADD COLUMN billing_zip TEXT",
        # Website booking pipeline fields on lead_intakes
        "ALTER TABLE lead_intakes ADD COLUMN bathrooms INTEGER",
        "ALTER TABLE lead_intakes ADD COLUMN guests INTEGER",
        "ALTER TABLE lead_intakes ADD COLUMN frequency TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN requested_date TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN check_in TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN check_out TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN estimate_min REAL",
        "ALTER TABLE lead_intakes ADD COLUMN estimate_max REAL",
        "ALTER TABLE lead_intakes ADD COLUMN property_name TEXT",
        # Request pipeline enhancements
        "ALTER TABLE lead_intakes ADD COLUMN priority TEXT DEFAULT 'normal'",
        "ALTER TABLE lead_intakes ADD COLUMN assigned_to TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN internal_notes TEXT",
        "ALTER TABLE lead_intakes ADD COLUMN followed_up_at TIMESTAMP",
        # iCal host block detection: track event type (reservation vs host_block)
        "ALTER TABLE ical_events ADD COLUMN event_type TEXT DEFAULT 'reservation'",
        # Omnichannel inbox (Phase 1): conversation threading on messages
        "ALTER TABLE messages ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)",
        "ALTER TABLE messages ADD COLUMN external_id TEXT",
        "ALTER TABLE messages ADD COLUMN author TEXT",
        f"ALTER TABLE messages ADD COLUMN is_internal_note {bool_col}",
        # CRM enrichment: client lifecycle, type, and contact tracking
        "ALTER TABLE clients ADD COLUMN client_type TEXT",
        "ALTER TABLE clients ADD COLUMN lifecycle_stage TEXT DEFAULT 'new'",
        "ALTER TABLE clients ADD COLUMN source_detail TEXT",
        "ALTER TABLE clients ADD COLUMN last_contacted_at TIMESTAMP",
        f"ALTER TABLE clients ADD COLUMN email_verified {bool_col}",
        # Link lead intakes to opportunities
        "ALTER TABLE lead_intakes ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id)",
        # Opportunities feature: add opportunity_id and updated_at to multiple tables
        "ALTER TABLE field_definitions ADD COLUMN is_system BOOLEAN DEFAULT FALSE",
        "ALTER TABLE jobs ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE jobs ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE quotes ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE quotes ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        "ALTER TABLE quotes ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE invoices ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE invoices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE conversations ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE conversations ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE messages ADD COLUMN job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL",
        "ALTER TABLE messages ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE opportunities ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        "ALTER TABLE opportunities ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE lead_intakes ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL",
        "ALTER TABLE lead_intakes ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        # Create indexes for performance
        "CREATE INDEX IF NOT EXISTS idx_job_opportunity_id ON jobs(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_quote_opportunity_id ON quotes(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_invoice_opportunity_id ON invoices(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_message_opportunity_id ON messages(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_message_job_id ON messages(job_id)",
        "CREATE INDEX IF NOT EXISTS idx_conversation_opportunity_id ON conversations(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_lead_intake_opportunity_id ON lead_intakes(opportunity_id)",
        "CREATE INDEX IF NOT EXISTS idx_job_updated_at ON jobs(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_quote_updated_at ON quotes(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_invoice_updated_at ON invoices(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_opportunity_updated_at ON opportunities(updated_at)",
        # STR property management: multiple iCals, check-in/out times, house codes
        "ALTER TABLE properties ADD COLUMN check_in_time TEXT",
        "ALTER TABLE properties ADD COLUMN check_out_time TEXT",
        "ALTER TABLE properties ADD COLUMN house_code TEXT",
        "ALTER TABLE ical_events ADD COLUMN guest_count INTEGER",
        # User authentication: add users table and cleaner assignment FK
        "ALTER TABLE jobs ADD COLUMN assigned_cleaner_user_id INTEGER REFERENCES users(id)",
        # Flexible recurring intervals: "every N weeks" instead of just weekly/biweekly
        "ALTER TABLE recurring_schedules ADD COLUMN interval_weeks INTEGER NOT NULL DEFAULT 1",
        # Per-iCal turnover settings: override property defaults, house codes, instructions
        "ALTER TABLE property_icals ADD COLUMN checkout_time TEXT",
        "ALTER TABLE property_icals ADD COLUMN duration_hours REAL",
        "ALTER TABLE property_icals ADD COLUMN house_code TEXT",
        "ALTER TABLE property_icals ADD COLUMN access_links TEXT",
        "ALTER TABLE property_icals ADD COLUMN instructions TEXT",
    ]

    # Dialect-aware backfill migrations
    if is_pg:
        backfill_migrations = [
            # PR 1: Drop old VARCHAR columns and rename new DATE/TIME columns
            "ALTER TABLE jobs DROP COLUMN IF EXISTS scheduled_date CASCADE",
            "ALTER TABLE jobs RENAME COLUMN scheduled_date_new TO scheduled_date",
            "ALTER TABLE jobs DROP COLUMN IF EXISTS start_time CASCADE",
            "ALTER TABLE jobs RENAME COLUMN start_time_new TO start_time",
            "ALTER TABLE jobs DROP COLUMN IF EXISTS end_time CASCADE",
            "ALTER TABLE jobs RENAME COLUMN end_time_new TO end_time",
            "CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_date ON jobs(scheduled_date)",
            "ALTER TABLE recurring_schedules DROP COLUMN IF EXISTS start_time CASCADE",
            "ALTER TABLE recurring_schedules RENAME COLUMN start_time_new TO start_time",
            "ALTER TABLE recurring_schedules DROP COLUMN IF EXISTS end_time CASCADE",
            "ALTER TABLE recurring_schedules RENAME COLUMN end_time_new TO end_time",
            # Backfill existing biweekly schedules with interval_weeks=2
            "UPDATE recurring_schedules SET interval_weeks = 2 WHERE frequency = 'biweekly'",
        ]
    else:
        backfill_migrations = [
            # PR 1: Drop old VARCHAR columns and rename new DATE/TIME columns (SQLite)
            "ALTER TABLE jobs RENAME TO jobs_old",
            "CREATE TABLE jobs AS SELECT id, client_id, quote_id, opportunity_id, job_type, property_id, recurring_schedule_id, ical_event_id, assigned_cleaner_user_id, calendar_invite_sent, sms_reminder_sent, gcal_event_id, title, scheduled_date_new as scheduled_date, start_time_new as start_time, end_time_new as end_time, address, cleaner_ids, status, notes, custom_fields, dispatched, connecteam_shift_ids, created_at, updated_at FROM jobs_old",
            "DROP TABLE jobs_old",
            "CREATE INDEX idx_jobs_scheduled_date ON jobs(scheduled_date)",
            "CREATE TABLE recurring_schedules_new AS SELECT id, client_id, job_type, title, address, frequency, interval_weeks, day_of_week, days_of_week, day_of_month, start_time_new as start_time, end_time_new as end_time, cleaner_ids, quote_id, property_id, active, generate_weeks_ahead, starts_at, created_at FROM recurring_schedules",
            "DROP TABLE recurring_schedules",
            "ALTER TABLE recurring_schedules_new RENAME TO recurring_schedules",
            # Backfill existing biweekly schedules with interval_weeks=2
            "UPDATE recurring_schedules SET interval_weeks = 2 WHERE frequency = 'biweekly'",
        ]

    with engine.connect() as conn:

        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception as exc:
                try:
                    conn.rollback()
                except Exception:
                    pass
                # Swallow "already exists" noise, but log everything else so
                # broken deploys surface clearly in Railway logs.
                err_str = str(exc).lower()
                benign = (
                    "already exists" in err_str
                    or "duplicate column" in err_str
                    or "duplicate_column" in err_str
                )
                if not benign:
                    logger.warning(f"[migration] {sql} -> {exc}")

        for sql in backfill_migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception as exc:
                try:
                    conn.rollback()
                except Exception:
                    pass
                logger.warning(f"[backfill] {sql} -> {exc}")

    # Post-migration repair: on Postgres, older deploys may have created
    # is_internal_note as INTEGER when the model expects BOOLEAN. Coerce.
    if is_pg:
        _coerce_is_internal_note_to_boolean()


def _coerce_is_internal_note_to_boolean():
    """If messages.is_internal_note exists as INTEGER on Postgres, convert to BOOLEAN."""
    check_sql = text("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'is_internal_note'
    """)
    alter_sql = text("""
        ALTER TABLE messages
        ALTER COLUMN is_internal_note DROP DEFAULT,
        ALTER COLUMN is_internal_note TYPE BOOLEAN
            USING (CASE WHEN is_internal_note = 0 THEN FALSE ELSE TRUE END),
        ALTER COLUMN is_internal_note SET DEFAULT FALSE
    """)
    try:
        with engine.connect() as conn:
            row = conn.execute(check_sql).fetchone()
            if row and row[0] and row[0].lower() == "integer":
                logger.warning("[migration] coercing messages.is_internal_note INTEGER -> BOOLEAN")
                conn.execute(alter_sql)
                conn.commit()
    except Exception as exc:
        logger.warning(f"[migration] is_internal_note type coercion skipped: {exc}")


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

    try:
        from database.models import User
        from auth_jwt import hash_password

        db = SessionLocal()
        existing = db.query(User).filter(User.email == admin_email).first()
        if existing:
            logger.info(f"[bootstrap] Admin user {admin_email} already exists, skipping")
            db.close()
            return

        # Hash the password using bcrypt with 72-byte truncation
        password_hash = hash_password(admin_password)

        # Create the admin user
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
        db.close()
    except Exception as exc:
        logger.warning(f"[bootstrap] Failed to create admin user: {exc}")


def _migrate_data_types():
    """
    Backfill new data type columns (DATE, TIME) from old VARCHAR columns.

    This migration:
    1. Converts jobs.scheduled_date (VARCHAR) to DATE
    2. Converts jobs/recurring_schedules start_time/end_time (VARCHAR) to TIME
    3. Once backfilled, the old columns will be dropped and new ones renamed

    Idempotent — safe to run every boot.
    """
    from database.models import Job, RecurringSchedule
    from datetime import datetime, time

    db = SessionLocal()
    try:
        # Backfill jobs.scheduled_date_new from jobs.scheduled_date
        jobs_to_migrate = db.query(Job).filter(Job.scheduled_date_new.is_(None)).all()
        migrated_jobs = 0
        for job in jobs_to_migrate:
            if job.scheduled_date:
                try:
                    # Parse YYYY-MM-DD string to date
                    date_obj = datetime.strptime(job.scheduled_date, "%Y-%m-%d").date()
                    job.scheduled_date_new = date_obj
                    migrated_jobs += 1
                except (ValueError, TypeError):
                    logger.warning(f"[migrate_data_types] Could not parse job {job.id} scheduled_date: {job.scheduled_date}")

        if migrated_jobs > 0:
            db.commit()
            logger.info(f"[migrate_data_types] Migrated {migrated_jobs} job scheduled_dates to DATE type")

        # Backfill jobs.start_time_new / end_time_new
        jobs_time_to_migrate = db.query(Job).filter(Job.start_time_new.is_(None)).all()
        migrated_times = 0
        for job in jobs_time_to_migrate:
            try:
                if job.start_time:
                    start = datetime.strptime(job.start_time, "%H:%M").time()
                    job.start_time_new = start
                if job.end_time:
                    end = datetime.strptime(job.end_time, "%H:%M").time()
                    job.end_time_new = end
                migrated_times += 1
            except (ValueError, TypeError):
                logger.warning(f"[migrate_data_types] Could not parse job {job.id} times: {job.start_time}/{job.end_time}")

        if migrated_times > 0:
            db.commit()
            logger.info(f"[migrate_data_types] Migrated {migrated_times} job times to TIME type")

        # Backfill recurring_schedules times
        recurring_to_migrate = db.query(RecurringSchedule).filter(RecurringSchedule.start_time_new.is_(None)).all()
        migrated_recurring = 0
        for sched in recurring_to_migrate:
            try:
                if sched.start_time:
                    start = datetime.strptime(sched.start_time, "%H:%M").time()
                    sched.start_time_new = start
                if sched.end_time:
                    end = datetime.strptime(sched.end_time, "%H:%M").time()
                    sched.end_time_new = end
                migrated_recurring += 1
            except (ValueError, TypeError):
                logger.warning(f"[migrate_data_types] Could not parse recurring {sched.id} times: {sched.start_time}/{sched.end_time}")

        if migrated_recurring > 0:
            db.commit()
            logger.info(f"[migrate_data_types] Migrated {migrated_recurring} recurring schedule times to TIME type")

    except Exception as exc:
        logger.warning(f"[migrate_data_types] Error during migration: {exc}")
    finally:
        db.close()


def _fix_str_turnover_dates():
    """
    Fix STR turnover dates to account for RFC 5545 DTEND exclusivity.

    This is a Python-based migration (not SQL) because scheduled_date is stored
    as a string. It's idempotent - safe to run on every boot.
    """
    from database.models import Job, ICalEvent
    from datetime import datetime, timedelta

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
                job_date = datetime.strptime(job.scheduled_date, "%Y-%m-%d").date()
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
                event_date = datetime.strptime(event.checkout_date, "%Y-%m-%d").date()
                # Check raw_event to see original DTEND
                # For now, mark as fixed if job is already linked and has correct date
                if event.job_id:
                    job = db.query(Job).filter(Job.id == event.job_id).first()
                    if job and job.scheduled_date:
                        job_date = datetime.strptime(job.scheduled_date, "%Y-%m-%d").date()
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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
