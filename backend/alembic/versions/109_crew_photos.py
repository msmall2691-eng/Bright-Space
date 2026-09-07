"""A headshot the customer sees before somebody walks into their house.

WHY THIS IS ITS OWN TABLE, not a column on `users`: `User` rows are bulk-
fetched on nearly every screen in the app (dispatch, payroll, the bench, every
`cleaner_ids` lookup). Image bytes on that row would ride along on all of it.
This is the same reasoning `job_photos` records for itself, and the same
storage decision for the same reason — Railway's container disk is ephemeral
and there is no object store configured, so Postgres is the photo store at
this shop's scale.

UNIQUE on `user_id`: one face per person. Uploading again replaces; there is
no gallery here and no history worth keeping.

WHAT THIS IS FOR. A subcontractor is a stranger to the customer in a way an
employee of eight years is not, and the customer has no say in who is sent —
the office cannot let them choose, because choosing is assigning. Showing the
name and face of the person who ALREADY won the job is the one thing that can
be offered without touching that: the customer sees, and never picks.

Consent is the upload. A cleaner adds their own photo from the crew app's Me
tab, on a screen that says in plain words that customers see it, and removing
it removes it everywhere. There is no office upload path — a photo of somebody
put there by their client is not consent — though the office CAN delete one,
because "take that down" must not wait for the person who posted it.

Revision ID: 109_crew_photos
Revises: 108_stripe_connect
"""
import sqlalchemy as sa
from alembic import op

revision = "109_crew_photos"
down_revision = "108_stripe_connect"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "crew_photos",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        # CASCADE: a deleted account takes its face with it. Nothing else
        # references this row, and a headshot with no person is not evidence
        # of anything — unlike a job photo, which is completion evidence and
        # survives its uploader.
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, unique=True, index=True),
        # Sniffed from the bytes on upload, never the client's header — this
        # value is served back to a browser as the Content-Type.
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )

    # In the SAME migration that creates the table (brightbase-marketplace: the
    # trap that left sixteen tables listed in TENANT_TABLES with no policy
    # behind them for months).
    from database.rls import apply_org_rls
    apply_org_rls(op.get_bind(), ["crew_photos"])


def downgrade() -> None:
    from database.rls import drop_org_rls
    drop_org_rls(op.get_bind(), ["crew_photos"])
    op.drop_table("crew_photos")
