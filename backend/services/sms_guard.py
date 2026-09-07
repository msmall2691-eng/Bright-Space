"""Who a public form is allowed to text, and how much of it.

WHY THIS EXISTS. `POST /api/booking/submit` is unauthenticated by design — it
is the maineclean.co booking form — and it sent a confirmation SMS to a
destination taken straight off the request body, with parts of the message
body taken from the same place:

    to_number = (data.phone or "").strip()      # any number on earth
    body += f" Manage/cancel: {data.manageUrl}" # any URL, verbatim

So anyone on the internet could send an SMS from The Maine Cleaning Co.'s
Twilio number, to anywhere, carrying their own text and their own link. Three
real costs: international and premium-rate toll fraud billed to the account,
an A2P policy violation that gets the number suspended, and phishing that
traces back to the business's sender ID. The only brake was 20/hour per IP,
which is 20 texts an hour per proxy, forever.

The irony worth preserving: the code already carried "NEVER log `body` — it
can carry the capability-token manage URL." Somebody thought hard about the
message and not at all about the destination.

THREE INDEPENDENT LIMITS, because any one of them alone is bypassable:

  1. WHERE — North American numbering plan only, structurally validated.
     This is the one that kills toll fraud: premium-rate and international
     destinations stop being reachable at all, not merely rate-limited.
  2. HOW MUCH — a per-destination cap and a whole-account daily ceiling,
     counted from `integration_events`. An attacker rotating IPs past the
     per-IP limiter still cannot turn the number into a spam cannon, and a
     runaway costs a known maximum rather than a bill.
  3. WHAT — the caller supplies no free text. Names are stripped to name
     characters, the service label comes from the canonical map only, and
     links are checked against hosts we own. See `safe_first_name` and
     `allowed_manage_url`.

Counting from `integration_events` rather than a new table is deliberate: the
booking SMS was not logged anywhere at all, so this buys the audit trail and
the budget in the same row. `created_at` is already indexed.
"""
from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import func

logger = logging.getLogger(__name__)

# The integration_events coordinates this module reads and writes.
PROVIDER = "sms"
ACTION = "booking_confirm"

# Per calendar day, account-wide. A cleaning company in southern Maine does not
# take 200 bookings a day; this is a ceiling on the damage, not a business
# limit, and crossing it means something is wrong rather than busy.
DAILY_ACCOUNT_CAP = 200
# One phone, one day. A confirmation is worth sending twice if somebody really
# did book twice; it is never worth sending five times.
DAILY_PER_NUMBER_CAP = 3

_DIGITS = re.compile(r"\D")
# Premium-rate (900), carrier-specific (700) and personal-communications
# (5XX) area codes — inside the numbering plan, never a customer's phone.
_NON_GEOGRAPHIC_AREAS = frozenset({
    "900", "700",
    "500", "521", "522", "533", "544", "566", "577", "588",
})
# Name characters only: letters (any script), space, hyphen, apostrophe, dot.
# Everything else — digits, colons, slashes — is how a URL or a shortcode gets
# into a message that is otherwise fixed text.
_NOT_NAME = re.compile(r"[^\w \-'.]", re.UNICODE)


def nanp_number(raw: Optional[str]) -> Optional[str]:
    """`raw` as +1XXXXXXXXXX, or None if it is not a plausible NANP number.

    Structural validation, not just length: a NANP area code and exchange both
    begin 2-9, and N11 area codes (411, 911) are service codes. Everything
    outside the plan — every other country, every premium short code — returns
    None and is never dialled. That is the property that makes toll fraud
    impossible here rather than merely expensive.
    """
    if not raw:
        return None
    s = str(raw).strip()
    digits = _DIGITS.sub("", s)
    # An explicit non-+1 country code is a foreign number even at 11+ digits.
    if s.startswith("+") and not digits.startswith("1"):
        return None
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    area, exch = digits[:3], digits[3:6]
    if area[0] in "01" or exch[0] in "01":
        return None
    if area[1:] == "11":          # 211/311/411/611/911 and friends
        return None
    # Non-geographic NANP ranges, which are inside the plan and still the
    # expensive ones: 900 is premium-rate billed to the CALLER's carrier and
    # 500/521-followers are personal-communications numbers that forward
    # anywhere, both long-standing toll-fraud destinations. 700 is
    # carrier-specific and not a customer's phone. A cleaning customer in
    # Maine has none of these.
    if area in _NON_GEOGRAPHIC_AREAS or exch == "976":
        return None
    return f"+1{digits}"


