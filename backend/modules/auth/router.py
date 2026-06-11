import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import User, AppSetting
from auth_jwt import hash_password, verify_password, create_jwt, verify_jwt
from ratelimit import limiter

logger = logging.getLogger(__name__)

security = HTTPBearer()

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    email: str
    role: str
    # 'active' | 'pending' | 'disabled' — pending users hold a valid identity
    # token but every API call is rejected until an admin approves them.
    status: str = "active"


class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None


class RegisterResponse(BaseModel):
    user_id: int
    email: str
    full_name: str
    role: str
    status: str = "active"
    # Set when an email self-registers, so the UI logs them in (pending users
    # land on the waiting screen).
    access_token: Optional[str] = None
    token_type: str = "bearer"


def _signup_allowlist() -> list[str]:
    """Emails on the auto-approve lists (SIGNUP_ALLOWED_EMAILS and
    GOOGLE_ALLOWED_EMAILS, unioned). Signup is open to anyone — these lists
    only decide who skips the pending-approval step, and (on a fresh install
    with no admin yet) who bootstraps as the first admin."""
    raw = ",".join([os.getenv("SIGNUP_ALLOWED_EMAILS", ""), os.getenv("GOOGLE_ALLOWED_EMAILS", "")])
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


def _auto_approved(email: str) -> bool:
    """Whether a self-signup skips 'pending': email on either allow-list, or
    its domain on GOOGLE_ALLOWED_DOMAINS."""
    email = (email or "").strip().lower()
    if email in _signup_allowlist():
        return True
    domains = [d.strip().lower() for d in os.getenv("GOOGLE_ALLOWED_DOMAINS", "").split(",") if d.strip()]
    return bool(domains) and email.split("@")[-1] in domains


def _default_org_id(db: Session) -> Optional[int]:
    """The single v1 workspace (seeded at boot; created here defensively)."""
    from database.models import Org
    org = db.query(Org).order_by(Org.id.asc()).first()
    if not org:
        org = Org(name="Maine Cleaning Co", slug="maine-cleaning-co")
        db.add(org)
        db.flush()
    return org.id


def _active_admin_exists(db: Session) -> bool:
    return db.query(User).filter(
        User.role == "admin", User.active == True,  # noqa: E712
        (User.status == "active") | (User.status.is_(None)),
    ).first() is not None


class UserResponse(BaseModel):
    user_id: int
    email: str
    full_name: str
    role: str
    active: bool
    status: str = "active"


_optional_security = HTTPBearer(auto_error=False)


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_optional_security),
) -> User:
    """
    Dependency to extract the authenticated user.

    The APIKeyMiddleware has already gated the request — it accepts either
    a JWT Bearer token or an X-API-Key header. By the time we get here:
      • If a valid JWT was used, credentials is set and we resolve the user
        from its payload (preferred; carries real identity).
      • If a valid API key was used (no JWT), credentials may be None.
        We mint a synthetic admin User so role checks pass — the API key
        is the integration's master credential and grants full access.
    """
    if credentials:
        payload = verify_jwt(credentials.credentials)
        if not payload:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        user_id = payload.get("user_id")
        user = db.query(User).filter(User.id == user_id).first()

        if not user:
            raise HTTPException(status_code=401, detail="User not found")

        if not user.active or (user.status or "active") == "disabled":
            raise HTTPException(status_code=403, detail="Account disabled")

        # Signed up but not yet approved: valid identity, zero data access.
        # The frontend recognizes this detail and shows the waiting screen.
        if (user.status or "active") == "pending":
            raise HTTPException(status_code=403, detail="pending_approval")

        return user

    # No Bearer — middleware must have admitted us via API key.
    # Surface a synthetic admin user (not persisted) for role checks.
    import os as _os
    if _os.getenv("BRIGHTBASE_API_KEY", ""):
        synthetic = User(id=0, email="api-key@internal", full_name="API Key", role="admin", active=True)
        return synthetic

    raise HTTPException(status_code=401, detail="Not authenticated")


