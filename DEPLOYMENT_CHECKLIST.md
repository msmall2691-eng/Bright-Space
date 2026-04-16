# Twenty CRM Deployment Checklist

## Pre-Deployment (Do This First)

### Code Review
- [ ] Review all commits in `claude/restore-comms-location-Hqqoh` branch
- [ ] Verify database schema changes in models.py
- [ ] Check API endpoint changes in router files
- [ ] Review new frontend components
- [ ] Verify no breaking changes to existing endpoints

### Testing in Development
- [ ] Run all existing tests: `pytest tests/`
- [ ] Test new CRM endpoints manually
- [ ] Test OpportunityLinker component in browser
- [ ] Verify ClientCRMSummary displays correctly
- [ ] Test on mobile view
- [ ] Verify no console errors in browser DevTools

### Documentation Review
- [ ] Read TWENTY_CRM_IMPLEMENTATION.md
- [ ] Review MIGRATION_GUIDE_TWENTY_CRM.md
- [ ] Check MIGRATION_SQL.sql for your database type
- [ ] Understand data backfill scripts

---

## Stage 1: Backup & Staging

### Backup Production Database
```bash
# PostgreSQL
pg_dump -h prod-db.com -U user bright_space > bright_space_prod_backup_$(date +%Y%m%d_%H%M%S).sql

# MySQL
mysqldump -h prod-db.com -u user -p bright_space > bright_space_prod_backup_$(date +%Y%m%d_%H%M%S).sql

# SQLite
cp /path/to/database.db /path/to/database.db.backup_$(date +%Y%m%d_%H%M%S)
```
- [ ] Backup file created
- [ ] Backup file verified (can be restored)
- [ ] Backup file stored securely (cloud storage, etc.)

### Staging Environment Setup
- [ ] Deploy code to staging: `git checkout claude/restore-comms-location-Hqqoh`
- [ ] Copy staging database from production
- [ ] Ensure staging DB is a true copy of production data
- [ ] Staging environment matches production (Python version, etc.)

---

## Stage 2: Test Database Migration

### Apply Migration to Staging
```bash
# Using Alembic
cd backend
alembic upgrade head

# OR using raw SQL
psql staging_db < MIGRATION_SQL.sql
```
- [ ] Migration command completes without errors
- [ ] All new columns exist: `SELECT * FROM jobs WHERE opportunity_id IS NOT NULL LIMIT 1;`
- [ ] Foreign keys are created
- [ ] Indexes are created
- [ ] No data loss (row count same before/after)

### Verify Schema
```bash
# Check each table has new columns
psql staging_db -c "\d jobs" | grep opportunity_id
psql staging_db -c "\d quotes" | grep custom_fields
psql staging_db -c "\d invoices" | grep opportunity_id
psql staging_db -c "\d messages" | grep job_id
```
- [ ] job.opportunity_id exists
- [ ] job.updated_at exists
- [ ] quote.opportunity_id exists
- [ ] quote.custom_fields exists
- [ ] invoice.opportunity_id exists
- [ ] message.job_id exists
- [ ] message.opportunity_id exists
- [ ] conversation.opportunity_id exists
- [ ] opportunity.custom_fields exists
- [ ] field_definitions.is_system exists

### Test API Endpoints

**Test CRM Summary Endpoint:**
```bash
curl -X GET http://staging-api.local/api/clients/1/crm-summary \
  -H "Authorization: Bearer YOUR_TOKEN"
```
- [ ] Returns 200 OK
- [ ] Contains pipeline section
- [ ] Contains financial section
- [ ] Contains communications section
- [ ] Contains recent_activity section

**Test Opportunity Details Endpoint:**
```bash
curl -X GET http://staging-api.local/api/opportunities/1/details \
  -H "Authorization: Bearer YOUR_TOKEN"
```
- [ ] Returns 200 OK
- [ ] Contains quotes list
- [ ] Contains invoices list
- [ ] Contains jobs list
- [ ] Contains timeline array

**Test Job Linking:**
```bash
curl -X PATCH http://staging-api.local/api/jobs/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"opportunity_id": 5}'
```
- [ ] Returns 200 OK
- [ ] Job now has opportunity_id
- [ ] Activity created for status change

---

## Stage 3: Frontend Testing

### Build Frontend
```bash
cd frontend
npm run build
```
- [ ] Build completes without errors
- [ ] No TypeScript errors
- [ ] No ESLint warnings
- [ ] Build size is reasonable

