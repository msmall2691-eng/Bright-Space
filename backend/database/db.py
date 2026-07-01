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
    # Note: Schema creation and migrations are now handled by Alembic.
    # The 'alembic upgrade head' command runs before the app starts,
    # ensuring the database schema is up-to-date. See alembic/versions/
    # for the migration history.
    try:
        _run_migrations()
    except Exception as e:
        logger.warning(f"Schema migration failed (non-critical): {e}")

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
        # PR 1: VARCHAR->DATE conversion (one-time, completed in prod 2026-04).
        # The ADD+DROP+RENAME pair below had NO data-copy step, so each boot
        # silently wiped Job.scheduled_date / start_time / end_time. The Visit
        # table preserved dates so list views still worked, but /api/jobs/{id},
        # recurring upcoming counts, and any direct Job.scheduled_date read
        # returned NULL. Disabled until needed for a fresh deploy.
        # "ALTER TABLE jobs ADD COLUMN scheduled_date_new DATE",
        # "ALTER TABLE jobs ADD COLUMN start_time_new TIME",
        # "ALTER TABLE jobs ADD COLUMN end_time_new TIME",
        # "ALTER TABLE recurring_schedules ADD COLUMN start_time_new TIME",
        # "ALTER TABLE recurring_schedules ADD COLUMN end_time_new TIME",
        # PR 3: Quote traceability — track when client views quote
        "ALTER TABLE quotes ADD COLUMN viewed_at TIMESTAMP",
        # Quote delivery visibility: failed sends must be visible, not silent drafts
        "ALTER TABLE quotes ADD COLUMN last_send_attempt_at TIMESTAMP",
        "ALTER TABLE quotes ADD COLUMN last_send_error TEXT",
        # Customer-facing intro message on quotes (public page + email)
        "ALTER TABLE quotes ADD COLUMN customer_message TEXT",
        # Operator-only quote notes; `notes` stays customer-facing scope
        "ALTER TABLE quotes ADD COLUMN internal_notes TEXT",
        # PR 4: Visits table (created by create_all, but ensure indexes)
        # (Visits table is created by SQLAlchemy Base.metadata.create_all above)
        # PR 6: iCal feeds sync status tracking
        "ALTER TABLE property_icals ADD COLUMN last_sync_status TEXT",
        "ALTER TABLE property_icals ADD COLUMN last_sync_error TEXT",
        "ALTER TABLE property_icals ADD COLUMN sync_retry_count INTEGER DEFAULT 0",
        "ALTER TABLE quotes ADD COLUMN intake_id INTEGER REFERENCES lead_intakes(id)",
        "ALTER TABLE quotes ADD COLUMN quote_number TEXT",
        "ALTER TABLE quotes ADD COLUMN address TEXT",
        "ALTER TABLE quotes ADD COLUMN service_type TEXT",
        # Carry the customer's stated cleaning cadence from the lead onto the
        # quote, so a won quote can pre-fill the recurring-plan setup.
        "ALTER TABLE quotes ADD COLUMN frequency TEXT",
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
        # CRM enrichment: client lifecycle and contact tracking.
        # (client_type column removed by migration 007 — derive from properties.)
        # (lifecycle_stage dropped by migration 036 — derive from opportunities.)
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
        # CRM cleanup: support commercial property fields and improve property data model
        "ALTER TABLE properties ADD COLUMN business_name TEXT",
        "ALTER TABLE properties ADD COLUMN hours_of_operation TEXT",
        "ALTER TABLE properties ADD COLUMN default_crew_size INTEGER",
        "ALTER TABLE properties ADD COLUMN access_notes TEXT",
        "ALTER TABLE properties ADD COLUMN parking_notes TEXT",
        "ALTER TABLE properties ADD COLUMN timezone TEXT",
        # Schema redesign: site contact fields (different from billing client)
        "ALTER TABLE properties ADD COLUMN site_contact_name TEXT",
        "ALTER TABLE properties ADD COLUMN site_contact_phone TEXT",
        "ALTER TABLE properties ADD COLUMN site_contact_email TEXT",
        # Backfill NULL property_type values to 'residential'
        "UPDATE properties SET property_type = 'residential' WHERE property_type IS NULL OR property_type = ''",
        # Per-booking SMS reminder suppression (hybrid: reminders on by default,
        # staff can opt a single job out). Default 0/FALSE = still reminded.
        f"ALTER TABLE jobs ADD COLUMN skip_sms_reminder {bool_col}",
        # Public (no-login) quote accept link token.
        "ALTER TABLE quotes ADD COLUMN public_token VARCHAR(64)",
        # Cleaner time-off (availability). New table — created idempotently here
        # so it exists on boot regardless of alembic state (see migration 017).
        # id is dialect-aware: SERIAL auto-increments on Postgres, INTEGER PK
        # auto-increments on SQLite (tests).
        f"""CREATE TABLE IF NOT EXISTS cleaner_time_off (
            id {"SERIAL" if is_pg else "INTEGER"} PRIMARY KEY,
            cleaner_id VARCHAR NOT NULL,
            cleaner_name VARCHAR,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            reason VARCHAR,
            created_at TIMESTAMP
        )""",
        "CREATE INDEX IF NOT EXISTS idx_cleaner_timeoff_lookup ON cleaner_time_off (cleaner_id, start_date, end_date)",
        # Google sign-in (SSO): per-user Google identity + nullable password.
        "ALTER TABLE users ADD COLUMN google_sub TEXT",
        "ALTER TABLE users ADD COLUMN auth_provider TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)",
        # ── Workspaces & per-user Google accounts (M0, June 2026) ──
        # Additive only; see docs/auth-workspaces-plan-2026-06.md. v1 is
        # single-org: org 1 is seeded below and every existing user joins it.
        f"""CREATE TABLE IF NOT EXISTS orgs (
            id {"SERIAL" if is_pg else "INTEGER"} PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            slug VARCHAR(64) NOT NULL UNIQUE,
            created_at TIMESTAMP
        )""",
        f"""CREATE TABLE IF NOT EXISTS user_google_accounts (
            id {"SERIAL" if is_pg else "INTEGER"} PRIMARY KEY,
            user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            org_id INTEGER NOT NULL REFERENCES orgs(id),
            google_sub VARCHAR(64) NOT NULL,
            email VARCHAR(255) NOT NULL,
            access_token TEXT,
            refresh_token TEXT,
            token_expiry TIMESTAMP,
            scopes {"JSON" if is_pg else "TEXT"} DEFAULT '[]',
            status VARCHAR(16) NOT NULL DEFAULT 'connected',
            gmail_sync_enabled {bool_col},
            gmail_history_id VARCHAR(32),
            gcal_sync_enabled {bool_col},
            gcal_calendar_id VARCHAR(255),
            gcal_sync_token TEXT,
            last_sync_at TIMESTAMP,
            last_sync_error TEXT,
            connected_at TIMESTAMP,
            UNIQUE (org_id, google_sub)
        )""",
        # users: workspace membership + approval workflow
        "ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES orgs(id)",
        "ALTER TABLE users ADD COLUMN status VARCHAR(16) DEFAULT 'active'",
        "ALTER TABLE users ADD COLUMN approved_by INTEGER REFERENCES users(id)",
        "ALTER TABLE users ADD COLUMN approved_at TIMESTAMP",
        # Per-user sync provenance (phase C reads these; NULL = legacy shared account)
        "ALTER TABLE conversations ADD COLUMN synced_by_google_account_id INTEGER REFERENCES user_google_accounts(id)",
        "ALTER TABLE messages ADD COLUMN synced_by_google_account_id INTEGER REFERENCES user_google_accounts(id)",
        "ALTER TABLE jobs ADD COLUMN gcal_account_id INTEGER REFERENCES user_google_accounts(id)",
        # Seed + backfill (idempotent): one workspace, everyone in it, active.
        "INSERT INTO orgs (name, slug, created_at) SELECT 'Maine Cleaning Co', 'maine-cleaning-co', CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM orgs)",
        "UPDATE users SET status = 'active' WHERE status IS NULL",
        "UPDATE users SET org_id = (SELECT MIN(id) FROM orgs) WHERE org_id IS NULL",
    ]

    # Dialect-aware backfill migrations
    if is_pg:
        backfill_migrations = [
            # PR 1: DROP+RENAME paired with the ADD above. DISABLED because
            # boot N would (a) ADD a fresh empty _new column, (b) DROP the
            # populated scheduled_date column, (c) RENAME the empty _new
            # column into its place — wiping all Job.scheduled_date values.
            # The index create is idempotent and kept.
            # "ALTER TABLE jobs DROP COLUMN IF EXISTS scheduled_date CASCADE",
            # "ALTER TABLE jobs RENAME COLUMN scheduled_date_new TO scheduled_date",
            # "ALTER TABLE jobs DROP COLUMN IF EXISTS start_time CASCADE",
            # "ALTER TABLE jobs RENAME COLUMN start_time_new TO start_time",
            # "ALTER TABLE jobs DROP COLUMN IF EXISTS end_time CASCADE",
            # "ALTER TABLE jobs RENAME COLUMN end_time_new TO end_time",
            "CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_date ON jobs(scheduled_date)",
            # Workspaces M0 follow-up (Codex P2 on #266): the provenance FKs
            # were first created WITHOUT ON DELETE SET NULL, so deleting a
            # user (CASCADE through user_google_accounts) could violate them.
            # Rebuild each constraint with SET NULL, idempotently: look up
            # whatever the live constraint is called, drop it, re-add.
            """DO $$
            DECLARE c text;
            BEGIN
              SELECT tc.constraint_name INTO c
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
              WHERE tc.table_name='messages' AND tc.constraint_type='FOREIGN KEY'
                AND kcu.column_name='synced_by_google_account_id';
              IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', c); END IF;
              ALTER TABLE messages ADD CONSTRAINT messages_synced_by_google_account_id_fkey
                FOREIGN KEY (synced_by_google_account_id) REFERENCES user_google_accounts(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$""",
            """DO $$
            DECLARE c text;
            BEGIN
              SELECT tc.constraint_name INTO c
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
              WHERE tc.table_name='conversations' AND tc.constraint_type='FOREIGN KEY'
                AND kcu.column_name='synced_by_google_account_id';
              IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', c); END IF;
              ALTER TABLE conversations ADD CONSTRAINT conversations_synced_by_google_account_id_fkey
                FOREIGN KEY (synced_by_google_account_id) REFERENCES user_google_accounts(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$""",
            """DO $$
            DECLARE c text;
            BEGIN
              SELECT tc.constraint_name INTO c
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
              WHERE tc.table_name='jobs' AND tc.constraint_type='FOREIGN KEY'
                AND kcu.column_name='gcal_account_id';
              IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', c); END IF;
              ALTER TABLE jobs ADD CONSTRAINT jobs_gcal_account_id_fkey
                FOREIGN KEY (gcal_account_id) REFERENCES user_google_accounts(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$""",
            # Same fix for activities.message_id: deleting a message (SMS or
            # email) must orphan its timeline entry, not raise.
            """DO $$
            DECLARE c text;
            BEGIN
              SELECT tc.constraint_name INTO c
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
              WHERE tc.table_name='activities' AND tc.constraint_type='FOREIGN KEY'
                AND kcu.column_name='message_id';
              IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE activities DROP CONSTRAINT %I', c); END IF;
              ALTER TABLE activities ADD CONSTRAINT activities_message_id_fkey
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$""",
            # "ALTER TABLE recurring_schedules DROP COLUMN IF EXISTS start_time CASCADE",
            # "ALTER TABLE recurring_schedules RENAME COLUMN start_time_new TO start_time",
            # "ALTER TABLE recurring_schedules DROP COLUMN IF EXISTS end_time CASCADE",
            # "ALTER TABLE recurring_schedules RENAME COLUMN end_time_new TO end_time",
            # Backfill existing biweekly schedules with interval_weeks=2
            "UPDATE recurring_schedules SET interval_weeks = 2 WHERE frequency = 'biweekly'",
            # Google SSO: allow passwordless (Google-only) users.
            "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL",
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
