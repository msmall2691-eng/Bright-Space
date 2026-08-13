#!/usr/bin/env bash
# BrightBase branch cleanup — 2026-08-13.
#
# Deletes 51 dead remote branches. Run from any clone with push rights:
#     bash docs/branch-cleanup-2026-08-13.sh
#
# Every branch here is either already merged into main, superseded by work
# that shipped through other PRs (verified per-branch — see the PR notes),
# or a leftover probe. Escape hatch: docs/branch-backup-2026-08-13.md holds
# every tip SHA — restore any branch with:
#     git branch <name> <sha> && git push origin <name>
#
# NOT touched: main, the active working branch, and the 7 branches with
# open PRs (5x dependabot, claude/ios-dashboard-impl-3ydth9,
# claude/connecteam-jobs-mapping-59hs2i).
set -euo pipefail

echo "Batch 1/6"
git push origin --delete \
  add-twenty-crm-sms-mirror \
  claude/tmp-delete-probe \
  claude/add-assigned-to-column-qaUWF \
  claude/add-cleaning-scheduler-MReV6 \
  claude/agents-ui-improvements-9JGB9 \
  claude/audit-scheduling-system-QjNVx \
  claude/audit-scheduling-system-aFhdK \
  claude/backfill-terminal-source \
  claude/brightbase-e2e-audit-dv5ezt \
  claude/client-contact-management-jEl5L

echo "Batch 2/6"
git push origin --delete \
  claude/client-properties-jobs-H4tcc \
  claude/clientprofile-redesign \
  claude/code-kickoff-pr1-FTOAl \
  claude/convert-to-job-schedule-modal \
  claude/debug-app-crashes-4pi5Q \
  claude/debug-container-startup-miHwR \
  claude/debug-inbound-sms-7E6Rs \
  claude/email-greeting-company-detect \
  claude/fix-dashboard-nav-sms-zWwAH \
  claude/fix-quote-send

echo "Batch 3/6"
git push origin --delete \
  claude/gcal-account-diagnostic \
  claude/google-signin-spec \
  claude/light-theme-migration-Ln1Ev \
  claude/lucid-dirac-ypkkjf \
  claude/maineclean-request-pipeline-5ro3C \
  claude/messaging-killswitch \
  claude/mobile-friendly-update-NBOXN \
  claude/owner-dashboard-quote-n1-fix \
  claude/phase1-review-queue \
  claude/quirky-feynman-wq955a

echo "Batch 4/6"
git push origin --delete \
  claude/quote-title-customer-facing \
  claude/rentals-auto-sync \
  claude/restore-comms-location-Hqqoh \
  claude/schedule-redesign \
  claude/sms-phone-validation \
  claude/stop-ical-sync-OE4p6 \
  claude/test-maineclean-workflow-c72ar \
  claude/turnover-coverage-hardening \
  claude/unit-price-focus-select \
  claude/update-audit-brief-Hpd0P

echo "Batch 5/6"
git push origin --delete \
  claude/verify-client-profile-mYdUO \
  claude/website-quote-pipeline-C3JBm \
  codex/audit-schema-and-workflows-for-crm \
  codex/audit-schema-and-workflows-for-crm-bl1qzb \
  feat/activity-auto-log \
  feat/client-timeline-ui \
  feat/omnichannel-inbox-phase1 \
  feat/phase1-hotfix \
  feat/scheduler-week-view \
  feat/user-auth

echo "Batch 6/6"
git push origin --delete \
  feat/visit-pre-materialization

git remote prune origin
echo "Done. Remaining remote branches:"
git ls-remote --heads origin | wc -l
