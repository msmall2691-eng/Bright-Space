# Handoff: things a remote Claude Code session can't do

The recent scheduling-drift + mobile-UI work needs some verification steps
that require a local shell, a phone, or the Railway dashboard. Paste each
prompt into a Claude Code session on your Mac (or a browser Claude session
with your repo cloned) and it will pick up from there.

---

## 1. Verify the mobile UI changes actually feel right on a phone

I made mobile UI improvements to the Schedule page (bottom-sheet job
detail, sticky day header + "Jump to today" pill, sync-status pill in the
mobile header). Please:

- `cd frontend && npm install && npm run dev`
- Open the dev server URL on your phone (or in Chrome DevTools with the
  iPhone SE preset — 375×667).
- Walk through: `/schedule` in day / week / month view, tap a visit to
  open the detail sheet, scroll long day lists, try "New job" on mobile,
  and trigger the "Needs attention" state (create a job while Google
  Calendar is disconnected in Settings).
- Report anything that feels cramped, hard to tap (< 44px target),
  overflows horizontally, or gets covered by the iOS keyboard.

Anything you find, propose a small fix and I'll apply it. Do NOT redesign;
the goal is polish, not a rewrite.

---

## 2. Watch the first sync_reconcile_tick fire on Railway

New background job runs every 30 min (env var
`SYNC_RECONCILE_INTERVAL_MINUTES=30`, `SYNC_RECONCILE_ENABLED=1` default).
It pushes unsynced jobs to Google Calendar and dispatches Connecteam
shifts for assigned jobs that don't have them.

Please:
- Open the Railway backend service → Logs.
- Grep for `Sync reconcile` — it logs on every tick.
- Confirm the FIRST tick after deploy succeeds without exception traces
  (Google/Connecteam errors from real creds are the risk).
- If it errors, paste the traceback back and I'll debug.

If the tick is too chatty or too rare, adjust `SYNC_RECONCILE_INTERVAL_MINUTES`
in Railway env — no code change needed.

---

## 3. Triage the 16 Dependabot alerts

GitHub is warning on every push: 4 high, 6 moderate, 6 low. Please:

- Open https://github.com/msmall2691-eng/Bright-Space/security/dependabot
- Screenshot / copy the 4 HIGH advisories (package + CVE + advised
  version).
- Paste them back and I'll open a PR that bumps just the fixable ones
  (skipping any breaking major bumps).

Don't blindly click "Dismiss" — some may actually be reachable in our
code path.

---

## 4. (Optional) Delete the merged feature branch

`claude/quirky-feynman-wq955a` is fully merged into `main`. If you want
GitHub tidy:

    git push origin --delete claude/quirky-feynman-wq955a

Safe — every commit already exists on `main`.
