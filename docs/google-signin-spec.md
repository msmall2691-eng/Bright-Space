# Spec — "Sign in with Google" for admins

Status: proposed · Scope: authentication (login), distinct from the existing
Google **Calendar** integration.

## 1. Goal

Let admins log into Bright-Space by clicking **Sign in with Google** and
authenticating with their work Google account, instead of (or in addition to)
an email + password. The rest of the app is unchanged: a successful Google
sign-in produces the **same app JWT** the password flow already issues, so every
existing `Authorization: Bearer` path keeps working.

### What this is NOT
- It is **not** the calendar integration. `/api/settings/google/connect` +
  `/google/callback` already exist and request the `calendar` scope to store one
  **shared business** token (`app_settings.google_token`) for reading/writing the
  company calendar. That is an integration credential, not a user identity.
- Sign-in requests only `openid email profile`. Keep the two flows separate so a
  login never over-permissions and the calendar token is never user-specific.

## 2. The "my login email isn't the one I want" problem (do this first)

Today login matches `User.email` exactly (`modules/auth/router.py:login`). To log
in as your **work** identity:

1. Decide the exact work email you'll sign in with (must equal the Google
   account's address, e.g. `office@mainecleaningco.com` or `you@mainecleaningco.com`).
2. **Provision an admin User** with that email. Pick one:
   - **Bootstrap (simplest):** set `ADMIN_BOOTSTRAP_EMAIL` = the work email and
     `ADMIN_BOOTSTRAP_PASSWORD` = a temp password on Railway, then redeploy.
     `database/db.py:_bootstrap_admin_user` creates it if absent (idempotent;
     skips if the email already exists).
   - **In-app:** while logged in as the current admin, create the user, then
     promote to `admin` (note: `POST /api/auth/register` defaults new users to
     `client`; promotion is a separate authenticated update — see §6 gap).
   - **Rename:** update the existing admin row's `email` to the work email.
3. After Google sign-in ships, that user signs in with Google and never needs the
   temp password again.

> The Google account you sign in with must own the provisioned email. Signing in
> with a personal Google account won't match a `office@…` user.

## 3. Data model changes (`database/models.py` → `User`)

`User.password_hash` is currently `nullable=False`. SSO-only users have no
password. Changes:

- Make `password_hash` **nullable** (`Column(String, nullable=True)`).
- Add `google_sub = Column(String, nullable=True, unique=True, index=True)` —
  Google's stable subject id, bound on first Google sign-in. Future-proofs
  against email changes and is stronger than email-only matching.
- Add `auth_provider = Column(String, nullable=True)` — informational
  (`"password"` | `"google"`), optional.

Migration: this app calls `Base.metadata.create_all` on boot and does ad-hoc
column adds elsewhere; add the two columns the same way (or an Alembic migration
if the project has one). New columns are additive and nullable — safe.

Password login guard: in `login`, reject when `user.password_hash` is null
("This account uses Sign in with Google.") so a passwordless SSO user can't be
brute-forced.

## 4. Backend — new auth endpoints (`modules/auth/router.py`)

Reuse `integrations/google_oauth.py` but with **login scopes**. Add a sibling
builder so the calendar flow's scopes are untouched:

```python
# integrations/google_oauth.py
LOGIN_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email",
                "https://www.googleapis.com/auth/userinfo.profile"]

def build_login_flow(request, state=None):
    cfg = _client_config()           # same Web OAuth client
    if not cfg: raise RuntimeError(...)
    return Flow.from_client_config(cfg, scopes=LOGIN_SCOPES,
        redirect_uri=login_redirect_uri(request), state=state)

def login_redirect_uri(request):     # mirrors redirect_uri() but for /auth
    return os.getenv("GOOGLE_LOGIN_REDIRECT_URI") or f"{_https_base(request)}/api/auth/google/callback"
```

### `GET /api/auth/google/start` (public)
- Build the login flow, `authorization_url(prompt="select_account", state=<nonce>)`.
- Store the nonce server-side (short TTL) for CSRF — e.g. an `app_settings`
  row keyed by nonce, or a signed cookie. Return `{auth_url}`.

### `GET /api/auth/google/callback` (public — add to `_PUBLIC_PREFIXES` in `auth.py`)
- Verify `state` matches the stored nonce; delete it (one-time).
- `flow.fetch_token(code=...)`, then **verify the ID token**:
  ```python
  from google.oauth2 import id_token
  from google.auth.transport import requests as grequests
  info = id_token.verify_oauth2_token(flow.credentials.id_token,
              grequests.Request(), audience=<client_id>)
  email, verified, sub, name = info["email"], info.get("email_verified"), info["sub"], info.get("name")
  ```
