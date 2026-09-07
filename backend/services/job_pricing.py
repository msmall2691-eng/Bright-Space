"""What a new job bills — decided in one place.

THREE ROUTES CREATE A JOB in this app: the scheduling router's `create_job`,
recurring generation, and converting an accepted quote. Each of them would
otherwise need its own answer to "so what does this one bill?", and three
answers to a money question drift — the first thing to go would be whichever
one somebody forgot, and the symptom would be an invoice for the wrong amount.
`services/claim_approval.py` exists for the same reason on the paying side.

PRECEDENCE, most specific first:

  1. what the office typed for THIS visit — nothing outranks somebody saying it
  2. the accepted quote's total — what this customer actually agreed to
  3. the property's `default_price` — what this house usually bills
  4. nothing. Reported as None, never 0.0: "we don't know" and "this is free"
     are different answers and only one of them means the customer owes zero.
     `services/job_margin.py` already turns on that distinction.

INHERITANCE IS A SEED, NOT A LINK. The value is copied onto the job once, at
creation. Editing a property's default afterwards must never reach back into
visits already on the books — some of them have been invoiced, and a price
moving under an invoice already sent is the kind of error a customer finds
before you do.
"""
from __future__ import annotations

from typing import Optional


def resolve_new_job_price(*, explicit=None, quote=None, prop=None) -> Optional[float]:
    """The price to stamp on a job being created. See the module docstring.

    `explicit` is honoured even when it is 0.0 — a job deliberately billed
    nothing (a make-good, a warranty re-clean) is a real thing to record, and
    only `None` means "nobody said".
    """
    if explicit is not None:
        try:
            return float(explicit)
        except (TypeError, ValueError):
            return None
    total = getattr(quote, "total", None)
    if total is not None:
        try:
            # A quote totalling 0 is a placeholder somebody never filled in,
            # not a free job — fall through to the house default rather than
            # stamping a zero nobody chose.
            if float(total):
                return float(total)
        except (TypeError, ValueError):
            pass
    default = getattr(prop, "default_price", None)
    if default is not None:
        try:
            return float(default)
        except (TypeError, ValueError):
            return None
    return None
