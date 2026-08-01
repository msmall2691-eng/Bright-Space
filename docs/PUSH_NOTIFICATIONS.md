# Push notifications — where we are & what's left

BrightBase is now an installable PWA. When you "Add to Home Screen" you get a
real app icon, a standalone (no browser chrome) window, and the *client* half
of web-push is already in place. This doc explains the last mile so we can turn
notifications on.

## What already works (this change)

- **Service worker** (`frontend/public/sw.js`) with `push` and
  `notificationclick` handlers. It can already receive a push and show a
  notification that deep-links into the app when tapped.
- **Installability** — Chrome/Android show "Install app"; iOS 16.4+ can add to
  Home Screen and receive pushes *once the user grants permission from an
  installed PWA* (iOS only allows push for installed PWAs, not Safari tabs).

## What's left (backend + one small frontend hook)

Web-push is a 4-step handshake. Steps 1–2 are done; 3–4 remain:

1. ✅ Service worker registered.
2. ✅ `push` handler renders `{ title, body, url, tag }` payloads.
3. ⬜ **Subscribe the device.** After the user opts in, call
   `Notification.requestPermission()` then
   `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey: <VAPID public key> })` and POST the resulting
   subscription JSON to a new backend endpoint (`POST /push/subscriptions`).
   Best placed behind an explicit "Enable notifications" toggle in **Settings**
   (never prompt on load — browsers penalize that and it feels spammy).
4. ⬜ **Send from the backend.** Store subscriptions per-user, generate a VAPID
   keypair once (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` env vars), and send
   with the `pywebpush` library from the events that matter — e.g. a new job
   dispatched, a visit starting soon, or the `sync_reconcile_tick` surfacing a
   sync failure.

### Rough backend sketch (FastAPI + pywebpush)

```python
# pip install pywebpush
from pywebpush import webpush, WebPushException

def send_push(subscription: dict, title: str, body: str, url: str = "/"):
    webpush(
        subscription_info=subscription,
        data=json.dumps({"title": title, "body": body, "url": url}),
        vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
        vapid_claims={"sub": "mailto:ops@brightbase.app"},
    )
```

Store subscriptions in a `push_subscriptions` table
(`user_id`, `endpoint`, `p256dh`, `auth`, `created_at`) and drop any that
return `410 Gone` on send.

## Good first notification triggers

- New job assigned / dispatched to a cleaner.
- Visit starting within N minutes (from the schedule).
- A sync reconcile tick that failed to push to Google Calendar / Connecteam.

When you're ready to wire step 3–4, say the word and I'll add the Settings
toggle, the subscribe endpoint, the table migration, and the send helper.
