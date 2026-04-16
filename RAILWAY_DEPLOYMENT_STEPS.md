# Railway Deployment: Twenty CRM

## Quick Deploy (5 minutes)

### Step 1: Backup Database on Railway
1. Go to https://railway.app
2. Click on **Bright-Space** project
3. Click on **PostgreSQL** service
4. Go to **Backups** tab
5. Click **New Backup** button
6. Wait for backup to complete ✓

### Step 2: Deploy Code
```bash
# Make sure you're on the feature branch
git checkout claude/restore-comms-location-Hqqoh

# Push to trigger Railway deployment
git push origin claude/restore-comms-location-Hqqoh
```
- Railway auto-detects the push
- Builds and deploys automatically
- Takes ~2-3 minutes

### Step 3: Apply Database Migration
**Option A: Using Railway Database Editor (Easiest)**

1. Go to **PostgreSQL** service in Railway
2. Click **Connect** tab
3. Copy the `psql` command
4. Open your terminal and paste (connects to prod database)
5. Copy entire contents of `MIGRATION_SQL.sql`
6. Paste into the `psql` prompt
7. Press Enter to execute
8. Verify with:
   ```sql
   SELECT column_name FROM information_schema.columns 
   WHERE table_name='jobs' AND column_name='opportunity_id';
   ```
   Should return: `opportunity_id`

**Option B: Using Alembic (If Python env set up)**
```bash
export DATABASE_URL="[copy from Railway PostgreSQL > Connect]"
cd backend
alembic upgrade head
```

### Step 4: Verify Deployment
Check these in order:

**1. API Health Check:**
```bash
curl https://api.bright-space.com/api/health
```
Should return: `{"status": "ok"}`

**2. CRM Summary Endpoint:**
```bash
curl https://api.bright-space.com/api/clients/1/crm-summary
```
Should return JSON with: `pipeline`, `financial`, `communications`, `recent_activity`

**3. Browser Test:**
- Go to https://bright-space.com
- Click on any client
- Look for new **CRM** tab
- Should show pipeline, financial summary, activity timeline

**4. Check Logs:**
- Go to Railway **Deployments** tab
- Click latest deployment
- Check **Logs** tab
- Look for errors (should be none)

### Step 5: Post-Deployment
✓ Deployment complete! Now:
1. Monitor error rates for 10 minutes
2. Test linking a job to an opportunity
3. Send team announcement
4. Add to release notes

---

## Troubleshooting

### Issue: "opportunity_id column not found"
**Solution:**
1. Verify migration ran: `psql [db_url] -c "\d jobs"`
2. Check logs in Railway
3. If migration didn't run, manually run MIGRATION_SQL.sql again

### Issue: "CRM tab not showing"
**Solution:**
1. Hard refresh browser (Cmd+Shift+R)
2. Clear browser cache
3. Verify frontend deployed: check Railway build logs
4. Restart browser if still not showing

### Issue: API returning 500 errors
**Solution:**
1. Check Railway logs: **Deployments > Latest > Logs**
2. Look for Python errors
3. Check database connection: `psql [db_url] -c "SELECT 1"`
4. If database issue, restart PostgreSQL service

### Need to Rollback?
```bash
# Rollback code
git push origin main

# Rollback database
# Use the backup you created in Step 1
# Go to PostgreSQL > Backups, restore from backup
```

---

## Real-Time Monitoring

While deploying, monitor these:

**Railway Dashboard:**
- https://railway.app/project/[PROJECT_ID]
- Watch **Deployments** for build progress
- Check **Metrics** for error rate

**Production Logs:**
- See live logs as deployment happens
- Filter for errors: `level:error` or `exception`

**User Testing:**
- Have team test in production immediately
- Report any issues via Slack
- Keep rollback command ready

---

## Verification Checklist

Run these after deployment completes:

- [ ] Git push completed (code deployed to Railway)
- [ ] Database migration ran (verified with psql)
- [ ] API health check passes
- [ ] CRM summary endpoint returns 200
- [ ] Browser shows CRM tab
- [ ] No errors in Railway logs
- [ ] Job can be linked to opportunity
- [ ] CRM summary shows data
- [ ] Activity timeline displays
- [ ] No user-facing errors

---

## Timeline

| Time | Action | Status |
|------|--------|--------|
| T+0m | Start backup | Pending... |
| T+2m | Push code | Waiting... |
| T+3m | Railway build starts | In progress... |
| T+5m | Build completes | Pending... |
| T+6m | Run migration | Pending... |
| T+7m | Verify endpoints | Pending... |
| T+8m | **Complete!** | ✅ Done |

---

## Questions?

If anything goes wrong:
1. Check RAILWAY_DEPLOYMENT_STEPS.md (this file)
2. Review MIGRATION_GUIDE_TWENTY_CRM.md
3. Check DEPLOYMENT_CHECKLIST.md
4. Contact: [Your DevOps lead]

**Don't panic!** Rollback is just one push away.
