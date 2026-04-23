from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text, Date, Time,
    JSON, ForeignKey, Boolean, UniqueConstraint, Enum as SQLEnum
)
from sqlalchemy.orm import relationship, declarative_base
from datetime import datetime
from enum import Enum

Base = declarative_base()


class ActivityType(str, Enum):
    """All possible activity types in the system for unified timeline."""
    # Email events
    EMAIL_SENT = "email_sent"
    EMAIL_RECEIVED = "email_received"
    EMAIL_OPENED = "email_opened"
    EMAIL_CLICKED = "email_clicked"

    # SMS events
    SMS_SENT = "sms_sent"
    SMS_RECEIVED = "sms_received"
    SMS_DELIVERED = "sms_delivered"

    # Job events
    JOB_CREATED = "job_created"
    JOB_SCHEDULED = "job_scheduled"
    JOB_STARTED = "job_started"
    JOB_COMPLETED = "job_completed"
    JOB_CANCELLED = "job_cancelled"

    # Quote events
    QUOTE_CREATED = "quote_created"
    QUOTE_SENT = "quote_sent"
    QUOTE_ACCEPTED = "quote_accepted"
    QUOTE_REJECTED = "quote_rejected"
    QUOTE_EXPIRED = "quote_expired"

    # Invoice events
    INVOICE_CREATED = "invoice_created"
    INVOICE_SENT = "invoice_sent"
    INVOICE_PAID = "invoice_paid"
    INVOICE_OVERDUE = "invoice_overdue"

    # Opportunity events
    OPPORTUNITY_CREATED = "opportunity_created"
    OPPORTUNITY_QUALIFIED = "opportunity_qualified"
    OPPORTUNITY_STAGE_CHANGED = "opportunity_stage_changed"
    OPPORTUNITY_WON = "opportunity_won"
    OPPORTUNITY_LOST = "opportunity_lost"

    # Contact events
    CONTACT_CREATED = "contact_created"
    CONTACT_UPDATED = "contact_updated"
    LEAD_CREATED = "lead_created"
    LEAD_QUALIFIED = "lead_qualified"

    # Call events
    CALL_LOGGED = "call_logged"
    CALL_MISSED = "call_missed"
    CALL_VOICEMAIL = "call_voicemail"

    # Note events
    NOTE_ADDED = "note_added"
    FORM_SUBMITTED = "form_submitted"
    STATUS_CHANGED = "status_changed"


class UserRole(str, Enum):
    """User role types for auth and row-level access control."""
    ADMIN = "admin"
    CLEANER = "cleaner"
    CLIENT = "client"


class FieldDefinition(Base):
    """User-defined custom fields for Clients, Jobs, or Invoices."""
    __tablename__ = "field_definitions"

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String, nullable=False)   # 'client' | 'job' | 'invoice' | 'opportunity' | 'quote'
    name = Column(String, nullable=False)           # Display label: "Pet Name"
    key = Column(String, nullable=False)            # Slug key: "pet_name"
    field_type = Column(String, default="text")     # text | number | date | select | checkbox | textarea
    options = Column(JSON, default=list)            # ['Option A', 'Option B'] for select
    required = Column(Boolean, default=False)
    is_system = Column(Boolean, default=False)      # True for built-in fields, False for custom
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("entity_type", "key", name="uq_field_entity_key"),
    )


