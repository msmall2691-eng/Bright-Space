-- Migration: Add public quote accept flow
-- Purpose: Enable customer-facing quote acceptance via token-based public link
-- Created: 2026-04-21

-- Add public token and acceptance tracking columns
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS public_token VARCHAR(48);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_ip VARCHAR;

-- Create partial unique index (only non-NULL tokens are unique)
CREATE UNIQUE INDEX IF NOT EXISTS ix_quotes_public_token
  ON quotes (public_token) WHERE public_token IS NOT NULL;
