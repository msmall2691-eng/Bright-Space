"""Add Property Intelligence System

Revision ID: 012_add_property_profiles
Revises: 011_property_checklist_template
Create Date: 2026-05-26 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '012_add_property_profiles'
down_revision = '011_property_checklist_template'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create ENUM types
    property_type_enum = postgresql.ENUM('residential', 'commercial', 'rental', name='property_type_enum')
    property_type_enum.create(op.get_bind(), checkfirst=True)

    access_type_enum = postgresql.ENUM('entry_code', 'landlord', 'tenant', 'key_pickup', 'other', name='access_type_enum')
    access_type_enum.create(op.get_bind(), checkfirst=True)

    construction_type_enum = postgresql.ENUM('carpet', 'hardwood', 'tile', 'laminate', 'mixed', 'concrete', name='construction_type_enum')
    construction_type_enum.create(op.get_bind(), checkfirst=True)

    photo_type_enum = postgresql.ENUM('before', 'during', 'after', 'reference', name='photo_type_enum')
    photo_type_enum.create(op.get_bind(), checkfirst=True)

    # Create property_profiles table
    op.create_table(
        'property_profiles',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('client_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('address', sa.String(255), nullable=False),
        sa.Column('city', sa.String(100)),
        sa.Column('state', sa.String(2)),
        sa.Column('zip_code', sa.String(10)),
        sa.Column('lat', sa.Numeric(precision=10, scale=8)),
        sa.Column('lng', sa.Numeric(precision=11, scale=8)),
        sa.Column('property_type', property_type_enum, nullable=False, server_default='residential'),
        sa.Column('square_footage', sa.Integer()),
        sa.Column('bedrooms', sa.Integer()),
        sa.Column('bathrooms', sa.Integer()),
        sa.Column('construction_type', construction_type_enum),
        sa.Column('access_type', access_type_enum),
        sa.Column('access_instructions', sa.Text()),
        sa.Column('hazard_notes', sa.Text()),
        sa.Column('pet_alerts', sa.Text()),
        sa.Column('equipment_required', postgresql.ARRAY(sa.String()), server_default=sa.text("'{}'::text[]")),
        sa.Column('avg_condition_rating', sa.Numeric(precision=3, scale=2)),
        sa.Column('condition_notes', sa.Text()),
        sa.Column('complexity_score', sa.Integer()),
        sa.Column('historical_avg_time_minutes', sa.Integer()),
        sa.Column('historical_sample_size', sa.Integer(), server_default='0'),
        sa.Column('time_confidence_interval', sa.Numeric(precision=3, scale=2)),
        sa.Column('last_service_date', sa.Date()),
        sa.Column('photos_count', sa.Integer(), server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('client_id', 'address', name='uq_property_client_address'),
        sa.CheckConstraint('avg_condition_rating >= 1 AND avg_condition_rating <= 5', name='ck_property_profiles_rating'),
        sa.CheckConstraint('complexity_score >= 1 AND complexity_score <= 10', name='ck_property_profiles_complexity'),
    )
    op.create_index('idx_property_profiles_client_id', 'property_profiles', ['client_id'])
    op.create_index('idx_property_profiles_property_type', 'property_profiles', ['property_type'])
    op.create_index('idx_property_profiles_coordinates', 'property_profiles', ['lat', 'lng'])
    op.create_index('idx_property_profiles_complexity', 'property_profiles', ['complexity_score'])

    # Create property_photos table
    op.create_table(
        'property_photos',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('property_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('job_id', postgresql.UUID(as_uuid=True)),
        sa.Column('photo_url', sa.String(512), nullable=False),
        sa.Column('photo_type', photo_type_enum, nullable=False),
        sa.Column('room_name', sa.String(100)),
        sa.Column('uploaded_by_crew_id', postgresql.UUID(as_uuid=True)),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['property_id'], ['property_profiles.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['uploaded_by_crew_id'], ['crews.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_property_photos_property_id', 'property_photos', ['property_id'])
    op.create_index('idx_property_photos_job_id', 'property_photos', ['job_id'])
    op.create_index('idx_property_photos_uploaded_at', 'property_photos', ['uploaded_at'])

    # Create time_estimates_history table
    op.create_table(
        'time_estimates_history',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('property_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('job_id', postgresql.UUID(as_uuid=True)),
        sa.Column('estimated_time_minutes', sa.Integer(), nullable=False),
        sa.Column('actual_time_minutes', sa.Integer()),
        sa.Column('crew_size', sa.Integer()),
        sa.Column('crew_id', postgresql.UUID(as_uuid=True)),
        sa.Column('property_condition_rating', sa.Integer()),
        sa.Column('equipment_used', postgresql.ARRAY(sa.String()), server_default=sa.text("'{}'::text[]")),
        sa.Column('notes', sa.Text()),
        sa.Column('recorded_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(['crew_id'], ['crews.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['property_id'], ['property_profiles.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_time_estimates_property_id', 'time_estimates_history', ['property_id'])
    op.create_index('idx_time_estimates_job_id', 'time_estimates_history', ['job_id'])
    op.create_index('idx_time_estimates_recorded_at', 'time_estimates_history', ['recorded_at'])

    # Create trigger function for auto-updating updated_at
    op.execute("""
    CREATE OR REPLACE FUNCTION update_property_profiles_timestamp()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    """)

    op.execute("""
    CREATE TRIGGER set_property_profiles_timestamp
    BEFORE UPDATE ON property_profiles
    FOR EACH ROW EXECUTE FUNCTION update_property_profiles_timestamp();
    """)


def downgrade() -> None:
    # Drop trigger
    op.execute("DROP TRIGGER IF EXISTS set_property_profiles_timestamp ON property_profiles;")
    op.execute("DROP FUNCTION IF EXISTS update_property_profiles_timestamp();")

    # Drop tables
    op.drop_table('time_estimates_history')
    op.drop_table('property_photos')
    op.drop_table('property_profiles')

    # Drop ENUM types
    op.execute("DROP TYPE IF EXISTS photo_type_enum;")
    op.execute("DROP TYPE IF EXISTS construction_type_enum;")
    op.execute("DROP TYPE IF EXISTS access_type_enum;")
    op.execute("DROP TYPE IF EXISTS property_type_enum;")