class User(Base):
    """System users: admins, cleaners, and clients who log in to the app."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, nullable=False, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    role = Column(String, nullable=False, default=UserRole.CLIENT)  # admin | cleaner | client
    # FK to Client — only set for role=client users. Admins/cleaners have no client profile.
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    phone = Column(String, nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="user")
    jobs_assigned = relationship("Job", back_populates="assigned_cleaner", foreign_keys="Job.assigned_cleaner_user_id")


class Client(Base):
    """Central hub entity connected to all business records."""
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)          # full display name (derived or manually set)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    email = Column(String)
    phone = Column(String)
    phone_tail = Column(String(10), nullable=True, index=True)
    # Service / property address (where cleaning happens)
    address = Column(String)
    city = Column(String)
    state = Column(String)
    zip_code = Column(String)
    # Billing address (where invoices are sent)
    billing_address = Column(String, nullable=True)
    billing_city = Column(String, nullable=True)
    billing_state = Column(String, nullable=True)
    billing_zip = Column(String, nullable=True)
    status = Column(String, default="lead")  # lead, active, inactive
    notes = Column(Text)
    source = Column(String)
    custom_fields = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)

    client_type = Column(String, nullable=True)         # str | commercial | residential
    lifecycle_stage = Column(String, default="new")     # new | qualified | opportunity | customer | churned
    source_detail = Column(String, nullable=True)       # "maineclean.co contact form", "gmail auto-create"
    last_contacted_at = Column(DateTime, nullable=True)
    email_verified = Column(Boolean, default=False)

    # Relationships - all cascade delete with client
    user = relationship("User", back_populates="client", uselist=False)  # One client per user (for role=client users)
    quotes = relationship("Quote", back_populates="client", cascade="all, delete-orphan")
    jobs = relationship("Job", back_populates="client", cascade="all, delete-orphan")
    invoices = relationship("Invoice", back_populates="client", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="client", cascade="all, delete-orphan")
    conversations = relationship("Conversation", back_populates="client", cascade="all, delete-orphan")
    properties = relationship("Property", back_populates="client", cascade="all, delete-orphan")
    recurring_schedules = relationship("RecurringSchedule", back_populates="client", cascade="all, delete-orphan")
    opportunities = relationship("Opportunity", back_populates="client", cascade="all, delete-orphan")
    contact_emails = relationship("ContactEmail", back_populates="client", cascade="all, delete-orphan")
    contact_phones = relationship("ContactPhone", back_populates="client", cascade="all, delete-orphan")
    activities = relationship("Activity", back_populates="client", cascade="all, delete-orphan", order_by="Activity.created_at.desc()")
    lead_intakes = relationship("LeadIntake", back_populates="client", cascade="all, delete-orphan")


class Property(Base):
    """An STR property belonging to a client — has iCal feed URL(s)."""
    __tablename__ = "properties"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)

    name = Column(String, nullable=False)           # "Ocean View Condo"
    address = Column(String, nullable=False)
    city = Column(String)
    state = Column(String)
    zip_code = Column(String)
    property_type = Column(String, default="str")   # "str" for now

    ical_url = Column(String, nullable=True)        # Legacy: single iCal (backward compat)
    ical_last_synced_at = Column(DateTime, nullable=True)
    default_duration_hours = Column(Float, default=3.0)  # turnover duration

    # STR property specific fields
    check_in_time = Column(String(5), nullable=True)   # "14:00" format
    check_out_time = Column(String(5), nullable=True)  # "10:00" format
    house_code = Column(String(255), nullable=True)    # Access code or combination

    notes = Column(Text, nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="properties")
    ical_events = relationship("ICalEvent", back_populates="property", cascade="all, delete-orphan")
    property_icals = relationship("PropertyIcal", back_populates="property", cascade="all, delete-orphan")
    jobs = relationship("Job", back_populates="property")


class PropertyIcal(Base):
    """Multiple iCal URLs per property (Airbnb, VRBO, manual calendars, etc.)"""
    __tablename__ = "property_icals"

    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=False, index=True)
    url = Column(String, nullable=False)
    source = Column(String, nullable=True)  # "airbnb", "vrbo", "manual", etc.
    active = Column(Boolean, default=True, nullable=False)

    # Turnover job settings (override property defaults if set)
    checkout_time = Column(String(5), nullable=True)  # "10:00" or "11:00" — uses property default if None
    duration_hours = Column(Float, nullable=True)     # turnover duration — uses property default if None
    house_code = Column(String(255), nullable=True)   # Access code for this calendar source
    access_links = Column(JSON, nullable=True)        # {"airbnb_link": "...", "vrbo_link": "..."} or similar
    instructions = Column(Text, nullable=True)        # Special turnover instructions

    last_synced_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    property = relationship("Property", back_populates="property_icals")


class ICalEvent(Base):
    """A single event parsed from an STR property's iCal feed."""
    __tablename__ = "ical_events"

    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=False, index=True)

    uid = Column(String, nullable=False)            # Airbnb UID: "airbnb_XXX@airbnb.com"
    summary = Column(String, nullable=True)         # SUMMARY field (booking label)
    event_type = Column(String, default="reservation")  # "reservation" | "host_block"
    checkout_date = Column(String, nullable=False)  # YYYY-MM-DD from DTEND
    checkin_date = Column(String, nullable=True)    # YYYY-MM-DD from DTSTART
    guest_count = Column(Integer, nullable=True)    # Number of guests for the booking
    raw_event = Column(JSON, nullable=True)         # Full parsed event dict

    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("property_id", "uid", name="uq_ical_property_uid"),
    )

    property = relationship("Property", back_populates="ical_events")
    job = relationship("Job", back_populates="ical_event", foreign_keys=[job_id], uselist=False)


