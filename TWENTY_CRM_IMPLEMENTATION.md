# Twenty CRM Implementation for Bright Space

## Overview

This document describes the complete Twenty CRM implementation for Bright Space, a cleaning business management platform. The implementation transforms the application into a full-featured CRM system where clients are the central hub connected to opportunities, jobs, quotes, invoices, messages, and activities.

## What is Twenty CRM?

Twenty is an open-source CRM platform that uses an "object-first" architecture. Key principles:
- **Client as Hub**: All business records (jobs, opportunities, quotes, invoices) are linked to clients
- **Relationship Tracking**: Jobs, quotes, invoices can be linked to opportunities for pipeline visibility
- **Unified Timeline**: All interactions (emails, SMS, calls, status changes) appear in an activity timeline
- **Flexible Schema**: Custom fields allow tailoring the system to specific business needs
- **Omnichannel**: SMS, email, chat all integrated into a single conversation interface

## Implementation Status

### ✅ Completed (Phase 1-2)

1. **Database Schema (models.py)**
   - ActivityType enum with 30+ activity types
   - Client as central hub with cascading relationships
   - Opportunity linked to Job, Quote, Invoice, Message, Conversation
   - Added custom_fields JSON to all major entities
   - Added updated_at timestamps for audit trails
   - Enhanced FieldDefinition with unique constraints

2. **API Layer (6 routers enhanced)**
   - **scheduling/router.py**: Jobs now link to opportunities
   - **quoting/router.py**: Quotes support custom_fields and opportunity linking
   - **invoicing/router.py**: Invoices track opportunity pipeline
   - **opportunities/router.py**: Full CRM features with detail endpoint and timeline
   - **clients/router.py**: New `/crm-summary` endpoint with pipeline/financial/comms metrics
   - **intake/router.py**: Leads can link to opportunities

3. **Frontend Components**
   - **ClientCRMSummary.jsx**: Dashboard showing lifecycle, pipeline, financial, communications
   - **OpportunityLinker.jsx**: Modal to link/unlink jobs/quotes/invoices to opportunities
   - **ActivityTimeline.jsx**: Unified activity feed with filtering and date grouping

4. **Frontend Integration**
   - CRM tab added to ClientProfile
   - OpportunityLinker integrated into job, quote, invoice cards
   - Users can link/unlink business records to opportunities from profile view

5. **Migration Assets**
   - MIGRATION_GUIDE_TWENTY_CRM.md: Step-by-step deployment instructions
   - MIGRATION_SQL.sql: Database-specific SQL statements
   - Backfill scripts for orphaned records
   - Rollback procedures and troubleshooting

### 🔄 Next Steps

1. **Apply Database Migration** (See MIGRATION_GUIDE_TWENTY_CRM.md)
2. **Deploy Frontend** (Components already integrated)
3. **Test End-to-End Workflows**
4. **Backfill Existing Data** (Optional but recommended)
5. **Update API Documentation**

## Architecture

### Database Schema Changes

```
Client (central hub)
├── Opportunity (pipeline stages: new → qualified → quoted → won/lost)
│   ├── Quote (linked via opportunity_id)
│   ├── Invoice (linked via opportunity_id)
│   ├── Job (linked via opportunity_id)
│   ├── Message (linked via opportunity_id)
│   ├── Conversation (linked via opportunity_id)
│   └── Activity (opportunity-specific timeline)
├── Job (also links to opportunity_id, quote_id)
├── Quote (also links to opportunity_id)
├── Invoice (also links to opportunity_id, job_id)
├── Message (links to client, opportunity, job, conversation)
├── Conversation (links to client, opportunity)
├── Activity (central timeline for all interactions)
├── ContactEmail (multiple emails per client)
├── ContactPhone (multiple phones per client)
└── LeadIntake (pre-client records linking to opportunity)
```

### New Columns

**Jobs Table:**
- `opportunity_id` (FK) - Link to opportunity
- `updated_at` (DateTime) - Last modification timestamp

**Quotes Table:**
- `opportunity_id` (FK) - Link to opportunity
- `custom_fields` (JSON) - Flexible schema
- `updated_at` (DateTime) - Last modification timestamp

**Invoices Table:**
- `opportunity_id` (FK) - Link to opportunity
- `updated_at` (DateTime) - Last modification timestamp

**Messages Table:**
- `job_id` (FK) - Link to job for context
- `opportunity_id` (FK) - Link to opportunity for context

**Conversations Table:**
- `opportunity_id` (FK) - Link to opportunity
- `updated_at` (DateTime) - Last modification timestamp

