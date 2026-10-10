"""Thread identity becomes the person, not the person-and-channel.

Tier 4a, step one. Today a conversation IS a channel: `find_or_create_conversation`
filters on `channel` as its first predicate, and `uq_conversations_client_channel`
(alembic 003) enforces exactly one row per (client_id, channel) in the database.
So a customer who texts and then emails has two threads, and the office reads
half a conversation in each. The redesign's data shape is the inverse — channel
is a property of each MESSAGE (`messages.channel` already exists and is already
written on every row) and a thread is a person.

This migration drops that unique index, and adds the two plain indexes that
have to exist once it is gone (see INDEXES below). No column is added, altered,
renamed or dropped, and no row is read or written.

WHY SO SMALL — the deliberate choice behind it
----------------------------------------------
The owner picked forward-only over a merge. The alternative was to merge each
person's per-channel threads into one on upgrade, which means re-pointing
messages across ~1300 rows, 40% of which carry a NULL org_id (see the census in
modules/comms/router.py's _org() comment block). A merge that groups two
workspaces' rows together because both have NULL org_id is a tenancy breach,
not a display bug — and alembic 003 is this repo's own evidence that merging
conversations cannot be undone.

So nothing is merged. Existing threads stay exactly as they are; the new lookup
simply stops splitting by channel, and each person's threads converge as new
messages arrive. For a while the inbox shows some people with both an old SMS
thread and an old email thread. That is the price, and it is visible rather
than destructive.

INDEXES — the part that is not optional
---------------------------------------
`conversations` really has only three indexes: the pkey, org_id, and
assignee_user_id. It has NO index on client_id and NO index on
external_contact, even though models.py declares `index=True` on both — the
table was created by raw SQL in alembic 001, which never emitted them, and
`alembic check` reports the same drift for eight columns on this table alone.

So the dropped unique index was the ONLY index covering client_id, and
find_or_create_conversation's lookup runs on EVERY inbound message. Dropping it
alone would have turned the hottest read in the comms path into a full table
scan — on Postgres, in production, where nothing local would have shown it.

This migration therefore creates ix_conversations_client_id and
ix_conversations_external_contact. Both are exactly what the model already
claims, so this reduces drift rather than adding to it. Plain CREATE INDEX, not
CONCURRENTLY: the tables are small (~126 conversations, ~1300 messages), so the
lock is momentary and keeping the migration transactional is worth more than
avoiding it.

`messages` needs one too, for the same reason in a different place. The inbox's
channel tabs can no longer ask "what channel is this thread?" — a thread holds
every channel now — so list_conversations asks "does this thread CONTAIN a
message on that channel?" instead. That is an EXISTS over `messages`, and
`messages` has no index on conversation_id (declared `index=True` on the model,
never created) and none on channel. Unindexed, that EXISTS scans the whole
messages table once per conversation row on every inbox load. So:
ix_messages_conversation_id_channel, which serves the filter and also the plain
conversation_id lookup that opening any thread performs.

The other six drifted indexes on this table are pre-existing and not made worse
by this change, so they are left alone rather than quietly widening a migration
that is meant to do one thing.

SCHEMA GUARDIAN
---------------
- No new table, so no org_id/TENANT_TABLES/apply_org_rls work. `conversations`
  and `messages` are already registered (database/rls.py).
- No money column, no date column.
- FK indexes: covered above. This is §4, and it was nearly missed.
- `messages.channel` stays NULLABLE. Channel becomes authoritative per-message
  in BEHAVIOUR, not as a constraint: adding NOT NULL to a populated column in
  one release is exactly what the expand/contract rule forbids. If it is ever
  wanted, it is a later release after a backfill.
- No access detail is copied anywhere.
- scheduling-invariants checked and does not apply: no job, visit, recurring
  row or calendar projection is touched. `messages.job_id` is a back-reference
  and is not read or written here.

DEPLOY
------
Additive in effect (a constraint is removed, nothing is required), so old code
keeps working against the new schema. One nuance worth knowing in the window
between this landing and the new code being live: the old
`find_or_create_conversation` still filters on channel and relies on an
IntegrityError arm as its race recovery. With the index gone that arm stops
firing, so a genuine concurrent race could leave two (client_id, channel) rows
instead of one. Harmless — the new lookup returns the older of them and the
other goes quiet — and the window is one container restart.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "131_conversation_thread_per_person"
down_revision: Union[str, None] = "130_user_vetting_override"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Raw SQL rather than op.drop_index/op.create_index, matching alembic 003 which
# created this index the same way: it is a PARTIAL unique index, and the
# `postgresql_where=` kwarg has no SQLite equivalent, so one statement that
# both dialects accept is less to get wrong than two branches.
_INDEX = "uq_conversations_client_channel"

_DUPES_SQL = sa.text(f"""
    SELECT COUNT(*) FROM (
        SELECT client_id, channel
        FROM conversations
        WHERE client_id IS NOT NULL
        GROUP BY client_id, channel
        HAVING COUNT(*) > 1
    ) d