class RecurringSchedule(Base):
    """Defines a recurring cleaning engagement for residential or commercial clients."""
    __tablename__ = "recurring_schedules"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)

    job_type = Column(String, nullable=False)       # "residential" | "commercial"
    title = Column(String, nullable=False)          # "Biweekly Home Clean"
    address = Column(String, nullable=False)

    frequency = Column(String, nullable=False)      # "weekly" | "biweekly" | "monthly"
    interval_weeks = Column(Integer, default=1, nullable=False)  # 1 for weekly, 2 for biweekly, etc.
    day_of_week = Column(Integer, nullable=False)   # 0=Mon … 6=Sun (kept for compat)
    days_of_week = Column(JSON, nullable=True)      # [0,2,4] for Mon/Wed/Fri multi-day
    day_of_month = Column(Integer, nullable=True)   # 1–28, only for monthly

    start_time = Column(Time, nullable=False)       # HH:MM:SS
    end_time = Column(Time, nullable=False)         # HH:MM:SS

    cleaner_ids = Column(JSON, default=list)
    quote_id = Column(Integer, ForeignKey("quotes.id"), nullable=True)
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    generate_weeks_ahead = Column(Integer, default=8)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="recurring_schedules")
    jobs = relationship("Job", back_populates="recurring_schedule")


class Job(Base):
    """A cleaning job/task linked to a client, opportunity, and possibly quote."""
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    quote_id = Column(Integer, ForeignKey("quotes.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    # Job classification
    job_type = Column(String, nullable=False, default="residential")
    # "residential" | "commercial" | "str_turnover"

    # Links — only set for the relevant type
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=False)  # PR 2: Every job must have a property
    recurring_schedule_id = Column(Integer, ForeignKey("recurring_schedules.id"), nullable=True)
    ical_event_id = Column(Integer, ForeignKey("ical_events.id"), nullable=True)
    assigned_cleaner_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # Future: replace cleaner_ids JSON

    # Notification tracking
    calendar_invite_sent = Column(Boolean, default=False, nullable=False)
    sms_reminder_sent = Column(Boolean, default=False, nullable=False)
    gcal_event_id = Column(String, nullable=True)   # Google Calendar event ID for two-way sync

    title = Column(String, nullable=False)
    scheduled_date = Column(Date)       # ISO date
    start_time = Column(Time)           # HH:MM:SS
    end_time = Column(Time)             # HH:MM:SS
    address = Column(String)
    cleaner_ids = Column(JSON, default=list)
    status = Column(String, default="scheduled")
    # "scheduled" | "in_progress" | "completed" | "cancelled"
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    dispatched = Column(Integer, default=0)
    connecteam_shift_ids = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    client = relationship("Client", back_populates="jobs")
    opportunity = relationship("Opportunity", back_populates="jobs")
    property = relationship("Property", back_populates="jobs", foreign_keys=[property_id])
    recurring_schedule = relationship("RecurringSchedule", back_populates="jobs")
    ical_event = relationship(
        "ICalEvent", back_populates="job",
        foreign_keys="ICalEvent.job_id", uselist=False
    )
    assigned_cleaner = relationship("User", back_populates="jobs_assigned", foreign_keys=[assigned_cleaner_user_id])


class LeadIntake(Base):
    """Initial contact form submission from lead before client/opportunity creation."""
    __tablename__ = "lead_intakes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    name = Column(String, nullable=False)
    email = Column(String)
    phone = Column(String)
    address = Column(String)
    city = Column(String)
    state = Column(String, default="ME")
    zip_code = Column(String)
    service_type = Column(String, default="residential")  # residential/commercial/str
    bedrooms = Column(Integer, nullable=True)
    bathrooms = Column(Integer, nullable=True)
    square_footage = Column(Integer, nullable=True)
    guests = Column(Integer, nullable=True)
    frequency = Column(String, nullable=True)
    requested_date = Column(String, nullable=True)
    check_in = Column(String, nullable=True)
    check_out = Column(String, nullable=True)
    estimate_min = Column(Float, nullable=True)
    estimate_max = Column(Float, nullable=True)
    property_name = Column(String, nullable=True)
    message = Column(Text)
    preferred_date = Column(String)
    source = Column(String, default="website")
    status = Column(String, default="new")  # new/reviewed/quoted/converted/archived
    priority = Column(String, default="normal")  # low/normal/high/urgent
    assigned_to = Column(String, nullable=True)
    internal_notes = Column(Text, nullable=True)
    custom_fields = Column(JSON, default=dict)
    followed_up_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="lead_intakes")
    opportunity = relationship("Opportunity", back_populates="intake", uselist=False)


