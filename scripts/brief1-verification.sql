-- BrightBase — Brief 1 verification pass
-- READ ONLY. Every statement is a SELECT. Nothing here writes, alters, or drops.
-- Run with:  railway connect Postgres   (then \i scripts/brief1-verification.sql)
--   or:      psql "$DATABASE_PUBLIC_URL" -f scripts/brief1-verification.sql

\pset pager off
\timing off

\echo '=== 1. NULL org_id counts ==='
SELECT 'jobs'                  AS tbl, count(*) AS null_org_id FROM jobs                  WHERE org_id IS NULL
UNION ALL SELECT 'clients',              count(*) FROM clients              WHERE org_id IS NULL
UNION ALL SELECT 'properties',           count(*) FROM properties           WHERE org_id IS NULL
UNION ALL SELECT 'recurring_schedules',  count(*) FROM recurring_schedules  WHERE org_id IS NULL
UNION ALL SELECT 'recurrence_exceptions',count(*) FROM recurrence_exceptions WHERE org_id IS NULL
UNION ALL SELECT 'ical_events',          count(*) FROM ical_events          WHERE org_id IS NULL
UNION ALL SELECT 'property_icals',       count(*) FROM property_icals       WHERE org_id IS NULL
ORDER BY 2 DESC, 1;

\echo '=== 2a. Schedules where the two day representations disagree ==='
SELECT id, client_id, frequency, day_of_week, days_of_week, active
FROM recurring_schedules
WHERE days_of_week IS NOT NULL
  AND (days_of_week::jsonb ->> 0)::int IS DISTINCT FROM day_of_week
ORDER BY active DESC, id;

\echo '=== 2b. Multi-day schedules (day_of_week is definitionally incomplete here) ==='
SELECT count(*) FILTER (WHERE active)     AS active_multiday,
       count(*) FILTER (WHERE NOT active) AS inactive_multiday
FROM recurring_schedules
WHERE days_of_week IS NOT NULL
  AND jsonb_array_length(days_of_week::jsonb) > 1;

\echo '=== 3a. Duplicate gcal_event_id ==='
SELECT gcal_event_id, count(*) AS n, array_agg(id ORDER BY id) AS job_ids
FROM jobs WHERE gcal_event_id IS NOT NULL
GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC;

\echo '=== 3b. Duplicate gcal_ical_uid ==='
SELECT gcal_ical_uid, count(*) AS n, array_agg(id ORDER BY id) AS job_ids
FROM jobs WHERE gcal_ical_uid IS NOT NULL
GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC;

\echo '=== 4. Connecteam sync integrity ==='
SELECT 'dispatched but no shift ids' AS check_name, count(*) AS n
FROM jobs
WHERE dispatched = true
  AND (connecteam_shift_ids IS NULL
       OR jsonb_array_length(connecteam_shift_ids::jsonb) = 0)
UNION ALL
SELECT 'closed job still holding shifts', count(*)
FROM jobs
WHERE status IN ('cancelled','completed')
  AND connecteam_shift_ids IS NOT NULL
  AND jsonb_array_length(connecteam_shift_ids::jsonb) > 0
UNION ALL
SELECT 'shift count <> cleaner count (partial push)', count(*)
FROM jobs
WHERE job_type <> 'str_turnover'
  AND connecteam_shift_ids IS NOT NULL
  AND jsonb_array_length(connecteam_shift_ids::jsonb) > 0
  AND jsonb_array_length(connecteam_shift_ids::jsonb)
      <> jsonb_array_length(COALESCE(cleaner_ids,'[]')::jsonb)
UNION ALL
SELECT 'has snapshot missing cleaner_ids key (legacy shape)', count(*)
FROM jobs
WHERE connecteam_synced_schedule IS NOT NULL
  AND NOT (connecteam_synced_schedule::jsonb ? 'cleaner_ids');

\echo '=== 4b. The partial-push jobs, in detail ==='
SELECT id, scheduled_date, status, job_type, cleaner_ids, connecteam_shift_ids
FROM jobs
WHERE job_type <> 'str_turnover'
  AND connecteam_shift_ids IS NOT NULL
  AND jsonb_array_length(connecteam_shift_ids::jsonb) > 0
  AND jsonb_array_length(connecteam_shift_ids::jsonb)
      <> jsonb_array_length(COALESCE(cleaner_ids,'[]')::jsonb)
ORDER BY scheduled_date DESC
LIMIT 40;

\echo '=== 5a. calendar_source_of_truth setting ==='
SELECT * FROM app_settings WHERE key ILIKE '%calendar%' OR key ILIKE '%source_of_truth%';

\echo '=== 5b. Distinct job status values ==='
SELECT status, count(*) FROM jobs GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 5c. Jobs with no date but status says scheduled ==='
SELECT count(*) FROM jobs WHERE scheduled_date IS NULL AND status = 'scheduled';
