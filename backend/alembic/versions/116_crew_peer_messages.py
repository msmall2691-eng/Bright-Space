"""Cleaner↔cleaner direct message threads.

Crew chat existed only as cleaner↔office (one thread per cleaner, `crew_messages`,
migration 089). This adds a second, separate table for cleaner↔cleaner threads so
a cleaner can message a teammate directly — coordinate a swap, a ride, "grab my
mop from the van" — without routing it through the office.

WHY ITS OWN TABLE, not a reuse of `crew_messages`: that table is structurally
one-thread-per-cleaner with a `sender` of "cleaner"|"office" — it has no concept
of a second cleaner on the other end. A peer thread is the unordered pair
{from_user_id, to_user_id}; modelling it as its own table keeps both surfaces
simple and keeps the office thread's semantics untouched.

Org-scoped and registered for RLS in this same migration (brightbase-marketplace:
the trap that left tables listed in TENANT_TABLES with no policy behind them).

Revision ID: 116_crew_peer_messages
Revises: 115_sticky_notes
"""
import sqlalchemy as sa
from alembic import op

revision = "116_crew_peer_messages"
down_revision = "115_sticky_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "crew_peer_messages",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("org_id", sa.Integer(), sa.ForeignKey("orgs.id"), nullable=True, index=True),
        # CASCADE on both ends: a deleted account takes its side of the thread
        # with it. A peer message with a vanished author or recipient is not
        # evidence of anything worth keeping (unlike a job photo).
        sa.Column("from_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("to_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("sender_name", sa.String(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("read_at", sa.DateTime(), nullable=True),
    )

    # In the SAME migration that creates the table.
    from database.rls import apply_org_rls
    apply_org_rls(op.get_bind(), ["crew_peer_messages"])


def downgrade() -> None:
    from database.rls import drop_org_rls
    drop_org_rls(op.get_bind(), ["crew_peer_messages"])
    op.drop_table("crew_peer_messages")