def safe_first_name(raw: Optional[str]) -> str:
    """A first name safe to interpolate into an SMS, or "there".

    The greeting is the only caller-supplied text left in the message, so it
    is reduced to name characters — no digits, no punctuation a URL needs —
    and capped. A name is not a place to smuggle a link.
    """
    first = (str(raw or "").strip().split(" ") or [""])[0]
    cleaned = _NOT_NAME.sub("", first).strip(" -'.")
    return cleaned[:32] or "there"


def allowed_manage_url(raw: Optional[str], *, allowed_hosts) -> Optional[str]:
    """The manage/cancel link, only when it points somewhere we own.

    The URL arrives in the public request body from the maineclean.co layer,
    which lives outside this repo — so from here it is attacker-controlled
    input that gets appended to a text message sent from the company's number.
    An https URL on a host we recognise is a link to our own booking; anything
    else is a phishing payload with our sender ID on it.
    """
    if not raw:
        return None
    try:
        u = urlparse(str(raw).strip())
    except Exception:
        return None
    if u.scheme != "https" or not u.netloc:
        return None
    # Userinfo is rejected outright rather than parsed past. A browser reading
    # `https://evil.co@maineclean.co/x` goes to OUR host, so it would pass a
    # host check — but a person reading the text message sees "evil.co", and
    # that is the whole trick. No real manage link has userinfo.
    if "@" in u.netloc:
        return None
    host = u.netloc.split(":")[0].lower()
    for allowed in allowed_hosts:
        a = (allowed or "").lower().strip()
        if a and (host == a or host.endswith("." + a)):
            return u.geturl()
    return None


def _sent_today(db, *, to_number: Optional[str] = None) -> int:
    """Successful booking confirmations sent today — account-wide, or to one
    number. Returns 0 if the count itself fails: a broken counter must not
    become a reason to send, but nor should it break a real booking."""
    try:
        from database.models import IntegrationEvent
        # Midnight in MAINE, expressed as the naive UTC these rows store.
        # A UTC midnight cutoff would reset the day at 8pm local and hand an
        # attacker a fresh budget every evening — the same class of bug as the
        # month-boundary one in invoicing.
        from utils.dates import business_tz
        from datetime import datetime, timezone
        local_midnight = datetime.now(business_tz()).replace(
            hour=0, minute=0, second=0, microsecond=0)
        since = local_midnight.astimezone(timezone.utc).replace(tzinfo=None)
        q = (db.query(func.count(IntegrationEvent.id))
             .filter(IntegrationEvent.provider == PROVIDER,
                     IntegrationEvent.action == ACTION,
                     IntegrationEvent.status == "ok",
                     IntegrationEvent.created_at >= since))
        if to_number:
            q = q.filter(IntegrationEvent.request_payload == f"to {to_number}")
        return int(q.scalar() or 0)
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("[sms-guard] count failed, treating as 0: %s", e)
        return 0


def may_send(db, to_number: str) -> tuple[bool, str]:
    """(allowed, reason). Reason is for the log, never for the caller — a
    public endpoint must not report whether a number has hit its cap."""
    if _sent_today(db) >= DAILY_ACCOUNT_CAP:
        return False, "daily account cap"
    if _sent_today(db, to_number=to_number) >= DAILY_PER_NUMBER_CAP:
        return False, "per-number cap"
    return True, "ok"


def record_send(db, *, to_number: str, intake_id, sid=None, ok: bool = True,
                error: Optional[str] = None) -> None:
    """Audit the attempt AND feed the budget above. The booking SMS was
    previously logged nowhere, so there was no record of what the number had
    sent and nothing to count against."""
    from utils.integration_log import log_integration_event
    log_integration_event(
        db, entity_type="intake", entity_id=intake_id, provider=PROVIDER,
        action=ACTION, status="ok" if ok else "failed",
        external_id=sid, recipient=to_number if ok else None,
        detail=(error if not ok else None), commit=True,
    )
