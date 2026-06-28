"""Pydantic request schemas for the Quotes API.

Integer-keyed, inline JSON line items — matches the Quote model and what the
Quoting UI sends. Responses are serialized to plain dicts in the router
(see ``_quote_dict``) so the wire shape stays decoupled from the ORM.
"""

from typing import Optional, List
from datetime import date
from pydantic import BaseModel, Field


class QuoteItem(BaseModel):
    """A single line item. Mirrors the shape the frontend builds."""
    name: str = ""
    description: Optional[str] = ""
    qty: float = 1
    unit_price: float = 0


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