### Test Components
- [ ] Can view ClientProfile page
- [ ] CRM tab is visible and clickable
- [ ] ClientCRMSummary displays without errors
- [ ] Pipeline metrics show correct values
- [ ] Financial summary shows correct totals
- [ ] Recent activity timeline displays
- [ ] Can open OpportunityLinker modal on job card
- [ ] Can open OpportunityLinker modal on quote card
- [ ] Can open OpportunityLinker modal on invoice card
- [ ] Modal loads opportunity list
- [ ] Can select opportunity and link
- [ ] Unlink button works
- [ ] UI is responsive on mobile

### Test User Workflows

**Workflow 1: Link Existing Job to Opportunity**
1. [ ] Navigate to Client Profile
2. [ ] Go to Jobs tab
3. [ ] Click "Link to Opportunity" on a job
4. [ ] Select an opportunity from the modal
5. [ ] Verify job now shows linked opportunity
6. [ ] Verify activity log updated

**Workflow 2: View CRM Summary**
1. [ ] Click on CRM tab
2. [ ] Verify pipeline shows opportunities by stage
3. [ ] Verify financial summary shows invoices
4. [ ] Verify communications shows emails/SMS
5. [ ] Verify activity timeline displays
6. [ ] Check all counts are accurate

**Workflow 3: Link Quote to Opportunity**
1. [ ] Go to Quotes tab
2. [ ] Click "Link to Opportunity" on a quote
3. [ ] Link to opportunity
4. [ ] Verify quote shows in opportunity details

---

## Stage 4: Data Backfill (Optional but Recommended)

### Backfill Existing Jobs with Opportunities
```bash
# Review backfill script
cat scripts/backfill_opportunities.py

# Run with dry-run first
python scripts/backfill_opportunities.py --dry-run

# Run for real
python scripts/backfill_opportunities.py
```
- [ ] Script created and reviewed
- [ ] Dry-run shows expected changes
- [ ] Run script successfully
- [ ] Verify jobs have opportunity_id set
- [ ] Verify opportunities created with correct titles

### Link Quotes to Opportunities
```bash
python scripts/link_quotes_to_opportunities.py --dry-run
python scripts/link_quotes_to_opportunities.py
```
- [ ] Dry-run reviewed
- [ ] Script executed
- [ ] Orphaned quotes linked to opportunities

### Verify Data Integrity
```sql
-- Check for orphaned records
SELECT COUNT(*) FROM jobs WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM quotes WHERE opportunity_id IS NULL;
SELECT COUNT(*) FROM messages WHERE opportunity_id IS NULL AND job_id IS NULL;

-- Should all be 0 (or acceptable baseline)
```
- [ ] No critical orphaned records
- [ ] Record counts match expectations

---

## Stage 5: Performance Testing

### Load Testing
```bash
# Test CRM summary endpoint under load
ab -n 1000 -c 10 http://staging-api.local/api/clients/1/crm-summary

# Test opportunity details endpoint
ab -n 1000 -c 10 http://staging-api.local/api/opportunities/1/details
```
- [ ] Response time < 500ms under normal load
- [ ] No database connection pool exhaustion
- [ ] No N+1 query issues (check query logs)

### Database Performance
```bash
-- Run after migration
ANALYZE; -- PostgreSQL to update stats
ANALYZE TABLE jobs; -- MySQL

-- Check index usage
EXPLAIN ANALYZE SELECT * FROM jobs WHERE opportunity_id = 5;
EXPLAIN ANALYZE SELECT * FROM quotes WHERE client_id = 1;
```
- [ ] Indexes are being used
- [ ] Query plans are optimal
- [ ] No sequential scans on large tables

---

## Stage 6: Sign-Off

### Manager/Team Review
- [ ] Code review completed
- [ ] Testing results documented
- [ ] Performance metrics acceptable
- [ ] No critical issues found
- [ ] Sign-off received from team lead

### Approval Gates
- [ ] Product manager approves new features
- [ ] DevOps approves deployment procedure
- [ ] QA approves test results
- [ ] Security review completed (if applicable)

---

## Production Deployment

### Pre-Deployment
- [ ] All staging tests passed
- [ ] Approvals obtained
- [ ] Deployment window scheduled
- [ ] On-call engineer identified
- [ ] Rollback procedure documented
- [ ] Communication sent to users (if needed)

### During Deployment

**Step 1: Database Migration**
```bash
# Apply migration
python -m alembic upgrade head

# Verify migration succeeded
psql bright_space -c "SELECT column_name FROM information_schema.columns WHERE table_name='jobs' AND column_name='opportunity_id';"
```
- [ ] Migration applied successfully
- [ ] New columns verified in schema
- [ ] No errors in logs

