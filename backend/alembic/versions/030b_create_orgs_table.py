"""030b — create the orgs table.

`Org` (database/models.py) backs the whole multi-tenancy system — every
domain table's `org_id` conceptually FKs into it, RLS policies (migration
028) scope on it, and the auth signup/onboarding flow (modules/auth/router.py)
creates rows in it directly. But no migration ever created the table itself:
migration 027 deliberately added `org_id` as a plain, unconstrained integer
column ("FK declared on the ORM side only ... applies cleanly to existing
tables") specifically so it wouldn't need `orgs` to exist yet. That worked
for every migration through 030 — until 031 (quote_sms) declares a real
`sa.ForeignKey("orgs.id")`, which fails outright on a from-scratch replay
because the table was never created by any migration; production only ever
had it via `Base.metadata.create_all()`.

Seeds org id=1 ("Maine Cleaning Co", matching modules/auth/router.py's
existing-workspace signup path) so migration 027's `UPDATE ... SET org_id = 1`
backfill a few migrations back — and any pre-030 data migration that assumed
org 1 existed — points at a real row.
"""
from alembic import op
import sqlalchemy as sa

revision = "030b_create_orgs"
down_revision = "030_backfill_opportunities"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "orgs" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "orgs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("slug", name="uq_orgs_slug"),
    )
    op.execute(sa.text("""
        INSERT INTO orgs (id, name, slug) VALUES (1, 'Maine Cleaning Co', 'maine-cleaning-co')
    """))
    # Postgres: keep the next-id sequence ahead of the seeded row.
    if bind.dialect.name == "postgresql":
        op.execute(sa.text(
            "SELECT setval(pg_get_serial_sequence('orgs', 'id'), 1)"
        ))


def downgrade():
    op.drop_table("orgs")
