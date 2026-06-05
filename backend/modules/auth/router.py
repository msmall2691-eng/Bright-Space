import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import User, AppSetting
from auth_jwt import hash_password, verify_password, create_jwt, verify_jwt
from ratelimit import limiter

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


class RegisterRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None


class RegisterResponse(BaseModel):
    user_id: int
    email: str
    full_name: str
    role: str
    # Set when an allow-listed email self-registers, so the UI logs them in.
    access_token: Optional[str] = None
    token_type: str = "bearer"


def _signup_allowlist() -> list[str]:
    """Emails permitted to self-register (as admins) without an existing admin —
    reuses the same allow-list as Google sign-in. Lets the owner create their
    account without opening signup to the whole internet."""
    import os
    raw = os.getenv("SIGNUP_ALLOWED_EMAILS") or os.getenv("GOOGLE_ALLOWED_EMAILS", "")
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


class UserResponse(BaseModel):
    user_id: int
    email: str
    full_name: str
    role: str
    active: bool


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

        if not user.active:
            raise HTTPException(status_code=403, detail="Account disabled")

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
    """
    def check_role(current_user: User = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return check_role


@router.post("/login", response_model=LoginResponse)
@limiter.limit("5/minute")
def login(request: Request, data: LoginRequest, db: Session = Depends(get_db)):
    """Login with email and password, returns JWT token."""
    user = db.query(User).filter(User.email == data.email).first()

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
    return LoginResponse(access_token=token, user_id=user.id, email=user.email, role=user.role)


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
    """Default-deny match/provision for a verified Google email. Existing
    admin/manager users or allow-listed emails (GOOGLE_ALLOWED_EMAILS /
    _DOMAINS) are accepted; allow-listed new emails become admins."""
    allowed_emails = [e.strip().lower() for e in os.getenv("GOOGLE_ALLOWED_EMAILS", "").split(",") if e.strip()]
    allowed_domains = [d.strip().lower() for d in os.getenv("GOOGLE_ALLOWED_DOMAINS", "").split(",") if d.strip()]
    domain_ok = email.split("@")[-1] in allowed_domains if allowed_domains else False

    user = db.query(User).filter(User.google_sub == sub).first() if sub else None
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        if not user.active:
            raise HTTPException(status_code=403, detail="This account is inactive.")
        if user.role not in ("admin", "manager") and email not in allowed_emails and not domain_ok:
            raise HTTPException(status_code=403, detail="This Google account isn't authorized for admin access.")
    else:
        if email not in allowed_emails and not domain_ok:
            raise HTTPException(status_code=403, detail="This Google account isn't authorized. Ask an admin to add it.")
        user = User(email=email, password_hash=None, full_name=name or email,
                    role="admin", auth_provider="google", active=True)
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
    return LoginResponse(access_token=token, user_id=payload["user_id"], email=payload["email"], role=payload["role"])


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("5/minute")
def register(
    request: Request,
    data: RegisterRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """
    Create a user. Two safe paths only:
      1. An authenticated admin creates a user (defaults to role=client).
      2. An allow-listed email (SIGNUP_ALLOWED_EMAILS / GOOGLE_ALLOWED_EMAILS)
         self-registers as an admin — so the owner can bootstrap their own
         account without an existing admin.

    BB-SEC-07: open / empty-table self-registration is still disabled (it let
    whoever POSTed first on a fresh/wiped DB grab admin). The allow-list keeps
    self-signup restricted to known emails.
    """
    email_l = (data.email or "").strip().lower()
    is_admin_caller = bool(current_user and current_user.role == "admin")
    allowlisted = email_l in _signup_allowlist()

    if not is_admin_caller and not allowlisted:
        raise HTTPException(
            status_code=403,
            detail="Sign-up isn't open. Ask an admin to add you, or sign in with an authorized Google account."
        )

    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Allow-listed self-signups are the owner bootstrapping → admin. Users an
    # admin creates default to the lowest-privilege role (promote later).
    role = "admin" if allowlisted else "client"
    new_user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        full_name=data.full_name or data.email.split("@")[0],
        role=role,
        auth_provider="password",
        active=True,
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Log allow-listed self-signups straight in; admin-created users don't get a
    # token (the admin stays signed in as themselves).
    token = create_jwt(new_user.id, new_user.email, new_user.role) if (allowlisted and not is_admin_caller) else None

    return RegisterResponse(
        user_id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        role=new_user.role,
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
    )