**Step 2: Code Deployment**
```bash
# Deploy backend
git pull origin claude/restore-comms-location-Hqqoh
pip install -r requirements.txt
systemctl restart brightspace-api

# Verify backend is up
curl http://localhost:8000/api/health
```
- [ ] Code deployed
- [ ] Services restarted
- [ ] Health checks passing

**Step 3: Frontend Deployment**
```bash
# Build and deploy frontend
cd frontend
npm run build
npm run deploy

# Verify frontend loads
curl https://bright-space.com/
```
- [ ] Frontend built
- [ ] Deployed to CDN/server
- [ ] No 404 errors
- [ ] Assets loading

**Step 4: Smoke Tests**
```bash
# Test critical endpoints
curl https://api.bright-space.com/api/health
curl https://api.bright-space.com/api/clients/1/crm-summary
curl https://api.bright-space.com/api/opportunities/1/details

# Test UI in browser
# Navigate to client profile
# Verify CRM tab visible
# Verify data loads
```
- [ ] API responding to requests
- [ ] CRM summary endpoint working
- [ ] Frontend loads without errors
- [ ] No console errors in browser

### Post-Deployment

**Monitor for Issues**
- [ ] Monitor error logs for 30 minutes
- [ ] Check database performance
- [ ] Monitor API response times
- [ ] Watch user reports in Slack/email

**Verification Steps**
```bash
# Check database is healthy
psql bright_space -c "SELECT COUNT(*) FROM jobs WHERE opportunity_id IS NOT NULL;"
psql bright_space -c "SELECT COUNT(*) FROM activities WHERE activity_type LIKE 'opportunity_%';"

# Verify no data corruption
psql bright_space -c "SELECT COUNT(*) FROM jobs WHERE client_id IS NULL AND opportunity_id IS NOT NULL;"
```
- [ ] Database queries execute quickly
- [ ] No data corruption detected
- [ ] Activity logs being created
- [ ] Error rate normal

**Notify Users**
- [ ] Send announcement (if applicable)
- [ ] Update documentation
- [ ] Add to release notes
- [ ] Share CRM feature guide

---

## Rollback Plan

### If Issues Occur

**Immediate Actions**
1. [ ] Identify issue
2. [ ] Check if it's a configuration issue (fixable without rollback)
3. [ ] Notify team
4. [ ] Decide: fix or rollback

**Rollback Steps**
```bash
# Backend rollback
git checkout main
pip install -r requirements.txt
python -m alembic downgrade -1
systemctl restart brightspace-api

# Frontend rollback
cd frontend
git checkout main
npm run build
npm run deploy

# Restore database if needed
psql bright_space < bright_space_backup_YYYYMMDD_HHMMSS.sql
```
- [ ] Previous code deployed
- [ ] Database migrated back
- [ ] Services restarted
- [ ] Frontend reverted

**Verification After Rollback**
- [ ] Old CRM features gone from UI
- [ ] Old API endpoints working
- [ ] Database schema reverted
- [ ] Error logs normal

---

## Post-Deployment (Next Day)

### Review & Analysis
- [ ] Review deployment logs
- [ ] Check error metrics
- [ ] Monitor user feedback
- [ ] Analyze performance metrics
- [ ] Document lessons learned

### Communication
- [ ] Send deployment summary to team
- [ ] Document any issues that arose
- [ ] Schedule follow-up if needed

### User Education
- [ ] Provide CRM feature documentation
- [ ] Host demo/training session (if complex)
- [ ] Share quick start guide
- [ ] Answer user questions

---

## Success Criteria

✅ Deployment is successful if:
- All smoke tests pass
- No critical errors in logs
- CRM endpoints responding correctly
- Frontend loads without errors
- Users can access new CRM features
- Backward compatibility maintained
- Performance metrics acceptable
- Data integrity verified

❌ Rollback if:
- Database migration fails
- Critical endpoints return errors
- Data corruption detected
- Performance severely degraded
- Users unable to access application
- Security issues discovered

---

## Contacts & Escalation

- **On-Call Engineer**: [Name] ([Phone]/[Slack])
- **DevOps Lead**: [Name] ([Phone]/[Slack])
- **Product Manager**: [Name] ([Phone]/[Slack])
- **Engineering Manager**: [Name] ([Phone]/[Slack])

---

**Last Updated**: April 16, 2026
**Deployment Date**: [To be filled in]
**Deployed By**: [To be filled in]
**Approved By**: [To be filled in]