**Opportunities Table:**
- `custom_fields` (JSON) - Flexible schema
- `updated_at` (DateTime) - Last modification timestamp

**LeadIntake Table:**
- `opportunity_id` (FK) - Link to opportunity
- `custom_fields` (JSON) - Flexible schema

**FieldDefinitions Table:**
- `is_system` (Boolean) - Marks built-in vs custom fields

## API Endpoints

### New Endpoints

**Client CRM Summary:**
```
GET /api/clients/{client_id}/crm-summary
→ Returns complete CRM view with pipeline, financial, communications
```

**Opportunity Details:**
```
GET /api/opportunities/{opp_id}/details
→ Returns opportunity with all related quotes, invoices, jobs, timeline
```

**Activity Timeline:**
```
GET /api/activities?client_id={id}&opportunity_id={id}&limit=50
→ Returns filtered activity stream
```

### Updated Endpoints

All Create and Update endpoints now support:
- `opportunity_id` parameter (for jobs, quotes, invoices, conversations)
- `custom_fields` parameter (for jobs, quotes, invoices, opportunities)
- `job_id` parameter (for messages)

## Frontend Components

### ClientCRMSummary
Displays:
- Lifecycle status (stage, type, source, last contact)
- Pipeline summary (opportunities by stage with values)
- Financial summary (quotes, invoices, payments)
- Communications summary (emails, SMS, contact methods)
- Recent activity timeline (last 10 activities)

### OpportunityLinker
Provides UI to:
- Select opportunity from list
- Link/unlink job, quote, or invoice to opportunity
- Visual feedback showing current linked opportunity

### ActivityTimeline
Shows:
- Chronological activity feed
- Icon and color per activity type
- Filtering by activity type
- Date grouping (Today, Yesterday, etc.)

## Deployment Workflow

### 1. Staging Environment

```bash
# Backup production database
cp database.db database.db.backup

# Switch to feature branch
git checkout claude/restore-comms-location-Hqqoh

# Apply database migration
python -m alembic upgrade head
# OR run SQL from MIGRATION_SQL.sql

# Run tests
pytest tests/test_opportunities.py tests/test_clients.py

# Test CRM endpoints
curl http://localhost:8000/api/clients/1/crm-summary
curl http://localhost:8000/api/opportunities/1/details
```

### 2. Production Deployment

```bash
# 1. Backup production
pg_dump bright_space > bright_space_backup.sql

# 2. Apply migration
python -m alembic upgrade head

# 3. Run backfill scripts (optional)
python scripts/backfill_opportunities.py

# 4. Verify data integrity
SELECT COUNT(*) FROM jobs WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM messages WHERE opportunity_id IS NULL AND job_id IS NULL;

# 5. Deploy frontend
npm run build && npm run deploy

# 6. Smoke tests
curl https://api.bright-space.com/api/clients/1/crm-summary
```

### 3. Rollback Procedure

```bash
# If issues occur:
alembic downgrade -1

# Or restore from backup:
psql bright_space < bright_space_backup.sql
```

## Testing Checklist

### Backend

- [ ] Database migration succeeds
- [ ] GET /api/clients/{id}/crm-summary returns all sections
- [ ] GET /api/opportunities/{id}/details includes related entities
- [ ] POST /api/jobs links to opportunity via job creation
- [ ] PATCH /api/jobs/{id} updates opportunity_id
- [ ] PATCH /api/quotes/{id} updates custom_fields
- [ ] PATCH /api/invoices/{id} updates opportunity_id
- [ ] Activity timeline shows all activity types
- [ ] Foreign key constraints enforced

### Frontend

- [ ] CRM tab visible on Client Profile
- [ ] CRM summary displays pipeline data
- [ ] CRM summary shows financial metrics
- [ ] CRM summary displays recent activity
- [ ] OpportunityLinker modal opens/closes
- [ ] Can link job to opportunity
- [ ] Can unlink job from opportunity
- [ ] Linked opportunity badge shows on card
- [ ] Linking refreshes client data
- [ ] Works on mobile (responsive)

### End-to-End

- [ ] Create lead intake
- [ ] Convert to opportunity
- [ ] Create quote from opportunity
- [ ] Create job from quote
- [ ] Link job to opportunity
- [ ] Create invoice for job
- [ ] Link invoice to opportunity
- [ ] View complete pipeline in CRM summary
- [ ] See all activities in timeline
- [ ] Pipeline value updates correctly