""")


def upgrade() -> None:
    bind = op.get_bind()
    # Order matters only for clarity: create the replacements first so there is
    # never an instant where no index covers client_id.
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_conversations_client_id "
        "ON conversations (client_id)"
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_conversations_external_contact "
        "ON conversations (external_contact)"
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_messages_conversation_id_channel "
        "ON messages (conversation_id, channel)"
    ))
    bind.execute(sa.text(f"DROP INDEX IF EXISTS {_INDEX}"))


def downgrade() -> None:
    """Restore the index — UNIQUE when that is still truthful, plain when it is not.

    This is the honest version of a downgrade that cannot be guaranteed clean.
    The moment the new code has run, a person can legitimately hold two rows
    for the same channel (the pre-existing SMS thread plus one that absorbed
    their email), and re-asserting UNIQUE over that would abort the downgrade
    partway — the worst outcome for whoever is running it at 11pm.

    So: count the duplicates first.

      none  -> re-create the index exactly as alembic 003 made it. This is the
               case the pre-flight round-trip exercises (upgrade, downgrade,
               upgrade), so the normal path restores the original schema
               byte-for-byte.

      some  -> re-create it NON-unique and say so, loudly. The shape and the
               lookup performance come back; the guarantee does not, because
               restoring it would mean merging rows, and merging conversations
               is irreversible (alembic 003). Nothing is deleted and nothing is
               silently dropped.

    To get the UNIQUE guarantee back deliberately, find the offenders with the
    query in _DUPES_SQL, merge them the way alembic 003 does, then re-run this
    downgrade — it will take the clean path.

    The two indexes upgrade() added are dropped again, so the round-trip ends
    on the schema it started from rather than a slightly better one. They are
    genuinely useful and the model asks for them, so a re-upgrade brings them
    straight back; adding them for good belongs in its own migration alongside
    the other six this table is missing, not smuggled in via a downgrade.
    """
    bind = op.get_bind()
    dupes = bind.execute(_DUPES_SQL).scalar() or 0

    bind.execute(sa.text(f"DROP INDEX IF EXISTS {_INDEX}"))
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_conversations_client_id"))
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_conversations_external_contact"))
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_messages_conversation_id_channel"))

    if dupes:
        print(
            f"[131] {dupes} (client_id, channel) group(s) now hold more than one "
            f"conversation, so {_INDEX} is being restored WITHOUT uniqueness. "
            "Merge those threads and re-run this downgrade to restore the "
            "original UNIQUE index."
        )
        bind.execute(sa.text(
            f"CREATE INDEX IF NOT EXISTS {_INDEX} ON conversations (client_id, channel)"
        ))
    else:
        bind.execute(sa.text(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {_INDEX} "
            "ON conversations (client_id, channel) WHERE client_id IS NOT NULL"
        ))
