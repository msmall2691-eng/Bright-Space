-- Twenty CRM Schema Migration
-- Supports: PostgreSQL, MySQL, SQLite
-- Always backup before running: cp database.db database.db.backup

-- ==================== FIELD DEFINITIONS ====================
-- Add is_system flag for built-in fields
ALTER TABLE field_definitions ADD COLUMN is_system BOOLEAN DEFAULT FALSE;

-- ==================== JOBS ====================
-- Add opportunity_id and updated_at to jobs
ALTER TABLE jobs ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ==================== QUOTES ====================
-- Add opportunity_id, custom_fields, and updated_at
ALTER TABLE quotes ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE quotes ADD COLUMN custom_fields JSON DEFAULT '{}';
ALTER TABLE quotes ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ==================== INVOICES ====================
-- Add opportunity_id and updated_at
ALTER TABLE invoices ADD COLUMN opportunity_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ==================== CONVERSATIONS ====================
-- Add opportunity_id and updated_at
ALTER TABLE conversations ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ==================== MESSAGES ====================
-- Add job_id and opportunity_id
ALTER TABLE messages ADD COLUMN job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;

-- ==================== OPPORTUNITIES ====================
-- Add custom_fields and updated_at
ALTER TABLE opportunities ADD COLUMN custom_fields JSON DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ==================== LEAD INTAKES ====================
-- Add opportunity_id and custom_fields
ALTER TABLE lead_intakes ADD COLUMN opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE lead_intakes ADD COLUMN custom_fields JSON DEFAULT '{}';

-- ==================== INDEXES ====================
-- Add performance indexes
CREATE INDEX idx_job_opportunity_id ON jobs(opportunity_id);
CREATE INDEX idx_quote_opportunity_id ON quotes(opportunity_id);
CREATE INDEX idx_invoice_opportunity_id ON invoices(opportunity_id);
CREATE INDEX idx_message_opportunity_id ON messages(opportunity_id);
CREATE INDEX idx_message_job_id ON messages(job_id);
CREATE INDEX idx_conversation_opportunity_id ON conversations(opportunity_id);
CREATE INDEX idx_lead_intake_opportunity_id ON lead_intakes(opportunity_id);
CREATE INDEX idx_job_updated_at ON jobs(updated_at);
CREATE INDEX idx_quote_updated_at ON quotes(updated_at);
CREATE INDEX idx_invoice_updated_at ON invoices(updated_at);
CREATE INDEX idx_opportunity_updated_at ON opportunities(updated_at);

-- ==================== VERIFICATION ====================
-- Verify all columns exist (run these SELECT queries to confirm):
-- SELECT * FROM information_schema.COLUMNS WHERE TABLE_NAME='jobs' AND COLUMN_NAME='opportunity_id';
-- SELECT * FROM information_schema.COLUMNS WHERE TABLE_NAME='quotes' AND COLUMN_NAME='custom_fields';
-- SELECT * FROM information_schema.COLUMNS WHERE TABLE_NAME='messages' AND COLUMN_NAME='job_id';

-- ==================== DATA BACKFILL (Optional) ====================
-- Create opportunities for active jobs without opportunities
-- This is optional - only run if you want to link existing jobs to opportunities

-- First, ensure you have at least one active opportunity per client with jobs:
-- INSERT INTO opportunities (client_id, title, stage, created_at, updated_at)
-- SELECT DISTINCT client_id, 'Backfilled from Jobs', 'qualified', NOW(), NOW()
-- FROM jobs WHERE opportunity_id IS NULL AND client_id NOT IN (
--   SELECT DISTINCT client_id FROM opportunities
-- );

-- Then link jobs to their opportunities:
-- UPDATE jobs j
-- SET opportunity_id = (
--   SELECT id FROM opportunities o
--   WHERE o.client_id = j.client_id
--   ORDER BY o.created_at DESC LIMIT 1
-- )
-- WHERE j.opportunity_id IS NULL;

-- ==================== NOTES ====================
-- 1. SQLite: JSON handling is supported since SQLite 3.38.0 (2022-02-22)
--    If using older SQLite, TEXT will be used instead of JSON
--
-- 2. MySQL: JSON is a native type since MySQL 5.7
--    Ensure charset is utf8mb4 for emoji support
--
-- 3. PostgreSQL: JSON/JSONB are first-class types
--    Consider using JSONB for better query performance
--
-- 4. All foreign keys default to ON DELETE SET NULL for safety
--    Change to ON DELETE CASCADE if you want cascading deletes
--
-- 5. Updated_at columns default to CURRENT_TIMESTAMP
--    Database will NOT auto-update these on record changes
--    ORM layer (SQLAlchemy) handles the update via onupdate parameter