class Quote(Base):
    """Service quote linked to client and opportunity."""
    __tablename__ = "quotes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    intake_id = Column(Integer, ForeignKey("lead_intakes.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    quote_number = Column(String, unique=True, nullable=True)
    address = Column(String, nullable=True)
    service_type = Column(String, nullable=True)  # residential/commercial/str
    items = Column(JSON, default=list)
    subtotal = Column(Float, default=0)
    tax_rate = Column(Float, default=0)
    tax = Column(Float, default=0)
    total = Column(Float, default=0)
    status = Column(String, default="draft")  # draft | sent | viewed | accepted | declined | expired | converted
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    valid_until = Column(String)
    public_token = Column(String(48), nullable=True, index=True)  # Token for public accept link
    viewed_at = Column(DateTime, nullable=True)  # Timestamp when quote was first viewed by client
    accepted_at = Column(DateTime, nullable=True)  # Timestamp when quote was accepted
    accepted_ip = Column(String, nullable=True)  # IP address of acceptor (audit trail)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    client = relationship("Client", back_populates="quotes")
    opportunity = relationship("Opportunity", back_populates="quotes")


class Invoice(Base):
    """Invoice linked to client, job, and opportunity."""
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    invoice_number = Column(String, unique=True)
    items = Column(JSON, default=list)
    subtotal = Column(Float, default=0)
    tax_rate = Column(Float, default=0)
    tax = Column(Float, default=0)
    total = Column(Float, default=0)
    status = Column(String, default="draft")  # draft | sent | overdue | paid
    due_date = Column(String)
    paid_at = Column(DateTime, nullable=True)
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    client = relationship("Client", back_populates="invoices")
    opportunity = relationship("Opportunity", back_populates="invoices")


class Conversation(Base):
    """
    Multi-channel conversation thread with a contact.
    Groups related Messages across SMS / email / chat / etc.
    Linked to client and opportunity for full context.
    """
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True, index=True)

    # External identifier for contacts not yet linked to a client
    # (phone number for SMS, email address for email, etc.)
    external_contact = Column(String, nullable=True, index=True)

    channel = Column(String, nullable=False, index=True)   # sms | email | chat | whatsapp
    subject = Column(String, nullable=True)                # primarily for email threading

    status = Column(String, default="open", nullable=False, index=True)
    # open | pending | snoozed | resolved

    priority = Column(String, default="normal", nullable=False)
    # low | normal | high | urgent

    assignee = Column(String, nullable=True, index=True)   # email or name of teammate
    tags = Column(JSON, default=list)

    # Activity timestamps — used to sort the inbox and measure SLAs
    last_message_at = Column(DateTime, nullable=True, index=True)
    last_inbound_at = Column(DateTime, nullable=True)
    last_outbound_at = Column(DateTime, nullable=True)
    first_response_at = Column(DateTime, nullable=True)
    # when a teammate first replied after an inbound message

    unread_count = Column(Integer, default=0, nullable=False)

    # SLA: First Response Time target, in minutes.
    # When a new inbound arrives and first_response_at is null, we compute
    # sla_deadline = now + sla_response_minutes.
    sla_response_minutes = Column(Integer, nullable=True)
    sla_deadline = Column(DateTime, nullable=True)

    snoozed_until = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    client = relationship("Client", back_populates="conversations")
    opportunity = relationship("Opportunity", back_populates="conversations")
    messages = relationship(
        "Message", back_populates="conversation",
        cascade="all, delete-orphan", order_by="Message.created_at",
    )


