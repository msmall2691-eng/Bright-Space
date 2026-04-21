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
        # Flexible recurring intervals: "every N weeks" instead of just weekly/biweekly
        "ALTER TABLE recurring_schedules ADD COLUMN interval_weeks INTEGER NOT NULL DEFAULT 1",
    ]

    backfill_migrations = [
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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
