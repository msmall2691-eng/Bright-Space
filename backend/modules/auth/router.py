from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.db import get_db
from database.models import User
from auth_jwt import hash_password, verify_password, create_jwt, verify_jwt

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


@router.post("/login", response_model=LoginResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    """Login with email and password, returns JWT token."""
    user = db.query(User).filter(User.email == data.email).first()

    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.active:
        raise HTTPException(status_code=403, detail="User account is inactive")

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


@router.post("/register", response_model=RegisterResponse)
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    """
    Register a new user. Only allowed if no users exist yet (first user),
    or if caller has admin role (future: when JWT auth is in place).
    """
    # Check if any users exist
    user_count = db.query(User).count()

    if user_count > 0:
        raise HTTPException(
            status_code=403,
            detail="Registration is closed. Contact an administrator."
        )

    # Check if email already exists
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    # Create new user (first user is always admin)
    password_hash = hash_password(data.password)
    new_user = User(
        email=data.email,
        password_hash=password_hash,
        full_name=data.full_name or data.email.split("@")[0],
        role="admin",  # First user is always admin
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


def get_current_user(
    db: Session = Depends(get_db),
    credentials: HTTPAuthCredentials = Depends(security)
) -> User:
    """
    Dependency to extract and verify JWT token from Authorization header.
    Used by protected endpoints.
    """
    token = credentials.credentials
    payload = verify_jwt(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("user_id")
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def require_role(*allowed_roles):
    """
    Factory to create a dependency that requires specific roles.
    Usage: @router.get("/admin", dependencies=[Depends(require_role("admin"))])
    """
    async def check_role(current_user: User = Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return check_role