## Performance Considerations

### Indexes to Add

```sql
CREATE INDEX idx_job_opportunity_id ON jobs(opportunity_id);
CREATE INDEX idx_quote_opportunity_id ON quotes(opportunity_id);
CREATE INDEX idx_invoice_opportunity_id ON invoices(opportunity_id);
CREATE INDEX idx_message_opportunity_id ON messages(opportunity_id);
CREATE INDEX idx_conversation_opportunity_id ON conversations(opportunity_id);
CREATE INDEX idx_activity_created_at ON activities(created_at DESC);
CREATE INDEX idx_client_lifecycle_stage ON clients(lifecycle_stage);
```

### Query Optimization

- Use `joinedload` in API endpoints to avoid N+1 queries
- Pre-load relationships in CRM summary queries
- Consider pagination for activity feeds on large accounts

### Caching Strategy

- Cache CRM summary for 5 minutes per client
- Invalidate on opportunity/job/quote/invoice changes
- Use ETags for conditional requests

## Data Migration Guide

### Auto-create Opportunities from Existing Jobs

```python
# Script in scripts/backfill_opportunities.py
for job in db.query(Job).filter(Job.opportunity_id.is_(None)).all():
    opp = Opportunity(
        client_id=job.client_id,
        title=job.title,
        stage="qualified",
        service_type=job.job_type,
    )
    db.add(opp)
    job.opportunity_id = opp.id
db.commit()
```

### Link Orphaned Quotes to Opportunities

```python
# Link quotes without opportunities to most recent opp for client
for quote in db.query(Quote).filter(Quote.opportunity_id.is_(None)).all():
    opp = db.query(Opportunity).filter(
        Opportunity.client_id == quote.client_id
    ).order_by(Opportunity.created_at.desc()).first()
    if opp:
        quote.opportunity_id = opp.id
db.commit()
```

## Support & Troubleshooting

### Common Issues

**Issue: Foreign key constraint error on migration**
- Solution: Check for data integrity issues in existing data
- Run data cleanup scripts before migration

**Issue: CRM summary endpoint returns empty pipeline**
- Solution: Opportunities exist but jobs/quotes aren't linked
- Run backfill scripts to link existing records

**Issue: OpportunityLinker modal doesn't show opportunities**
- Solution: No opportunities exist for client yet
- Create an opportunity first through Pipeline page

### Getting Help

1. Check MIGRATION_GUIDE_TWENTY_CRM.md troubleshooting section
2. Review database logs for constraint violations
3. Check browser console for frontend errors
4. Verify API endpoints are responding with correct data

## File Changes Summary

### Backend
- `backend/database/models.py` - Enhanced schema
- `backend/modules/scheduling/router.py` - Job opportunity linking
- `backend/modules/quoting/router.py` - Quote custom fields
- `backend/modules/invoicing/router.py` - Invoice opportunity linking
- `backend/modules/opportunities/router.py` - CRM features
- `backend/modules/clients/router.py` - CRM summary endpoint
- `backend/modules/intake/router.py` - Intake opportunity linking

### Frontend
- `frontend/src/components/ClientCRMSummary.jsx` - CRM dashboard
- `frontend/src/components/OpportunityLinker.jsx` - Link modal
- `frontend/src/components/ActivityTimeline.jsx` - Activity feed
- `frontend/src/pages/ClientProfile.jsx` - Integration

### Documentation
- `MIGRATION_GUIDE_TWENTY_CRM.md` - Deployment guide
- `MIGRATION_SQL.sql` - Database migrations
- `TWENTY_CRM_IMPLEMENTATION.md` - This file

## Future Enhancements

1. **Drag-and-Drop Pipeline**: Move opportunities between stages with card UI
2. **Forecasting**: Predict revenue based on pipeline weighted by probability
3. **Deal Timeline**: Show full lifecycle of opportunity with key milestones
4. **Custom Stages**: Allow users to customize opportunity stages
5. **Automation**: Auto-advance stages based on job/quote/invoice status
6. **Reporting**: Generate pipeline and financial reports
7. **Mobile App**: Native mobile app for on-the-go access
8. **Integrations**: Zapier, Slack, HubSpot sync

## Version History

- **v1.0.0** (April 2026): Initial Twenty CRM implementation
  - Database schema with opportunity linking
  - API layer enhancements
  - Frontend CRM components
  - Migration guide and tooling

---

**Last Updated**: April 16, 2026
**Branch**: claude/restore-comms-location-Hqqoh
**Status**: Ready for staging deployment
