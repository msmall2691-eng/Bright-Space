"""Merge duplicate SMS conversations created by phone format inconsistency.

When phone numbers came in with different formats (formatted vs E.164), duplicate
conversations were created for the same contact/channel pair. This migration:

1. Finds groups of conversations with the same client_id, channel
2. Keeps the oldest conversation, moves all messages to it, deletes duplicates
3. Adds a unique constraint to prevent future dupes
"""
from alembic import op
from sqlalchemy import text

revision = '003'
down_revision = '002'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    is_pg = bind.dialect.name == 'postgresql'

    # Find duplicate conversations grouped by (client_id, channel)
    if is_pg:
        find_dupes = text("""
            SELECT client_id, channel, array_agg(id ORDER BY id) as ids
            FROM conversations
            WHERE client_id IS NOT NULL
            GROUP BY client_id, channel
            HAVING COUNT(*) > 1
        """)
    else:
        find_dupes = text("""
            SELECT client_id, channel, GROUP_CONCAT(id, ',') as ids
            FROM conversations
            WHERE client_id IS NOT NULL
            GROUP BY client_id, channel
            HAVING COUNT(*) > 1
        """)

    rows = bind.execute(find_dupes).fetchall()

    for row in rows:
        client_id, channel, ids_result = row
        # Parse IDs: Postgres returns list, SQLite returns comma-separated string
        if is_pg:
            ids = list(ids_result) if isinstance(ids_result, list) else [int(x) for x in str(ids_result).strip('{}').split(',')]
        else:
            ids = [int(x) for x in ids_result.split(',')]

        keep_id = ids[0]  # Oldest
        for del_id in ids[1:]:  # Newer duplicates
            # Move messages to the keeper conversation
            bind.execute(text("UPDATE messages SET conversation_id = :keep WHERE conversation_id = :del"),
                        {"keep": keep_id, "del": del_id})
            # Delete the duplicate conversation
            bind.execute(text("DELETE FROM conversations WHERE id = :id"), {"id": del_id})

    # Add unique constraint to prevent future duplicates
    # PostgreSQL: partial unique index (WHERE not supported on UNIQUE constraint)
    # SQLite: also uses partial unique index
    bind.execute(text("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_client_channel
        ON conversations (client_id, channel)
        WHERE client_id IS NOT NULL
    """))


def downgrade():
    bind = op.get_bind()
    bind.execute(text("DROP INDEX IF EXISTS uq_conversations_client_channel"))

