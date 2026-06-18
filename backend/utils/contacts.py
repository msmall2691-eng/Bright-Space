"""Contact-matching helpers — phone normalization and fuzzy client lookup.

Phone numbers come in inconsistent shapes: '(207) 555-1234', '207-555-1234',
'2075551234', '+12075551234', '12075551234'. Twilio webhooks always deliver
E.164 ('+12075551234'), so an inbound SMS from a contact stored as
'(207) 555-1234' previously wouldn't match. ``normalize_phone`` converts
US numbers to E.164 on write; ``find_client_by_contact`` falls back to the
last-10-digit comparison so legacy rows without normalized phones are still
findable.

Cherry-picked from #12 (audit/Twenty-CRM PR) where the helper was first
introduced. The corresponding caller updates live alongside this commit.
"""
import re
from typing import Optional
from sqlalchemy.orm import Session

from database.models import Client, ContactEmail, ContactPhone


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


def _client_by_id(db: Session, client_id: Optional[int]) -> Optional[Client]:
    if not client_id:
        return None
    return db.query(Client).filter(Client.id == client_id).first()


def find_client_by_contact(db: Session, *, email: Optional[str] = None, phone: Optional[str] = None) -> Optional[Client]:
    """Find a client by email then phone, checking BOTH the singular
    Client.email/Client.phone columns and the multi-value contact_emails/
    contact_phones tables (Twenty's emails/phones value-objects).

    Searching the multi-value tables is what stops duplicate clients: an address
    or number stored as an *additional* contact (not the primary column) used to
    be invisible to dedup, so a returning customer spawned a new record."""
    if email:
        e = email.strip().lower()
        if e:
            match = db.query(Client).filter(Client.email.ilike(e)).first()
            if match:
                return match
            ce = db.query(ContactEmail).filter(ContactEmail.email.ilike(e)).first()
            if ce and (c := _client_by_id(db, ce.client_id)):
                return c

    n_phone = normalize_phone(phone)
    if n_phone:
        exact = db.query(Client).filter(Client.phone == n_phone).first()
        if exact:
            return exact
        cp = db.query(ContactPhone).filter(ContactPhone.phone == n_phone).first()
        if cp and (c := _client_by_id(db, cp.client_id)):
            return c

    last10 = phone_last10(phone)
    if last10:
        # lightweight prefilter then deterministic compare in Python
        candidates = db.query(Client).filter(Client.phone.isnot(None), Client.phone.like(f"%{last10}")).all()
        for c in candidates:
            if phone_last10(c.phone) == last10:
                return c
        # …and the additional phones (matched via the indexed phone_tail).
        for cp in db.query(ContactPhone).filter(ContactPhone.phone_tail == last10).all():
            if phone_last10(cp.phone) == last10 and (c := _client_by_id(db, cp.client_id)):
                return c

    return None


def add_contact_email(db: Session, client: Client, email: Optional[str], source: Optional[str] = None) -> Optional[ContactEmail]:
    """Record an email in contact_emails (the canonical multi-value store) if the
    client doesn't already have it. First email becomes primary. Caller commits."""
    if not email:
        return None
    e = email.strip().lower()
    if not e:
        return None
    existing = (
        db.query(ContactEmail)
        .filter(ContactEmail.client_id == client.id, ContactEmail.email.ilike(e))
        .first()
    )
    if existing:
        return existing
    is_primary = db.query(ContactEmail).filter(ContactEmail.client_id == client.id).count() == 0
    ce = ContactEmail(client_id=client.id, email=e, source=source, is_primary=is_primary)
    db.add(ce)
    return ce


def add_contact_phone(db: Session, client: Client, phone: Optional[str], source: Optional[str] = None,
                      phone_type: Optional[str] = None) -> Optional[ContactPhone]:
    """Record a phone in contact_phones if not already present. First becomes
    primary; phone_tail is set for fuzzy matching. Caller commits."""
    n = normalize_phone(phone)
    if not n:
        return None
    existing = (
        db.query(ContactPhone)
        .filter(ContactPhone.client_id == client.id, ContactPhone.phone == n)
        .first()
    )
    if existing:
        return existing
    is_primary = db.query(ContactPhone).filter(ContactPhone.client_id == client.id).count() == 0
    cp = ContactPhone(client_id=client.id, phone=n, phone_tail=phone_last10(n),
                      source=source, is_primary=is_primary, phone_type=phone_type)
    db.add(cp)
    return cp