def get_current_user_optional(
    request: Request,
    db: Session = Depends(get_db)
) -> Optional[User]:
    """
    Optional JWT verification. Returns None if no token provided or token is invalid.
    Used for endpoints that work with or without authentication.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None

    token = auth_header[7:]  # Remove "Bearer " prefix
    payload = verify_jwt(token)
    if not payload:
        return None

    user_id = payload.get("user_id")
    user = db.query(User).filter(User.id == user_id).first()
    return user


def require_role(*allowed_roles):
    """
    Factory to create a dependency that requires specific roles.
    Usage: Depends(require_role("admin", "manager"))

    'member' (an approved workspace signup) works the business like a manager
    — jobs, quotes, comms — but never passes admin-only checks. Expanding it
    here keeps the 160+ existing require_role call sites untouched.
    """
    def check_role(current_user: User = Depends(get_current_user)):
        roles = set(allowed_roles)
        if "manager" in roles:
            roles.add("member")
        if current_user.role not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return check_role


@router.post("/login", response_model=LoginResponse)
@limiter.limit("5/minute")
def login(request: Request, data: LoginRequest, db: Session = Depends(get_db)):
    """Login with email and password, returns JWT token."""
    # Case-insensitive email match — the account may have been created as
    # "Office@…" while a phone keyboard types "office@…". Exact matching was
    # rejecting valid logins (looked like an endless redirect on mobile).
    email_in = (data.email or "").strip()
    user = (
        db.query(User).filter(func.lower(User.email) == email_in.lower()).first()
        or db.query(User).filter(User.email == data.email).first()
    )

    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.active:
        raise HTTPException(status_code=403, detail="User account is inactive")

    # Google-SSO-only accounts have no password — don't let them be brute-forced.
    if not user.password_hash:
        raise HTTPException(status_code=403, detail="This account uses Sign in with Google.")

    if not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Create JWT token
    token = create_jwt(user.id, user.email, user.role)

    return LoginResponse(
        access_token=token,
        user_id=user.id,
        email=user.email,
        role=user.role,
        status=user.status or "active",
    )


class GoogleSignInRequest(BaseModel):
    credential: str  # Google ID token (JWT) from Google Identity Services


@router.get("/google/config")
def google_signin_config():
    """Public: tells the login page whether Google sign-in is available and the
    client id to initialize the Google button with. The client id is not secret."""
    from integrations.google_oauth import client_id as _google_client_id
    cid = _google_client_id()
    return {"enabled": bool(cid), "client_id": cid}


@router.post("/google", response_model=LoginResponse)
@limiter.limit("10/minute")
def google_signin(request: Request, data: GoogleSignInRequest, db: Session = Depends(get_db)):
    """Sign in with Google. Verifies the Google ID token, then matches a known
    user (default-deny): existing admin/manager users, or emails/domains on the
    allow-list (GOOGLE_ALLOWED_EMAILS / GOOGLE_ALLOWED_DOMAINS) which are
    auto-provisioned as admins. Returns the same JWT as password login."""
    import os
    from datetime import datetime, timezone
    from integrations.google_oauth import client_id as _google_client_id

    cid = _google_client_id()
    if not cid:
        raise HTTPException(status_code=503, detail="Google sign-in isn't configured on the server.")

    # Verify the ID token's signature + audience against our OAuth client.
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
        info = google_id_token.verify_oauth2_token(data.credential, google_requests.Request(), cid)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Google sign-in.")

    if info.get("aud") != cid or not info.get("email") or not info.get("email_verified"):
        raise HTTPException(status_code=401, detail="Invalid or unverified Google account.")

    email = info["email"].strip().lower()
    user = _resolve_google_user(db, email, info.get("sub"), info.get("name") or "")
    db.commit()
    db.refresh(user)

    token = create_jwt(user.id, user.email, user.role)
    return LoginResponse(access_token=token, user_id=user.id, email=user.email, role=user.role,
                         status=user.status or "active")


# ── shared helpers for Google auth ──────────────────────────────────────────
def _app_get(db: Session, key: str) -> Optional[str]:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


def _app_set(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _app_del(db: Session, key: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        db.delete(row)


def _resolve_google_user(db: Session, email: str, sub: Optional[str], name: str) -> User:
    """Match or provision a verified Google identity (Twenty-style open signup).

    Existing users sign in regardless of allow-lists — pending/disabled is
    enforced downstream by get_current_user. NEW users are provisioned as
    role='member' — NEVER auto-admin — and start 'pending' unless their
    email/domain is on the auto-approve lists. The only exception: a fresh
    install with no active admin yet bootstraps an allow-listed signup as the
    first admin (someone has to be able to approve everyone else)."""
    user = db.query(User).filter(User.google_sub == sub).first() if sub else None
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        if not user.active or (user.status or "active") == "disabled":
            raise HTTPException(status_code=403, detail="This account is inactive.")
    else:
        approved = _auto_approved(email)
        bootstrap_admin = approved and not _active_admin_exists(db)
        user = User(email=email, password_hash=None, full_name=name or email,
                    role="admin" if bootstrap_admin else "member",
                    auth_provider="google", active=True,
                    org_id=_default_org_id(db),
                    status="active" if approved else "pending")
        db.add(user)
        db.flush()

    if sub and not user.google_sub:
        user.google_sub = sub
    if not user.auth_provider:
        user.auth_provider = "google"
    user.last_login_at = datetime.now(timezone.utc)
    return user


def _is_business_calendar_account(db: Session, email: str) -> bool:
    """Whether this email is the designated business calendar account — so signing
    in as them (re)connects the shared calendar, but a different admin signing in
    never hijacks it."""
    email = (email or "").strip().lower()
    candidates = []
    biz = _app_get(db, "from_email") or os.getenv("GCAL_PRIMARY_ID") or os.getenv("GOOGLE_CALENDAR_ACCOUNT")
    if biz:
        candidates.append(biz.strip().lower())
    allow = [e.strip().lower() for e in os.getenv("GOOGLE_ALLOWED_EMAILS", "").split(",") if e.strip()]
    if allow:
        candidates.append(allow[0])
    return email in candidates


# ── Unified "Sign in with Google": identity + calendar in one consent ───────
class GoogleExchangeRequest(BaseModel):
    code: str


@router.get("/google/login-url")
def google_login_url(request: Request, db: Session = Depends(get_db)):
    """Start the unified sign-in: returns the Google consent URL (identity +
    calendar). A one-time state nonce guards the callback."""
    import secrets
    from integrations.google_oauth import build_login_flow, is_oauth_available
    if not is_oauth_available():
        return {"enabled": False}
    state = secrets.token_urlsafe(24)
    _app_set(db, f"sso_state_{state}", datetime.now(timezone.utc).isoformat())
    db.commit()
    flow = build_login_flow(request, state=state)
    auth_url, _ = flow.authorization_url(access_type="offline", include_granted_scopes="true", prompt="consent")
    return {"enabled": True, "auth_url": auth_url}


@router.get("/google/login-callback")
def google_login_callback(request: Request, code: str = "", state: str = "", db: Session = Depends(get_db)):
    """OAuth redirect target. Verifies the ID token (login) AND stores the
    calendar token (connect) in one step, then bounces back with a one-time code."""
    import secrets
    from fastapi.responses import RedirectResponse
    from integrations.google_oauth import build_login_flow, client_id as _google_client_id

    if not state or _app_get(db, f"sso_state_{state}") is None:
        raise HTTPException(status_code=400, detail="Invalid or expired sign-in state.")
    _app_del(db, f"sso_state_{state}")

    try:
        flow = build_login_flow(request, state=state)
        flow.fetch_token(code=code)
        creds = flow.credentials
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
        info = google_id_token.verify_oauth2_token(creds.id_token, google_requests.Request(), _google_client_id())
    except Exception as e:
        logger.warning(f"Google login callback failed: {e}")
        db.commit()
        return RedirectResponse(url="/login?sso_error=failed", status_code=302)

    if info.get("aud") != _google_client_id() or not info.get("email") or not info.get("email_verified"):
        db.commit()
        return RedirectResponse(url="/login?sso_error=unverified", status_code=302)

    email = info["email"].strip().lower()
    try:
        user = _resolve_google_user(db, email, info.get("sub"), info.get("name") or "")
    except HTTPException:
        db.commit()
        return RedirectResponse(url="/login?sso_error=not_authorized", status_code=302)

    # Same consent granted calendar access — persist it as the shared calendar
    # token, but only for the business account (so a second admin can't hijack it).
    if _is_business_calendar_account(db, email) or not _app_get(db, "google_token"):
        try:
            _app_set(db, "google_token", creds.to_json())
        except Exception as e:
            logger.warning(f"Could not store calendar token from login: {e}")

    token = create_jwt(user.id, user.email, user.role)
    sso_code = secrets.token_urlsafe(24)
    _app_set(db, f"sso_code_{sso_code}", f"{token}|{datetime.now(timezone.utc).isoformat()}")
    db.commit()
    return RedirectResponse(url=f"/login?sso_code={sso_code}", status_code=302)


@router.post("/google/exchange", response_model=LoginResponse)
def google_exchange(data: GoogleExchangeRequest, db: Session = Depends(get_db)):
    """Trade the one-time code from the login redirect for the JWT."""
    key = f"sso_code_{data.code}"
    val = _app_get(db, key)
    if not val:
        raise HTTPException(status_code=400, detail="Invalid or expired sign-in code.")
    _app_del(db, key)
    db.commit()
    token, _, ts = val.partition("|")
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).total_seconds()
    except Exception:
        age = 1e9
    if age > 300:
        raise HTTPException(status_code=400, detail="Sign-in code expired. Try again.")
    payload = verify_jwt(token)
    if not payload:
        raise HTTPException(status_code=400, detail="Invalid session.")
    u = db.query(User).filter(User.id == payload["user_id"]).first()
    return LoginResponse(access_token=token, user_id=payload["user_id"], email=payload["email"],
                         role=payload["role"], status=(u.status if u else None) or "active")


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("5/minute")
def register(
    request: Request,
    data: RegisterRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """
    Create a user. Three paths:
      1. An authenticated admin creates a user (defaults to role=client).
      2. An auto-approved email (SIGNUP_ALLOWED_EMAILS / GOOGLE_ALLOWED_EMAILS /
         GOOGLE_ALLOWED_DOMAINS) self-registers active — and bootstraps as the
         FIRST admin only when no active admin exists yet.
      3. Anyone else self-registers as role='member', status='pending' — a
         valid identity with zero data access until an admin approves it.

    BB-SEC-07 still holds: open self-registration can never grab admin — the
    bootstrap-admin path requires the allow-list AND an admin-less install.
    """
    email_l = (data.email or "").strip().lower()
    is_admin_caller = bool(current_user and current_user.role == "admin")
    allowlisted = _auto_approved(email_l)

    # Check if email already exists (case-insensitive).
    existing = (
        db.query(User).filter(func.lower(User.email) == (data.email or "").strip().lower()).first()
        or db.query(User).filter(User.email == data.email).first()
    )
    if existing:
        # Let an allow-listed owner SET a password on their existing passwordless
        # (Google-created) account, so they can also log in with email/password
        # (e.g. on mobile). If a password already exists, it's a real duplicate.
        if allowlisted and not existing.password_hash:
            existing.password_hash = hash_password(data.password)
            existing.auth_provider = existing.auth_provider or "password"
            existing.active = True
            db.commit()
            db.refresh(existing)
            return RegisterResponse(
                user_id=existing.id,
                email=existing.email,
                full_name=existing.full_name or existing.email.split("@")[0],
                role=existing.role,
                status=existing.status or "active",
                access_token=create_jwt(existing.id, existing.email, existing.role),
            )
        raise HTTPException(status_code=409, detail="Email already registered")

    # Roles: admin-created users default to the lowest-privilege role
    # (promote later); self-signups are members — the bootstrap-admin
    # exception only fires on an install with no active admin yet.
    if is_admin_caller:
        role, status = "client", "active"
    elif allowlisted:
        role = "admin" if not _active_admin_exists(db) else "member"
        status = "active"
    else:
        role, status = "member", "pending"

    new_user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        full_name=data.full_name or data.email.split("@")[0],
        role=role,
        auth_provider="password",
        active=True,
        org_id=_default_org_id(db),
        status=status,
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Log self-signups straight in (pending users land on the waiting screen);
    # admin-created users don't get a token (the admin stays signed in).
    token = create_jwt(new_user.id, new_user.email, new_user.role) if not is_admin_caller else None

    return RegisterResponse(
        user_id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        role=new_user.role,
        status=new_user.status or "active",
        access_token=token,
    )


@router.get("/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(get_current_user)):
    """Get current authenticated user's info."""
    return UserResponse(
        user_id=current_user.id,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        active=current_user.active,
        status=current_user.status or "active",
    )


