# Push notifications

BrightBase can send Web Push notifications to installed PWAs and desktop
browsers. Staff get a buzz for:

- **📥 New request** — a lead form / InstantEstimate submission (fires once, on
  genuinely new leads; deduped submissions don't re-buzz).
- **💬 New message** — an inbound SMS lands in the unified inbox.
- **👀 Quote viewed** — a customer opens their quote link (a great follow-up cue).

Everything is **best-effort and off by default** — the app runs exactly as
before until you (1) set VAPID keys on the backend and (2) flip the toggle in
Settings on each device.

## One-time server setup

1. Generate a VAPID keypair:

   ```bash
   cd backend
   pip install -r requirements.txt      # adds pywebpush
   python scripts/gen_vapid_keys.py
   ```

2. Copy the three lines it prints into the Railway backend service's env vars:

   ```
   VAPID_PUBLIC_KEY=…
   VAPID_PRIVATE_KEY=…            # secret — backend only
   VAPID_SUBJECT=mailto:you@yourdomain.com
   ```

3. Redeploy. The migration `062_push_subscriptions` creates the table
   (`alembic upgrade head` runs as part of the normal deploy).

That's it — `GET /api/push/vapid-public-key` now reports `enabled: true` and the
Settings toggle goes live.

## Turning it on (per device)

Settings → General → **Notifications** → flip **Push notifications** on, accept
the browser prompt, then tap **Send a test notification** to confirm.

- **iOS:** notifications only work for a PWA **installed to the Home Screen**
  (iOS 16.4+), never a plain Safari tab — install first (Share → Add to Home
  Screen), open the installed app, then enable.
- Each device/browser subscribes independently; turning it off only affects
  that device.

## How it fits together

| Piece | Location |
|-------|----------|
| Service worker (receives + shows the push, deep-links on tap) | `frontend/public/sw.js` |
| Browser subscribe / unsubscribe / test | `frontend/src/utils/push.js` |
| Settings toggle | `frontend/src/components/settings/NotificationsCard.jsx` |
| Subscription API (`/api/push/*`) | `backend/modules/push/router.py` |
| Send helper (`notify_staff`) + VAPID | `backend/services/push_service.py` |
| Subscriptions table | `backend/database/models.py` (`PushSubscription`) + migration `062` |
| Event hooks | quoting router (viewed), comms router (inbound SMS), intake `upsert_lead` (new request) |

`notify_staff(db, title, body, url=…, tag=…, org_id=…)` opens its own short-lived
DB session, so calling it from a request handler never touches that request's
transaction. It prunes any subscription that returns `404/410 Gone` so the
table self-heals.

## Adding a new trigger

Call `notify_staff` from wherever the event happens, e.g.:

```python
from services.push_service import notify_staff
notify_staff(db, "🧹 Job assigned", f"{cleaner} — {job.title}",
             url="/schedule", tag=f"job-{job.id}", org_id=job.org_id)
```

Good candidates not yet wired: job dispatched to a cleaner, a visit starting
soon, a `sync_reconcile_tick` that failed to push to Google/Connecteam.
