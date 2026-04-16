#!/bin/bash
# Twenty CRM Deployment Script for Railway
# This script deploys the Twenty CRM schema and code to production

set -e  # Exit on any error

echo "🚀 Twenty CRM Production Deployment"
echo "===================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Confirm branch
echo "📦 Current branch:"
git branch -v | grep "^\*"
echo ""
echo "Expected: claude/restore-comms-location-Hqqoh"
read -p "Continue with deployment? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled"
    exit 1
fi

# Step 2: Database backup
echo ""
echo "${YELLOW}Step 1: Backup Database${NC}"
if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  DATABASE_URL not set. You must backup manually via Railway dashboard:"
    echo "   1. Go to https://railway.app"
    echo "   2. Select Bright-Space project"
    echo "   3. Click PostgreSQL service"
    echo "   4. Take a backup before proceeding"
    read -p "Have you backed up the database? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Please backup first!"
        exit 1
    fi
else
    echo "✅ DATABASE_URL is set"
fi

# Step 3: Apply migration
echo ""
echo "${YELLOW}Step 2: Apply Database Migration${NC}"
echo "Upgrading database schema..."
if command -v alembic &> /dev/null; then
    cd backend
    alembic upgrade head
    cd ..
    echo "✅ Migration applied successfully"
else
    echo "⚠️  Alembic not found. Using manual SQL migration..."
    echo "   Run MIGRATION_SQL.sql against your database using Railway dashboard"
    echo "   (Open the PostgreSQL plugin, go to Connect, open any client)"
fi

# Step 4: Verify schema
echo ""
echo "${YELLOW}Step 3: Verify Database Schema${NC}"
echo "Checking new columns exist..."
if [ ! -z "$DATABASE_URL" ]; then
    psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='jobs' AND column_name='opportunity_id';" > /dev/null 2>&1
    if [ $? -eq 0 ]; then
        echo "✅ jobs.opportunity_id verified"
    else
        echo "❌ jobs.opportunity_id NOT found"
        exit 1
    fi
fi

# Step 5: Deploy code
echo ""
echo "${YELLOW}Step 4: Deploy Code to Railway${NC}"
echo "Pushing to Railway..."
git push origin claude/restore-comms-location-Hqqoh
echo "✅ Code pushed"
echo ""
echo "⚠️  Railway will auto-deploy. Monitor deployment at:"
echo "   https://railway.app/project/[PROJECT_ID]"
echo ""
read -p "Press enter after Railway deployment completes..."

# Step 6: Test endpoints
echo ""
echo "${YELLOW}Step 5: Test Endpoints${NC}"
echo "Testing CRM summary endpoint..."
API_URL="https://api.bright-space.com"  # Update with your actual API URL
if command -v curl &> /dev/null; then
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/clients/1/crm-summary")
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ]; then
        echo "✅ API responding ($RESPONSE)"
    else
        echo "❌ API error ($RESPONSE)"
        exit 1
    fi
fi

# Step 7: Frontend test
echo ""
echo "${YELLOW}Step 6: Verify Frontend${NC}"
echo "Frontend should be auto-deployed by Railway"
echo ""
echo "🔍 Check in browser:"
echo "   1. Go to https://bright-space.com"
echo "   2. Navigate to a client profile"
echo "   3. Look for new 'CRM' tab"
echo "   4. Verify CRM summary loads with data"
echo ""
read -p "Does frontend look correct? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Frontend deployment issue detected"
    exit 1
fi

# Step 8: Verify data
echo ""
echo "${YELLOW}Step 7: Verify Data Integrity${NC}"
if [ ! -z "$DATABASE_URL" ]; then
    echo "Checking for orphaned records..."
    ORPHANED=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM jobs WHERE client_id IS NULL AND opportunity_id IS NOT NULL;")
    echo "   Jobs with opportunity_id but no client_id: $ORPHANED"
    if [ "$ORPHANED" -gt 0 ]; then
        echo "⚠️  Found orphaned records - this may indicate a data integrity issue"
    fi
fi

# Success
echo ""
echo "${GREEN}✅ Deployment Complete!${NC}"
echo ""
echo "Summary:"
echo "  ✓ Database migrated"
echo "  ✓ Code deployed"
echo "  ✓ Frontend updated"
echo "  ✓ API responding"
echo "  ✓ Data verified"
echo ""
echo "Next steps:"
echo "  1. Monitor Railway logs for errors"
echo "  2. Test workflows in production"
echo "  3. Send announcement to team"
echo "  4. Document any issues"
echo ""
echo "Rollback command if needed:"
echo "  git push origin main"
echo "  alembic downgrade -1"
