"""Actually apply RLS to every table TENANT_TABLES claims is protected.

Being in TENANT_TABLES does nothing on its own. The list is only a list; the
policy exists when something calls apply_org_rls(). Across the whole history
that happens in exactly six migrations — 028, 068, 069, 070, 091, 095 — and
028 (the original sweep) ran long before most of these tables existed.
apply_org_rls skips tables that aren't there yet (database/rls.py: `if table
not in existing: continue`), so a table created later and added to the list
never picks up a policy unless its own migration calls the function.

Seven of them didn't. Migrations 097-102 created job_claim_requests,
sub_documents, sub_agreements, sub_payouts, routes, route_members,
turnover_windows and sub_applications, added every one to TENANT_TABLES with a
comment about how 095 exists precisely because tables carried org_id for
months with no backstop — and then never called apply_org_rls. Earlier
migrations left the same gap for saved_views, job_photos, job_responses,
cleaner_availability, crew_docs, cleaner_week_availability, crew_messages,
property_crew_notes and property_photos.

So the tables holding W-9 scans, subcontractor payouts and claim requests have
had no row-level security backstop since the day they were created. The
application layer does scope these queries by org_id, so this is a backstop
with no expected behavior change for legitimate reads — which is exactly what
makes it worth having: it is the thing that catches the next forgotten filter.

Deliberately calls apply_org_rls with NO table list, so it sweeps whatever
TENANT_TABLES holds at deploy time rather than freezing a hand-copied list
that can drift the same way. It is idempotent (DROP POLICY IF EXISTS then
CREATE), it is a no-op off Postgres, and the policy's USING clause allows
everything while `app.current_org_id` is unset — so migrations, background
jobs and the scheduler are unaffected.

Why this was invisible: tests/test_tenancy_rls_postgres.py builds the schema
with Base.metadata.create_all and then calls apply_org_rls(c) itself, so it
proves the FUNCTION works and never that any deploy path invokes it. The
companion test added with this migration runs the real chain and asserts the
policies exist, which is the check that would have caught it.

`users` is still deliberately excluded — see 095's note. Its org_id is
nullable and a NULL-org row satisfies neither arm of the policy once the GUC
is set, so switching it on could lock a legacy admin out. That one needs its
own audit.

Revision ID: 104_rls_backfill_all_tenant_tables
Revises: 103_grandfather_crew_vetting
"""
from alembic import op

from database.rls import apply_org_rls

revision = "104_rls_backfill_all_tenant_tables"
down_revision = "103_grandfather_crew_vetting"
branch_labels = None
depends_on = None


def upgrade():
    apply_org_rls(op.get_bind())


def downgrade():
    # Intentionally a no-op. Reversing this would strip the policy from tables
    # that HAVE been protected since 028, which is a strictly worse state than
    # the one this migration found. There is nothing here to undo that is safe
    # to undo; drop_org_rls exists for a caller who genuinely wants that.
    pass
