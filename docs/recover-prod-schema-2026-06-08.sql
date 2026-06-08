-- ============================================================================
-- BrightBase — PRODUCTION SCHEMA RECONCILIATION (P0, 2026-06-08)
--
-- Context: prod Postgres was create_all-seeded, so tables/enum types exist
-- WITHOUT the matching Alembic history. `alembic_version` says 011, but objects
-- from 012–022 partially exist (e.g. property_type_enum, the quotes table),
-- while newer `quotes`/`lead_intakes` columns are missing — which is why
-- quoting 500s. Brute-forcing `alembic upgrade head` collides on the existing
-- objects. Instead: bring the DB up to the model with idempotent DDL, then
-- STAMP Alembic to 022 (do NOT re-run 012–022).
--
-- RUN ORDER:
--   1. Restore service first (Railway rollback to the last healthy deploy, or
--      deploy PR #255 so a failed migration no longer crash-loops the app).
--   2. Take a manual Postgres backup (Railway → Postgres → Backups).
--   3. Run STEP 0 below and READ THE RESULT before anything else.
--   4. If quotes.id is integer/bigint → run STEP 1–3. If it's uuid → STOP and
--      report back: the quotes table predates 018_integerize_quotes and needs a
--      type migration, not just added columns.
--   5. alembic stamp 022_intake_converted_quote_fk   (run in the app container)
--   6. Verify /api/health → schema.ok:true, db_revision:022.
--
-- All column DDL is `ADD COLUMN IF NOT EXISTS` — safe to re-run, only adds what
-- is missing. Types are generated from backend/database/models.py.
-- ============================================================================

-- STEP 0 — GATE: confirm the quotes table shape before touching anything.
--   Expect quotes.id to be integer/bigint. If it's uuid, do NOT proceed.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'quotes'
ORDER BY ordinal_position;
-- Also: SELECT data_type FROM information_schema.columns
--       WHERE table_name='quotes' AND column_name='id';   -- must be integer/bigint


-- STEP 1 — quotes: add any missing columns (types match the Quote model).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "client_id" integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "intake_id" integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "opportunity_id" integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "property_id" integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "created_by" integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "quote_number" varchar(50);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "public_token" varchar(64);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "title" varchar(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "service_type" varchar(100);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "address" text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "items" jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "subtotal" double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "tax_rate" double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "tax" double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "discount" double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "total" double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "status" varchar(50);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "valid_until" date;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "sent_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "viewed_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "declined_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "converted_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "follow_up_sent_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "accepted_by_name" varchar(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "accepted_by_email" varchar(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "requested_changes_message" text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "requested_changes_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "declined_reason" text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "declined_by_name" varchar(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "custom_fields" jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "created_at" timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS "updated_at" timestamptz;

-- public_token is unique + indexed in the model (migration 016).
CREATE UNIQUE INDEX IF NOT EXISTS ix_quotes_public_token ON quotes (public_token);


-- STEP 2 — lead_intakes: add any missing columns.
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "client_id" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "opportunity_id" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "converted_quote_id" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "name" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "email" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "phone" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "address" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "city" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "state" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "zip_code" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "service_type" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "bedrooms" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "bathrooms" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "square_footage" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "guests" integer;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "frequency" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "requested_date" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "check_in" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "check_out" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "estimate_min" double precision;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "estimate_max" double precision;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "property_name" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "preferred_date" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "source" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "status" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "priority" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "assigned_to" varchar;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "internal_notes" text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "custom_fields" jsonb;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "followed_up_at" timestamptz;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS "created_at" timestamptz;

-- STEP 3 — tell Alembic the truth (run in the app container, NOT as SQL):
--   alembic stamp 022_intake_converted_quote_fk
--
-- Then verify: /api/health → {"schema":{"ok":true,"db_revision":"022_intake_converted_quote_fk"}}
