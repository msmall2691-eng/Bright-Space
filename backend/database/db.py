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


def _run_migrations():
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
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
