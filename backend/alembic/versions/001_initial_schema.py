"""Initial schema creation from ORM models."""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # Create all base tables (idempotent using IF NOT EXISTS)
    op.execute("""
        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY,
            key VARCHAR NOT NULL UNIQUE,
            value VARCHAR,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            email VARCHAR,
            phone VARCHAR,
            address VARCHAR,
            status VARCHAR,
            first_name VARCHAR,
            last_name VARCHAR,
            billing_address VARCHAR,
            billing_city VARCHAR,
            billing_state VARCHAR,
            billing_zip VARCHAR,
            custom_fields VARCHAR,
            client_type VARCHAR,
            lifecycle_stage VARCHAR,
            source_detail VARCHAR,
            last_contacted_at TIMESTAMP,
            email_verified INTEGER,
            phone_tail VARCHAR,
            phone_id INTEGER,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS contact_phones (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            phone VARCHAR,
            type VARCHAR,
            phone_tail VARCHAR,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS contact_emails (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            email VARCHAR,
            type VARCHAR,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS field_definitions (
            id INTEGER PRIMARY KEY,
            entity_type VARCHAR,
            field_name VARCHAR,
            field_type VARCHAR,
            label VARCHAR,
            is_system INTEGER,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS ical_events (
            id INTEGER PRIMARY KEY,
            property_id INTEGER,
            ical_uid VARCHAR,
            ical_source VARCHAR,
            title VARCHAR,
            start_date VARCHAR,
            end_date VARCHAR,
            guest_count INTEGER,
            event_type VARCHAR,
            synced_at TIMESTAMP,
            job_id INTEGER,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS lead_intakes (
            id INTEGER PRIMARY KEY,
            client_id INTEGER,
            opportunity_id INTEGER,
            name VARCHAR NOT NULL,
            email VARCHAR,
            phone VARCHAR,
            address VARCHAR,
            city VARCHAR,
            state VARCHAR,
            zip_code VARCHAR,
            service_type VARCHAR,
            bedrooms INTEGER,
            bathrooms INTEGER,
            square_footage INTEGER,
            guests INTEGER,
            frequency VARCHAR,
            requested_date VARCHAR,
            check_in VARCHAR,
            check_out VARCHAR,
            estimate_min REAL,
            estimate_max REAL,
            property_name VARCHAR,
            message VARCHAR,
            priority VARCHAR,
            status VARCHAR,
            assigned_to VARCHAR,
            internal_notes VARCHAR,
            followed_up_at TIMESTAMP,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS opportunities (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            title VARCHAR,
            amount REAL,
            status VARCHAR,
            custom_fields VARCHAR,
            updated_at TIMESTAMP,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS properties (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            name VARCHAR,
            address VARCHAR,
            property_type VARCHAR,
            check_in_time VARCHAR,
            check_out_time VARCHAR,
            house_code VARCHAR,
            ical_url VARCHAR,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            email VARCHAR,
            name VARCHAR,
            role VARCHAR,
            hashed_password VARCHAR,
            is_active INTEGER,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            title VARCHAR,
            description VARCHAR,
            amount REAL,
            status VARCHAR,
            public_token VARCHAR,
            viewed_at TIMESTAMP,
            intake_id INTEGER,
            quote_number VARCHAR,
            address VARCHAR,
            service_type VARCHAR,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS recurring_schedules (
            id INTEGER PRIMARY KEY,
            job_id INTEGER,
            frequency VARCHAR,
            end_date VARCHAR,
            days_of_week VARCHAR,
            interval_weeks INTEGER,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            property_id INTEGER REFERENCES properties(id),
            quote_id INTEGER REFERENCES quotes(id),
            opportunity_id INTEGER REFERENCES opportunities(id),
            job_type VARCHAR NOT NULL,
            recurring_schedule_id INTEGER REFERENCES recurring_schedules(id),
            ical_event_id INTEGER REFERENCES ical_events(id),
            assigned_cleaner_user_id INTEGER REFERENCES users(id),
            calendar_invite_sent INTEGER NOT NULL,
            sms_reminder_sent INTEGER NOT NULL,
            gcal_event_id VARCHAR,
            title VARCHAR NOT NULL,
            scheduled_date VARCHAR,
            start_time VARCHAR,
            end_time VARCHAR,
            address VARCHAR,
            cleaner_ids VARCHAR,
            status VARCHAR,
            notes VARCHAR,
            custom_fields VARCHAR,
            dispatched INTEGER,
            connecteam_shift_ids VARCHAR,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY,
            job_id INTEGER NOT NULL REFERENCES jobs(id),
            scheduled_date VARCHAR,
            start_time VARCHAR,
            end_time VARCHAR,
            status VARCHAR,
            cleaner_ids VARCHAR,
            gcal_event_id VARCHAR,
            ical_source VARCHAR,
            ical_uid VARCHAR,
            completed_at TIMESTAMP,
            completed_by VARCHAR,
            checklist_results VARCHAR,
            photos VARCHAR,
            notes VARCHAR,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            conversation_id INTEGER REFERENCES conversations(id),
            content VARCHAR,
            sender VARCHAR,
            external_id VARCHAR,
            author VARCHAR,
            is_internal_note INTEGER,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY,
            client_id INTEGER REFERENCES clients(id),
            job_id INTEGER REFERENCES jobs(id),
            amount REAL,
            status VARCHAR,
            custom_fields VARCHAR,
            opportunity_id INTEGER REFERENCES opportunities(id),
            updated_at TIMESTAMP,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_invoice_opportunity_id ON invoices(opportunity_id)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_invoice_updated_at ON invoices(updated_at)
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS property_icals (
            id INTEGER PRIMARY KEY,
            property_id INTEGER NOT NULL REFERENCES properties(id),
            url VARCHAR NOT NULL,
            source VARCHAR,
            active INTEGER,
            last_synced_at TIMESTAMP,
            last_sync_status VARCHAR,
            last_sync_error VARCHAR,
            sync_retry_count INTEGER,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_property_icals_property_id ON property_icals(property_id)
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY,
            entity_type VARCHAR,
            entity_id INTEGER,
            action VARCHAR,
            actor_id INTEGER,
            details VARCHAR,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS integration_events (
            id INTEGER PRIMARY KEY,
            entity_type VARCHAR NOT NULL,
            entity_id INTEGER NOT NULL,
            provider VARCHAR NOT NULL,
            action VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            external_id VARCHAR,
            error_message VARCHAR,
            error_code VARCHAR,
            request_payload VARCHAR,
            response_payload VARCHAR,
            created_at TIMESTAMP
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_integration_events_created_at ON integration_events(created_at)
    """)