- **Authorization rules (default-deny):**
  - Require `email_verified is True`.
  - Optional domain allowlist: if `GOOGLE_SSO_ALLOWED_DOMAINS` is set, the
    email's domain must be in it.
  - Look up `User` by `google_sub` first, else by case-insensitive `email`.
  - If **no** matching user, or `user.active` is False → **reject** (302 to
    `/login?sso_error=not_provisioned`). Do **not** auto-create accounts —
    otherwise anyone with a Google account could sign in.
  - On first match by email, persist `user.google_sub = sub` (bind identity).
- Issue the app JWT exactly as password login does:
  `create_jwt(user.id, user.email, user.role)`, set `user.last_login_at`.
- **Hand the JWT to the SPA securely** (avoid a raw JWT in the URL). Preferred:
  - Store a **one-time code** → JWT mapping server-side (short TTL), redirect to
    `/login?sso_code=<code>`; the SPA calls `POST /api/auth/google/exchange`
    `{code}` to receive `{access_token, ...}` and then `setJWT`.
  - Simpler (acceptable v1, note the tradeoff): redirect to
    `/login#token=<jwt>`; SPA reads the hash, `setJWT`, strips it.

### `POST /api/auth/google/exchange` (public)
- Trades the one-time `sso_code` for the JWT (the LoginResponse shape). Deletes
  the code. Only needed if using the one-time-code variant (recommended).

## 5. Frontend (`pages/Login.jsx`)

- Add a **"Sign in with Google"** button (lucide icon or Google mark) under the
  existing form, with a divider ("or").
- Handler: `const r = await get('/api/auth/google/start'); window.location.href = r.auth_url`.
- On load, handle the return:
  - one-time-code: read `?sso_code`, `POST /api/auth/google/exchange`, `setJWT`,
    clear the param, navigate to `/dashboard`.
  - hash variant: read `#token`, `setJWT`, strip hash.
  - read `?sso_error=...` → show a friendly message ("This Google account isn't
    set up for Bright-Space. Ask an admin to add it.").
- Nothing else changes — `setJWT` already drives the authed shell.

## 6. Gaps to close alongside (small)
- **User-promote endpoint**: there's no obvious authenticated "set role" route,
  so provisioning an admin via the UI needs one (admin-only
  `PATCH /api/auth/users/{id}` → role). Bootstrap avoids this for now.
- **Account-settings note**: surface on the Settings/Profile area which sign-in
  methods an account has (password vs Google), once SSO lands.

## 7. Config / env
- Reuse the existing **Web** OAuth client (`GOOGLE_CREDENTIALS_B64` /
  `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET`). In Google Cloud, add a second
  **Authorized redirect URI**: `https://<api-domain>/api/auth/google/callback`.
- New env (optional): `GOOGLE_LOGIN_REDIRECT_URI` (explicit override),
  `GOOGLE_SSO_ALLOWED_DOMAINS` (comma list, e.g. `mainecleaningco.com`).
- Add the consent screen scopes `openid email profile` (non-sensitive; no
  Google verification review needed).

## 8. Security checklist
- ID token signature + audience verified (not just "we got a token").
- `email_verified` required; optional domain allowlist.
- **Existing, active users only** — no auto-provisioning by default.
- One-time, server-stored `state` nonce (CSRF) and one-time `sso_code` (no JWT
  in browser history / referer).
- Callback path added to `_PUBLIC_PREFIXES` (no API key on Google's redirect),
  protected by the nonce.
- Rate-limit `/auth/google/start` like `/auth/login` (`5/minute`).

## 9. Test checklist
- Provisioned admin signs in with Google → lands on dashboard with admin JWT.
- Un-provisioned Google account → `sso_error=not_provisioned`, no session.
- Inactive user → rejected.
- Password login still works for password users; SSO-only user can't password-login.
- `state` mismatch / replayed code → rejected.
- Domain allowlist (when set) blocks out-of-domain emails.

## 10. Future (not in v1)
- **Unify with calendar**: once an admin signs in with Google, optionally use
  incremental auth to also grant the `calendar` scope, so "sign in" and "connect
  your calendar" become one step. Keep them separate for v1.
- Auto-provision-on-domain (toggle) for fast team onboarding.
