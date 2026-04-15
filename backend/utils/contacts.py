import re
from typing import Optional
from sqlalchemy.orm import Session

from database.models import Client


def normalize_phone(phone: Optional[str]) -> Optional[str]:
    """Normalize to a compact US-friendly representation (+1XXXXXXXXXX when possible)."""
    if not phone:
        return None
    raw = str(phone).strip()
    if not raw:
        return None

    digits = re.sub(r"\D", "", raw)
    if not digits:
        return raw

    # US 10-digit -> +1XXXXXXXXXX
    if len(digits) == 10:
        return f"+1{digits}"
    # US 11-digit with leading 1 -> +1XXXXXXXXXX
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    # Fallback international-ish
    if raw.startswith("+"):
        return f"+{digits}"
    return f"+{digits}"


def phone_last10(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 10:
        return None
    return digits[-10:]


def find_client_by_contact(db: Session, *, email: Optional[str] = None, phone: Optional[str] = None) -> Optional[Client]:
    """Find a client by email first, then normalized/fuzzy phone (last-10 fallback)."""
    if email:
        e = email.strip().lower()
        if e:
            match = db.query(Client).filter(Client.email.ilike(e)).first()
            if match:
                return match

    n_phone = normalize_phone(phone)
    if n_phone:
        exact = db.query(Client).filter(Client.phone == n_phone).first()
        if exact:
            return exact

    last10 = phone_last10(phone)
    if last10:
        # lightweight prefilter then deterministic compare in Python
        candidates = db.query(Client).filter(Client.phone.isnot(None), Client.phone.like(f"%{last10}")).all()
        for c in candidates:
            if phone_last10(c.phone) == last10:
                return c

    return None
