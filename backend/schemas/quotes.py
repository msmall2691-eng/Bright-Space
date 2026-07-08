"""Pydantic request schemas for the Quotes API.

Integer-keyed, inline JSON line items — matches the Quote model and what the
Quoting UI sends. Responses are serialized to plain dicts in the router
(see ``_quote_dict``) so the wire shape stays decoupled from the ORM.
"""

from typing import Optional, List
from datetime import date
from pydantic import BaseModel, Field, field_validator


class QuoteItem(BaseModel):
    """A single line item. Mirrors the shape the frontend builds."""
    name: str = ""
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float = 0

    @field_validator("qty", "unit_price")
    @classmethod
    def _no_negative(cls, v):
        # Clamp negative qty / unit price to 0 — a negative line would silently
        # subtract from the total (audit item 3). Real credits aren't modeled here.
        return max(0.0, float(v or 0))


def _clamp_tax_rate(v):
    """Tax percent bounded to a sane 0–100 range."""
    if v is None:
        return v
    return min(100.0, max(0.0, float(v)))


def _clamp_discount(v):
    """Discount is a non-negative dollar amount."""
    if v is None:
        return v
    return max(0.0, float(v))


class QuoteCreate(BaseModel):
    client_id: int
    intake_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    property_id: Optional[int] = None
    title: Optional[str] = None
    customer_message: Optional[str] = None
    internal_notes: Optional[str] = None
    service_type: Optional[str] = "residential"
    frequency: Optional[str] = None   # weekly | biweekly | monthly (carried from the lead)
    address: Optional[str] = None
    notes: Optional[str] = None
    items: List[QuoteItem] = Field(default_factory=list)
    tax_rate: float = 0
    discount: float = 0
    # Accepted as a string (date input) or empty; parsed to a date in the router.
    valid_until: Optional[str] = None
    status: Optional[str] = None
    # Admin-defined custom fields (entity_type="quote"); free-form key→value.
    custom_fields: Optional[dict] = None

    _v_tax = field_validator("tax_rate")(_clamp_tax_rate)
    _v_discount = field_validator("discount")(_clamp_discount)


class QuoteUpdate(BaseModel):
    client_id: Optional[int] = None
    intake_id: Optional[int] = None
    opportunity_id: Optional[int] = None
    property_id: Optional[int] = None
    title: Optional[str] = None
    customer_message: Optional[str] = None
    internal_notes: Optional[str] = None
    service_type: Optional[str] = None
    frequency: Optional[str] = None
    address: Optional[str] = None
    notes: Optional[str] = None
    items: Optional[List[QuoteItem]] = None
    tax_rate: Optional[float] = None
    discount: Optional[float] = None
    valid_until: Optional[str] = None
    status: Optional[str] = None
    custom_fields: Optional[dict] = None

    _v_tax = field_validator("tax_rate")(_clamp_tax_rate)
    _v_discount = field_validator("discount")(_clamp_discount)


class QuoteRequestCreate(BaseModel):
    client_id: Optional[int] = None
    requester_name: str
    requester_email: str
    requester_phone: Optional[str] = None
    property_id: Optional[int] = None
    service_type: Optional[str] = None
    description: Optional[str] = None
    preferred_date: Optional[date] = None
    preferred_time: Optional[str] = None


class QuoteRequestUpdate(BaseModel):
    status: Optional[str] = None
    quote_id: Optional[int] = None
    service_type: Optional[str] = None
    description: Optional[str] = None
    preferred_date: Optional[date] = None
    preferred_time: Optional[str] = None
