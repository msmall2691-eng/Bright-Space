# Real-time Gmail push (users.watch → Cloud Pub/Sub → webhook)

This is the **scaffold** for instant inbound-email sync. It's inert until the
Google Cloud side is provisioned — nothing changes on merge. Until then, the
existing **incremental poll** (Phase E, `gmail_history_id` cursor) keeps the
inbox current on the scheduler tick.

## How it works

1. Gmail publishes a tiny notification `{emailAddress, historyId}` to a Cloud
   Pub/Sub **topic** whenever a watched mailbox changes (`users.watch`).
2. A Pub/Sub **push subscription** POSTs that to our webhook
   `POST /api/integrations/gmail/push?token=<secret>`.
3. `integrations/gmail_watch.handle_push` authenticates the token, decodes the
   payload, finds the connected account, and runs the same incremental sync the
   poller uses (`run_account_inbox_sync`) — which reads `users.history.list`
   from the stored `gmail_history_id` cursor.

Watches expire in ≤7 days; `scheduler.gmail_watch_renew_tick` re-registers them
every 12h (self-gated, no-op when disabled).

## One-time GCP setup

1. **Create a Pub/Sub topic**, e.g. `projects/<proj>/topics/gmail-push`.
2. **Grant publish rights** to Gmail's service account on that topic:
   `gmail-api-push@system.gserviceaccount.com` → role **Pub/Sub Publisher**.
3. **Create a push subscription** on the topic with the endpoint:
   `https://<your-host>/api/integrations/gmail/push?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>`
4. Ensure each user's Google grant includes `gmail.readonly` (already used by
   the poll). `users.watch` needs no additional scope.

## Config

| Env var | Purpose |
|---|---|
| `GMAIL_PUBSUB_TOPIC` | Full topic name `projects/<proj>/topics/<name>`. Presence flips the feature to "available". |
| `GMAIL_PUBSUB_VERIFICATION_TOKEN` | Shared secret compared against the webhook's `?token=`. Required. |
| `GMAIL_LIVE_SYNC` | Optional env override of the DB toggle. |
| `GMAIL_WATCH_RENEW_INTERVAL_HOURS` | Renewal cadence (default 12). |

Then flip **Settings → Automation → Real-time Gmail sync** on. Saving with it on
registers a watch per connected account immediately (best-effort).

## Not included (future)

- **Send-through-Gmail** so app-sent mail threads back into the Gmail thread —
  needs a `gmail.send` scope re-consent from each user.
- OIDC-JWT verification of the Pub/Sub push (stronger than the shared URL
  token). The token approach mirrors the Calendar webhook and needs no extra
  Google client.
