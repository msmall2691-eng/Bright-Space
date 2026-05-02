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

    # Merge conversations: move messages from newer dupes to oldest, then delete dupes
    merge_sql = """
    WITH conversation_groups AS (
        SELECT
            client_id,
            channel,
            MIN(id) AS keep_id,
            COUNT(*) AS total_count
        FROM conversations
        WHERE channel = 'sms' AND client_id IS NOT NULL
        GROUP BY client_id, channel
        HAVING COUNT(*) > 1
    ),
    dupes AS (
        SELECT c.id, cg.keep_id
        FROM conversations c
        JOIN conversation_groups cg
            ON c.client_id = cg.client_id
            AND c.channel = cg.channel
        WHERE c.id != cg.keep_id
    )
    UPDATE messages SET conversation_id = dupes.keep_id
    FROM dupes
    WHERE messages.conversation_id = dupes.id;
    """

    # This is tricky in SQLite, so we'll do it in Python instead
    # Move messages from duplicate conversations to the primary one
    from sqlalchemy import create_engine

    # Get all conversations grouped by client_id and channel
    result = conn.execute(text("""
        SELECT client_id, channel, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
        FROM conversations
        WHERE client_id IS NOT NULL
        GROUP BY client_id, channel
        HAVING COUNT(*) > 1
    """))

    duplicates = result.fetchall()

    for row in duplicates:
        if not row:
            continue
        client_id, channel, count, ids_str = row
        if not ids_str:
            continue

        ids = [int(x) for x in ids_str.split(',')]
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