def downgrade():
    op.execute("DROP TABLE IF EXISTS integration_events")
    op.execute("DROP TABLE IF EXISTS activities")
    op.execute("DROP TABLE IF EXISTS property_icals")
    op.execute("DROP TABLE IF EXISTS invoices")
    op.execute("DROP TABLE IF EXISTS messages")
    op.execute("DROP TABLE IF EXISTS conversations")
    op.execute("DROP TABLE IF EXISTS visits")
    op.execute("DROP TABLE IF EXISTS jobs")
    op.execute("DROP TABLE IF EXISTS recurring_schedules")
    op.execute("DROP TABLE IF EXISTS quotes")
    op.execute("DROP TABLE IF EXISTS users")
    op.execute("DROP TABLE IF EXISTS properties")
    op.execute("DROP TABLE IF EXISTS opportunities")
    op.execute("DROP TABLE IF EXISTS lead_intakes")
    op.execute("DROP TABLE IF EXISTS ical_events")
    op.execute("DROP TABLE IF EXISTS field_definitions")
    op.execute("DROP TABLE IF EXISTS contact_emails")
    op.execute("DROP TABLE IF EXISTS contact_phones")
    op.execute("DROP TABLE IF EXISTS clients")
    op.execute("DROP TABLE IF EXISTS app_settings")