@router.get("/session-status")
def session_status(request: Request, db: Session = Depends(get_db)):
    """Pending-tolerant status probe for the waiting screen. A pending user's
    JWT can't pass get_current_user (every data endpoint 403s), but they still
    need a way to learn that an admin approved them."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = verify_jwt(auth_header[7:])
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == payload.get("user_id")).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return {"status": user.status or "active", "role": user.role,
            "email": user.email, "active": user.active}


# ── Admin: workspace user management (Settings → Users) ─────────────────────

ASSIGNABLE_ROLES = {"admin", "manager", "member", "viewer", "cleaner", "client"}


class AdminUserUpdate(BaseModel):
    role: Optional[str] = None
    active: Optional[bool] = None


def _user_row(db: Session, u: User) -> dict:
    from database.models import UserGoogleAccount
    has_google_grant = db.query(UserGoogleAccount.id).filter(
        UserGoogleAccount.user_id == u.id).first() is not None
    return {
        "id": u.id,
        "email": u.email,
        "full_name": u.full_name,
        "role": u.role,
        "status": u.status or "active",
        "active": u.active,
        "auth_provider": u.auth_provider,
        "google_connected": bool(u.google_sub) or has_google_grant,
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


def _ensure_not_last_admin(db: Session, user: User):
    """Refuse a change that would leave the workspace with no active admin."""
    if user.role != "admin":
        return
    others = db.query(User).filter(
        User.id != user.id, User.role == "admin", User.active == True,  # noqa: E712
        (User.status == "active") | (User.status.is_(None)),
    ).count()
    if others == 0:
        raise HTTPException(status_code=409, detail="Can't remove or demote the last active admin.")


@router.get("/users", dependencies=[Depends(require_role("admin"))])
def list_workspace_users(db: Session = Depends(get_db), include_clients: bool = False):
    """All workspace users for the admin Users screen. Customer logins
    (role=client) are hidden by default — they're portal accounts, not staff."""
    q = db.query(User)
    if not include_clients:
        q = q.filter(User.role != "client")
    users = q.all()
    rows = [_user_row(db, u) for u in users]
    # Pending approvals float to the top; then alphabetical.
    rows.sort(key=lambda r: (0 if r["status"] == "pending" else 1, (r["full_name"] or r["email"]).lower()))
    return rows


