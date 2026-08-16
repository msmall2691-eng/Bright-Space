"""Backfill Postgres RLS onto user_google_accounts and push_subscriptions.

MT-3 audit: both tables carry org_id (migrations 049-ish era and 062
respectively) but were never added to TENANT_TABLES / never had
apply_org_rls() called for them, so on Postgres they've had NO row-level
security backstop at all since the day they were created — any unscoped
query would see every workspace's rows. Their application-layer queries
already filter by org_id everywhere (modules/push/router.py's
Depends(current_org_id) dependency; modules/auth/router.py's Google-account
lookups keyed off the owning user), so this is a pure backstop with no
expected behavior change for legitimate reads.

`users` deliberately is NOT included here. Its org_id column is nullable
(pre-MT-4 accounts predate self-signup and may still be NULL), and unlike
the app-level `_org()` filter — which is deliberately NULL-tolerant so a
legacy row is visible to every org — this policy's USING clause has no such
carve-out: once `app.current_org_id` is set, a NULL-org row satisfies
neither `org_id = <org>` nor `current_setting(...) IS NULL`, so it becomes
invisible. Flipping that on for `users` risks silently locking a legacy
admin/staff account out the moment any org-scoped request runs, and the
~25 `db.query(User)` call sites across auth/crew/payroll/dispatch/comms/
dashboard haven't all been individually audited for org-scoping in this
pass. Needs a dedicated follow-up: confirm no NULL-org user rows in
production (or backfill them), audit each User query site, then add a
migration mirroring this one for `users`.

Revision ID: 095_rls_backfill_ugauth_push
Revises: 094_user_notification_prefs
"""
from alembic import op


revision = "095_rls_backfill_ugauth_push"
down_revision = "094_user_notification_prefs"
branch_labels = None
depends_on = None

_TABLES = ["user_google_accounts", "push_subscriptions"]


def upgrade() -> None:
    # Postgres-only, best-effort (mirrors migrations 070/081/083/085/086/
    # 087/089/090/091's pattern). No-op on SQLite.
    try:
        from database.rls import apply_org_rls
        apply_org_rls(op.get_bind(), tables=_TABLES)
    except Exception:
        pass


def downgrade() -> None:
    try:
        from database.rls import drop_org_rls
        drop_org_rls(op.get_bind(), tables=_TABLES)
    except Exception:
        pass
