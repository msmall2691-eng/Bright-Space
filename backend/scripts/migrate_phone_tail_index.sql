-- Migration: Add phone_tail denormalized columns and indexes
-- Purpose: Enable fast phone lookup without N+1 queries
-- Created: 2026-04-21

-- Add phone_tail columns
ALTER TABLE clients ADD COLUMN phone_tail VARCHAR(10) DEFAULT NULL;
ALTER TABLE contact_phones ADD COLUMN phone_tail VARCHAR(10) DEFAULT NULL;

-- Create indexes for fast lookups
CREATE INDEX ix_clients_phone_tail ON clients(phone_tail);
CREATE INDEX ix_contact_phones_phone_tail ON contact_phones(phone_tail);

-- Backfill existing rows with last 10 digits of phone (digits only)
-- PostgreSQL version
UPDATE clients
SET phone_tail = RIGHT(REGEXP_REPLACE(phone, '\D', '', 'g'), 10)
WHERE phone IS NOT NULL AND phone <> '';

UPDATE contact_phones
SET phone_tail = RIGHT(REGEXP_REPLACE(phone, '\D', '', 'g'), 10)
WHERE phone IS NOT NULL AND phone <> '';

-- Optional: Add index on conversations.external_contact for exact lookups (future optimization)
-- CREATE INDEX ix_conversations_external_contact ON conversations(external_contact);
