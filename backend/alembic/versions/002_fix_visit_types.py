"""Fix Visit table data types to match SQLAlchemy models."""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '002'
down_revision = '001'
branch_labels = None
depends_on = None


def upgrade():
    # Convert visits table columns to proper types
    # SQLite doesn't support ALTER COLUMN type, so we need to recreate the table
    # For PostgreSQL, we can use ALTER COLUMN ... TYPE
    
    # Check if we're using SQLite or PostgreSQL
    from sqlalchemy import inspect
    from sqlalchemy import engine_from_config
    from alembic import context
    
    config = context.config
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=None,
    )
    
    inspector = inspect(connectable)
    db_type = connectable.dialect.name
    
    if db_type == 'sqlite':
        # For SQLite, recreate table with proper column types
        op.execute("""
            CREATE TABLE visits_new (
                id INTEGER PRIMARY KEY,
                job_id INTEGER NOT NULL REFERENCES jobs(id),
                scheduled_date DATE NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                status VARCHAR,
                cleaner_ids JSON,
                gcal_event_id VARCHAR,
                ical_source VARCHAR,
                ical_uid VARCHAR,
                ical_synced_at TIMESTAMP,
                completed_at TIMESTAMP,
                completed_by VARCHAR,
                notes VARCHAR,
                checklist_results JSON,
                photos JSON,
                created_at TIMESTAMP,
                updated_at TIMESTAMP,
                sequence INTEGER,
                checklist_template_id INTEGER
            )
        """)
        
        op.execute("""
            INSERT INTO visits_new 
            SELECT 
                id, job_id, scheduled_date, start_time, end_time, status, cleaner_ids,
                gcal_event_id, ical_source, ical_uid, ical_synced_at, completed_at,
                completed_by, notes, checklist_results, photos, created_at, updated_at,
                sequence, checklist_template_id
            FROM visits
        """)
        
        op.execute("DROP TABLE visits")
        op.execute("ALTER TABLE visits_new RENAME TO visits")
        
        # Recreate indices
        op.execute("CREATE INDEX idx_visits_date ON visits(scheduled_date)")
        op.execute("CREATE INDEX idx_visits_status ON visits(status)")
        op.execute("CREATE INDEX idx_visit_scheduled_date_status ON visits(scheduled_date, status)")
        op.execute("CREATE INDEX idx_visit_job_date ON visits(job_id, scheduled_date)")
        
    elif db_type == 'postgresql':
        # For PostgreSQL, use ALTER COLUMN
        op.execute("ALTER TABLE visits ALTER COLUMN scheduled_date TYPE DATE USING scheduled_date::date")
        op.execute("ALTER TABLE visits ALTER COLUMN start_time TYPE TIME USING start_time::time")
        op.execute("ALTER TABLE visits ALTER COLUMN end_time TYPE TIME USING end_time::time")
        op.execute("ALTER TABLE visits ALTER COLUMN cleaner_ids TYPE JSON USING cleaner_ids::json")
        op.execute("ALTER TABLE visits ALTER COLUMN checklist_results TYPE JSON USING checklist_results::json")
        op.execute("ALTER TABLE visits ALTER COLUMN photos TYPE JSON USING photos::json")


def downgrade():
    # Downgrade is difficult without data loss, so we'll just reverse type conversions
    from sqlalchemy import inspect
    from sqlalchemy import engine_from_config
    from alembic import context
    
    config = context.config
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=None,
    )
    
    inspector = inspect(connectable)
    db_type = connectable.dialect.name
    
    if db_type == 'postgresql':
        # For PostgreSQL, convert back to VARCHAR
        op.execute("ALTER TABLE visits ALTER COLUMN scheduled_date TYPE VARCHAR")
        op.execute("ALTER TABLE visits ALTER COLUMN start_time TYPE VARCHAR")
        op.execute("ALTER TABLE visits ALTER COLUMN end_time TYPE VARCHAR")
        op.execute("ALTER TABLE visits ALTER COLUMN cleaner_ids TYPE VARCHAR")
        op.execute("ALTER TABLE visits ALTER COLUMN checklist_results TYPE VARCHAR")
        op.execute("ALTER TABLE visits ALTER COLUMN photos TYPE VARCHAR")