@router.post("/users/{user_id}/approve")
def approve_user(user_id: int, db: Session = Depends(get_db),
                 current_user: User = Depends(require_role("admin"))):
    """Approve a pending signup: they keep their role (member) and gain access."""
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if (u.status or "active") == "pending":
        u.status = "active"
        u.approved_by = current_user.id
        u.approved_at = datetime.now(timezone.utc)
        db.commit()
        logger.info(f"[auth] {current_user.email} approved signup {u.email} (role={u.role})")
    return _user_row(db, u)


@router.post("/users/{user_id}/deny")
def deny_user(user_id: int, db: Session = Depends(get_db),
              current_user: User = Depends(require_role("admin"))):
    """Deny a pending signup (or shut off an account): status=disabled."""
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    _ensure_not_last_admin(db, u)
    u.status = "disabled"
    db.commit()
    logger.info(f"[auth] {current_user.email} denied/disabled {u.email}")
    return _user_row(db, u)


@router.patch("/users/{user_id}")
def update_workspace_user(user_id: int, data: AdminUserUpdate, db: Session = Depends(get_db),
                          current_user: User = Depends(require_role("admin"))):
    """Change a user's role or active flag. Guarded so the workspace can never
    lose its last active admin."""
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if data.role is not None:
        if data.role not in ASSIGNABLE_ROLES:
            raise HTTPException(status_code=400, detail=f"Unknown role '{data.role}'")
        if u.role == "admin" and data.role != "admin":
            _ensure_not_last_admin(db, u)
        u.role = data.role
    if data.active is not None:
        if not data.active:
            _ensure_not_last_admin(db, u)
        u.active = data.active
        # Re-enabling a disabled account restores access in one step.
        if data.active and (u.status or "active") == "disabled":
            u.status = "active"
    db.commit()
    logger.info(f"[auth] {current_user.email} updated user {u.email}: "
                f"role={data.role!r} active={data.active!r}")
    return _user_row(db, u)
