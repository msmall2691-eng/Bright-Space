"""Pydantic schemas for Quotes API."""

from typing import Optional, List
from uuid import UUID
from datetime import datetime, date
from decimal import Decimal
from pydantic import BaseModel, Field, validator


# ========================
# Quote Line Item Schemas
# ========================

class QuoteLineItemCreate(BaseModel):
    """Create a quote line item."""
    description: str = Field(..., min_length=1, max_length=500)
    service_type: Optional[str] = Field(None, max_length=100)
    quantity: Decimal = Field(default=Decimal("1"), gt=0)
    unit: Optional[str] = Field(None, max_length=50)
    unit_price: Decimal = Field(..., gt=0)
    line_total: Decimal = Field(..., gt=0)
    display_order: int = Field(default=0, ge=0)

    @validator("unit_price", "line_total", "quantity", pre=True)
    def convert_decimal(cls, v):
        if v is None:
            return v
        return Decimal(str(v))


class QuoteLineItemUpdate(BaseModel):
    """Update a quote line item."""
    description: Optional[str] = Field(None, min_length=1, max_length=500)
    service_type: Optional[str] = Field(None, max_length=100)
    quantity: Optional[Decimal] = Field(None, gt=0)
    unit: Optional[str] = Field(None, max_length=50)
    unit_price: Optional[Decimal] = Field(None, gt=0)
    line_total: Optional[Decimal] = Field(None, gt=0)
    display_order: Optional[int] = Field(None, ge=0)

    @validator("unit_price", "line_total", "quantity", pre=True)
    def convert_decimal(cls, v):
        if v is None:
            return v
        return Decimal(str(v))


class QuoteLineItemResponse(BaseModel):
    """Quote line item response."""
    id: UUID
    quote_id: UUID
    description: str
    service_type: Optional[str]
    quantity: Decimal
    unit: Optional[str]
    unit_price: Decimal
    line_total: Decimal
    display_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ========================
# Quote Schemas
# ========================

class QuoteCreate(BaseModel):
    """Create a new quote."""
    client_id: UUID
    property_id: Optional[UUID] = None
    title: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None
    notes: Optional[str] = None

    # Pricing
    subtotal: Decimal = Field(default=Decimal("0"), ge=0)
    tax_amount: Decimal = Field(default=Decimal("0"), ge=0)
    discount_amount: Decimal = Field(default=Decimal("0"), ge=0)
    total_amount: Decimal = Field(default=Decimal("0"), ge=0)

    # Scheduling Preferences
    preferred_day: Optional[int] = Field(None, ge=0, le=6)  # Day of week
    preferred_time: Optional[str] = Field(None, max_length=50)

    # Expiration
    expires_at: Optional[datetime] = None

    # Line Items
    line_items: Optional[List[QuoteLineItemCreate]] = []

    @validator("subtotal", "tax_amount", "discount_amount", "total_amount", pre=True)
    def convert_decimal(cls, v):
        if v is None:
            return Decimal("0")
        return Decimal(str(v))


class QuoteUpdate(BaseModel):
    """Update an existing quote."""
    title: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None
    notes: Optional[str] = None

    subtotal: Optional[Decimal] = Field(None, ge=0)
    tax_amount: Optional[Decimal] = Field(None, ge=0)
    discount_amount: Optional[Decimal] = Field(None, ge=0)
    total_amount: Optional[Decimal] = Field(None, ge=0)

    preferred_day: Optional[int] = Field(None, ge=0, le=6)
    preferred_time: Optional[str] = Field(None, max_length=50)
    expires_at: Optional[datetime] = None

    @validator("subtotal", "tax_amount", "discount_amount", "total_amount", pre=True)
    def convert_decimal(cls, v):
        if v is None:
            return v
        return Decimal(str(v))


class QuoteResponse(BaseModel):
    """Quote response with all details."""
    id: UUID
    quote_number: str
    public_token: Optional[str] = None
    client_id: UUID
    property_id: Optional[UUID]
    created_by: UUID
    workspace_id: UUID

    title: Optional[str]
    description: Optional[str]
    notes: Optional[str]

    subtotal: Decimal
    tax_amount: Decimal
    discount_amount: Decimal
    total_amount: Decimal

    status: str
    sent_at: Optional[datetime]
    viewed_at: Optional[datetime]
    accepted_at: Optional[datetime]
    declined_at: Optional[datetime]
    expires_at: Optional[datetime]

    preferred_day: Optional[int]
    preferred_time: Optional[str]

    signature_data: Optional[dict]
    accepted_by_name: Optional[str]
    accepted_by_email: Optional[str]

    created_at: datetime
    updated_at: datetime

    line_items: List[QuoteLineItemResponse] = []

    class Config:
        from_attributes = True


class QuoteSummary(BaseModel):
    """Brief quote summary for lists."""
    id: UUID
    quote_number: str
    public_token: Optional[str] = None
    client_id: UUID
    title: Optional[str]
    status: str
    total_amount: Decimal
    created_at: datetime
    sent_at: Optional[datetime]
    viewed_at: Optional[datetime]
    accepted_at: Optional[datetime]

    class Config:
        from_attributes = True


# ========================
# Quote Request Schemas
# ========================

class QuoteRequestCreate(BaseModel):
    """Create a quote request (from customer form)."""
    client_id: Optional[UUID] = None
    requester_name: str = Field(..., min_length=1, max_length=255)
    requester_email: str = Field(..., min_length=5, max_length=255)
    requester_phone: Optional[str] = Field(None, max_length=20)

    property_id: Optional[UUID] = None
    service_type: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    preferred_date: Optional[date] = None
    preferred_time: Optional[str] = Field(None, max_length=50)


class QuoteRequestUpdate(BaseModel):
    """Update a quote request."""
    status: Optional[str] = Field(None, max_length=50)
    quote_id: Optional[UUID] = None


class QuoteRequestResponse(BaseModel):
    """Quote request response."""
    id: UUID
    client_id: Optional[UUID]
    requester_name: str
    requester_email: str
    requester_phone: Optional[str]

    property_id: Optional[UUID]
    service_type: Optional[str]
    description: Optional[str]
    preferred_date: Optional[date]
    preferred_time: Optional[str]

    status: str
    quote_id: Optional[UUID]
    workspace_id: UUID

    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ========================
# Error Responses
# ========================

class ErrorResponse(BaseModel):
    """Error response."""
    detail: str
    code: Optional[str] = None
