from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import User
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
    sub = info.get("sub")
    name = info.get("name") or ""

    allowed_emails = [e.strip().lower() for e in os.getenv("GOOGLE_ALLOWED_EMAILS", "").split(",") if e.strip()]
    allowed_domains = [d.strip().lower() for d in os.getenv("GOOGLE_ALLOWED_DOMAINS", "").split(",") if d.strip()]
    domain_ok = email.split("@")[-1] in allowed_domains if allowed_domains else False

    # Match an existing user by Google identity first, then by email.
    user = db.query(User).filter(User.google_sub == sub).first() if sub else None
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        if not user.active:
            raise HTTPException(status_code=403, detail="This account is inactive.")
        # Existing users may use Google sign-in only if they're admin/manager,
        # or explicitly allow-listed.
        if user.role not in ("admin", "manager") and email not in allowed_emails and not domain_ok:
            raise HTTPException(status_code=403, detail="This Google account isn't authorized for admin access.")
    else:
        # No user yet — auto-provision an admin ONLY when allow-listed. Never
        # open registration to arbitrary Google accounts.
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
    db.commit()
    db.refresh(user)

    token = create_jwt(user.id, user.email, user.role)
    return LoginResponse(access_token=token, user_id=user.id, email=user.email, role=user.role)


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("5/minute")
def register(
    request: Request,
    data: RegisterRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional)
):
    """
    Register a new user. Admin-only at all times.

    BB-SEC-07: previously, when the User table was empty, this endpoint
    self-promoted the caller to role="admin" with no challenge — a
    fresh deploy, a wiped database, or a Railway preview environment
    became a land-grab for whoever sent the first POST. Recovery from
    an empty user table is now via _bootstrap_admin_user (ADMIN_BOOTSTRAP_*
    env vars), not via this endpoint.
    """
    if not current_user or current_user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only administrators can create new users. Contact your admin."
        )

    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # New users default to the lowest-privilege role; admins can promote
    # later via an authenticated PATCH. Promotion-on-create would re-open
    # the BB-SEC-07 escalation path through the register UI.
    password_hash = hash_password(data.password)
    new_user = User(
        email=data.email,
        password_hash=password_hash,
        full_name=data.full_name or data.email.split("@")[0],
        role="client",
        active=True,
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return RegisterResponse(
        user_id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        role=new_user.role,
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
