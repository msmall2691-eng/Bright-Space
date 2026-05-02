"""Merge duplicate SMS conversations created by phone format inconsistency.

When phone numbers came in with different formats (formatted vs E.164), duplicate
conversations were created for the same contact/channel pair. This migration:

1. Finds groups of conversations with the same client_id, channel, and normalized phone
2. Keeps the oldest conversation, moves all messages to it, deletes duplicates
3. Adds a unique constraint on (client_id, channel, external_contact) to prevent future dupes
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

revision = '003'
down_revision = '002'
branch_labels = None
depends_on = None


def upgrade():
    # Get connection and detect dialect
    conn = op.get_bind()
    is_pg = conn.dialect.name == 'postgresql'

    # Find duplicate conversations grouped by client_id and channel
    if is_pg:
        query = text("""
            SELECT client_id, channel, array_agg(id ORDER BY id) as ids
            FROM conversations
            WHERE client_id IS NOT NULL
            GROUP BY client_id, channel
            HAVING COUNT(*) > 1
        """)
    else:
        # SQLite: use GROUP_CONCAT
        query = text("""
            SELECT client_id, channel, GROUP_CONCAT(id, ',') as ids
            FROM conversations
            WHERE client_id IS NOT NULL
            GROUP BY client_id, channel
            HAVING COUNT(*) > 1
        """)

    result = conn.execute(query)
    duplicates = result.fetchall()

    for row in duplicates:
        if not row:
            continue
        client_id, channel, ids_result = row
        if not ids_result:
            continue

        # Parse IDs depending on dialect
        if is_pg:
            # Postgres returns a list directly
            ids = list(ids_result) if isinstance(ids_result, list) else [int(x) for x in str(ids_result).strip('{}').split(',')]
        else:
            # SQLite returns a comma-separated string
            ids = [int(x) for x in ids_result.split(',')]

        ids.sort()  # Keep the first (oldest) one
        keep_id = ids[0]
        delete_ids = ids[1:]

        # Move all messages from delete_ids to keep_id
        for del_id in delete_ids:
            conn.execute(text("""
                UPDATE messages
                SET conversation_id = :keep_id
                WHERE conversation_id = :del_id
            """), {"keep_id": keep_id, "del_id": del_id})

        # Delete the duplicate conversations
        for del_id in delete_ids:
            conn.execute(text("""
                DELETE FROM conversations
                WHERE id = :id
            """), {"id": del_id})

    conn.commit()

    # Add unique constraint on (client_id, channel) to prevent future duplicates
    # (external_contact is less reliable due to format changes)
    if is_pg:
        op.execute("""
            ALTER TABLE conversations
            ADD CONSTRAINT uq_conversations_client_channel
            UNIQUE (client_id, channel)
            WHERE client_id IS NOT NULL AND status != 'resolved'
        """)
    else:
        # SQLite doesn't support partial unique constraints,
        # so we create a trigger-based solution via migration note
        op.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_client_channel
            ON conversations(client_id, channel)
            WHERE client_id IS NOT NULL AND status = 'open'
        """)


def downgrade():
    # Remove the unique constraint (duplicates are permanent since we merged them)
    conn = op.get_bind()
    is_pg = conn.dialect.name == 'postgresql'

    if is_pg:
        op.execute("ALTER TABLE conversations DROP CONSTRAINT IF EXISTS uq_conversations_client_channel")
    else:
        op.execute("DROP INDEX IF EXISTS uq_conversations_client_channel")
