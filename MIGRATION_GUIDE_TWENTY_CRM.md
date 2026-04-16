# Twenty CRM Database Migration Guide

## Overview
This guide explains how to apply the Twenty CRM schema changes to your production database. The migration adds new columns and relationships while maintaining backward compatibility with existing data.

## Migration Steps

### Step 1: Backup Database
```bash
# For SQLite
cp database.db database.db.backup

# For PostgreSQL
pg_dump bright_space > bright_space_backup.sql

# For MySQL
mysqldump -u user -p bright_space > bright_space_backup.sql
```

### Step 2: Review Schema Changes

#### New Columns Added to Existing Tables:

**field_definitions**
- `is_system` (Boolean, default=False) - Marks built-in vs custom fields
- `__table_args__` - Added unique constraint on (entity_type, key)

**clients**
- `conversations` relationship (new, cascade delete)
- `lead_intakes` relationship (new, cascade delete)

**job**
- `opportunity_id` (Integer, FK to opportunities)
- `updated_at` (DateTime, default=utcnow, auto-update)

**quote**
- `opportunity_id` (Integer, FK to opportunities)
- `custom_fields` (JSON, default={})
- `updated_at` (DateTime, default=utcnow, auto-update)

**invoice**
- `opportunity_id` (Integer, FK to opportunities)
- `updated_at` (DateTime, default=utcnow, auto-update)

**conversation**
- `opportunity_id` (Integer, FK to opportunities, nullable)
- `updated_at` (DateTime, default=utcnow, auto-update)

**message**
- `job_id` (Integer, FK to jobs, nullable)
- `opportunity_id` (Integer, FK to opportunities, nullable)

**opportunity**
- `custom_fields` (JSON, default={})
- `updated_at` (DateTime, default=utcnow, auto-update)

**lead_intake**
- `client_id` relationship (new, cascade delete)
- `opportunity_id` (Integer, FK to opportunities, nullable)
- `custom_fields` (JSON, default={})

### Step 3: Apply Schema Changes

#### Using SQLAlchemy (Recommended)
```python
# 1. Create a migration file
alembic init alembic

# 2. Create migration for each table
alembic revision --autogenerate -m "Add Twenty CRM schema"

# 3. Review generated migration file in alembic/versions/

# 4. Apply migration
alembic upgrade head

# 5. Verify migration
alembic current
alembic history
```

#### Manual SQL Migration
See `MIGRATION_SQL.sql` for database-specific SQL statements.

### Step 4: Verify Data Integrity

```bash
# Check for any NULL foreign keys that need cleanup
SELECT COUNT(*) FROM jobs WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM quotes WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM invoices WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM messages WHERE opportunity_id IS NULL AND job_id IS NULL;
```

### Step 5: Run Application Tests

```bash
# Test API endpoints
pytest tests/test_opportunities.py
pytest tests/test_jobs.py
pytest tests/test_quotes.py
pytest tests/test_invoices.py

# Test CRM summary endpoint
curl http://localhost:8000/api/clients/1/crm-summary

# Test opportunity details
curl http://localhost:8000/api/opportunities/1/details
```

### Step 6: Deploy to Production

```bash
# 1. Test on staging environment first
export DB_URL="postgresql://user:pass@staging-db/bright_space"
python -m alembic upgrade head

# 2. Run smoke tests
pytest tests/smoke_test.py

# 3. Deploy to production
export DB_URL="postgresql://user:pass@prod-db/bright_space"
python -m alembic upgrade head

# 4. Verify production data
curl https://api.bright-space.com/api/clients/1/crm-summary
```

## Rollback Procedure

If issues occur:

```bash
# Rollback last migration
alembic downgrade -1

# Rollback to specific revision
alembic downgrade <revision_id>

# Restore from backup
# SQLite
mv database.db.backup database.db

# PostgreSQL
psql bright_space < bright_space_backup.sql
```

## Data Backfill (Optional)

### Auto-create Opportunities from Jobs

```python
# Script to create opportunities for active jobs
from database.db import SessionLocal
from database.models import Job, Opportunity, Client

db = SessionLocal()

# Find jobs without opportunities
jobs = db.query(Job).filter(Job.opportunity_id.is_(None)).all()

for job in jobs:
    client = job.client
    if not client:
        continue
    
    # Create opportunity from job
    opp = Opportunity(
        client_id=client.id,
        title=job.title,
        stage="qualified",  # Job exists, so already qualified
        service_type=job.job_type,
        notes=f"Auto-created from job #{job.id}: {job.title}",
    )
    db.add(opp)
    job.opportunity_id = opp.id

db.commit()
print(f"Created opportunities for {len(jobs)} jobs")
```

### Link Existing Quotes to Opportunities

```python
# Script to link orphaned quotes
from database.models import Quote, Opportunity

quotes = db.query(Quote).filter(Quote.opportunity_id.is_(None)).all()

for quote in quotes:
    # Find existing opportunities for this client
    opp = db.query(Opportunity).filter(
        Opportunity.client_id == quote.client_id,
        Opportunity.stage.in_(["qualified", "quoted"])
    ).order_by(Opportunity.created_at.desc()).first()
    
    if opp:
        quote.opportunity_id = opp.id

db.commit()
print(f"Linked {len(quotes)} quotes to opportunities")
```

## Validation Checklist

- [ ] Database backup created and verified
- [ ] Migration script tested on staging
- [ ] All new columns present in database
- [ ] Foreign key constraints working
- [ ] Existing data accessible via old endpoints
- [ ] New CRM summary endpoint returns data
- [ ] Opportunity relationships populated (where applicable)
- [ ] Activity logging working
- [ ] Frontend components updated
- [ ] API tests passing
- [ ] Production deployment successful

## Troubleshooting

### Issue: Migration fails with constraint error
**Solution**: Check for data integrity issues. Some tables may have references to deleted records.
```sql
DELETE FROM messages WHERE client_id NOT IN (SELECT id FROM clients);
DELETE FROM jobs WHERE client_id NOT IN (SELECT id FROM clients);
```

### Issue: Foreign key error on opportunity_id
**Solution**: Ensure Opportunity table exists and has matching IDs.
```sql
ALTER TABLE jobs ADD FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;
```

### Issue: Custom fields column missing after migration
**Solution**: Manually add the column if alembic didn't pick it up.
```sql
ALTER TABLE quotes ADD COLUMN custom_fields JSON DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN custom_fields JSON DEFAULT '{}';
```

## Performance Considerations

1. **Indexes**: Add indexes to frequently queried columns:
```sql
CREATE INDEX idx_job_opportunity_id ON jobs(opportunity_id);
CREATE INDEX idx_quote_opportunity_id ON quotes(opportunity_id);
CREATE INDEX idx_invoice_opportunity_id ON invoices(opportunity_id);
CREATE INDEX idx_message_opportunity_id ON messages(opportunity_id);
CREATE INDEX idx_conversation_opportunity_id ON conversations(opportunity_id);
```

2. **Query Optimization**: Use joinedload in API endpoints to avoid N+1 queries.

3. **Archive Old Data**: Consider archiving old activities/messages to improve query performance.

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review database logs: `tail -f logs/database.log`
3. Contact the development team with the error message and database type