class Message(Base):
    """Single message (email, SMS, chat, etc.) within a conversation."""
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    # Each message should belong to a Conversation. Nullable for now to
    # allow backfill of legacy rows; new code always sets this.
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=True, index=True)

    channel = Column(String)       # sms | email | chat | whatsapp
    direction = Column(String)     # inbound | outbound | note
    from_addr = Column(String)
    to_addr = Column(String)
    subject = Column(String, nullable=True)
    body = Column(Text)
    status = Column(String, default="sent")
    # sent | received | delivered | failed | read | queued

    # External provider id (Twilio SID, email Message-ID) — used for dedup
    external_id = Column(String, nullable=True, index=True)

    # Who sent it — team-member identifier for outbound/notes
    author = Column(String, nullable=True)

    # Internal team notes (e.g. @mentions) are stored as messages with
    # is_internal_note=True so they appear inline in the thread but are
    # never sent to the customer.
    is_internal_note = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="messages")
    job = relationship("Job")
    opportunity = relationship("Opportunity", back_populates="messages")
    conversation = relationship("Conversation", back_populates="messages")


class Opportunity(Base):
    """
    Pipeline deal between lead qualification and quoting.
    Central to the CRM with relationships to quotes, invoices, jobs, and messages.
    Inspired by Twenty CRM and Fieldcamp.
    """
    __tablename__ = "opportunities"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)

    title = Column(String, nullable=False)
    stage = Column(String, default="new", nullable=False)
    # new | qualified | quoted | won | lost
    amount = Column(Float, nullable=True)
    close_date = Column(String, nullable=True)
    probability = Column(Integer, nullable=True)       # 0-100
    service_type = Column(String, nullable=True)       # str_turnover | residential | commercial | deep_clean
    owner = Column(String, nullable=True)              # assigned team member
    lost_reason = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    custom_fields = Column(JSON, default=dict)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    client = relationship("Client", back_populates="opportunities")
    intake = relationship("LeadIntake", back_populates="opportunity", uselist=False)
    quotes = relationship("Quote", back_populates="opportunity")
    invoices = relationship("Invoice", back_populates="opportunity")
    jobs = relationship("Job", back_populates="opportunity")
    conversations = relationship("Conversation", back_populates="opportunity")
    messages = relationship("Message", back_populates="opportunity")
    activities = relationship("Activity", back_populates="opportunity")


class ContactEmail(Base):
    """Multiple email addresses per client (Twenty CRM pattern for enrichment)."""
    __tablename__ = "contact_emails"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    email = Column(String, nullable=False, index=True)
    is_primary = Column(Boolean, default=False)
    source = Column(String, nullable=True)             # website | gmail_sync | manual
    verified_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="contact_emails")


class ContactPhone(Base):
    """Multiple phone numbers per client."""
    __tablename__ = "contact_phones"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    phone = Column(String, nullable=False, index=True)
    phone_tail = Column(String(10), nullable=True, index=True)
    is_primary = Column(Boolean, default=False)
    phone_type = Column(String, nullable=True)         # mobile | office | home
    source = Column(String, nullable=True)             # website | twilio | manual
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="contact_phones")


class Activity(Base):
    """
    Unified timeline entry for any client/opportunity/job touchpoint.
    Tracks all interactions: emails, SMS, calls, notes, status changes, etc.
    """
    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=True)

    actor = Column(String, nullable=True)
    activity_type = Column(String, nullable=False, index=True)
    # Uses ActivityType enum values (email_sent, email_received, sms_sent, etc.)
    summary = Column(String, nullable=True)
    extra_data = Column(JSON, default=dict)

    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="activities")
    opportunity = relationship("Opportunity", back_populates="activities")


class AppSetting(Base):
    """Application-wide settings (email credentials, integrations, etc.)."""
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, nullable=False, unique=True, index=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# ─────────────────────────────────────────────────────────────────
# Event listeners — keep phone_tail in sync automatically
# ─────────────────────────────────────────────────────────────────

from sqlalchemy import event
from utils.phone import phone_tail as _compute_phone_tail


def _sync_phone_tail(mapper, connection, target):
    """Before insert/update on Client or ContactPhone, recompute phone_tail
    from the literal phone column. Single source of truth — no other code
    needs to write phone_tail directly."""
    target.phone_tail = _compute_phone_tail(target.phone)


event.listen(Client, "before_insert", _sync_phone_tail)
event.listen(Client, "before_update", _sync_phone_tail)
event.listen(ContactPhone, "before_insert", _sync_phone_tail)
event.listen(ContactPhone, "before_update", _sync_phone_tail)
