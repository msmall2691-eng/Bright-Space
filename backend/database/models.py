from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text,
    JSON, ForeignKey, Boolean, UniqueConstraint
)
from sqlalchemy.orm import relationship, declarative_base
from datetime import datetime

Base = declarative_base()


class FieldDefinition(Base):
    """User-defined custom fields for Clients, Jobs, or Invoices."""
    __tablename__ = "field_definitions"

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String, nullable=False)   # 'client' | 'job' | 'invoice'
    name = Column(String, nullable=False)           # Display label: "Pet Name"
    key = Column(String, nullable=False)            # Slug key: "pet_name"
    field_type = Column(String, default="text")     # text | number | date | select | checkbox | textarea
    options = Column(JSON, default=list)            # ['Option A', 'Option B'] for select
    required = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)          # full display name (derived or manually set)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    email = Column(String)
    phone = Column(String)
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

    quotes = relationship("Quote", back_populates="client")
    jobs = relationship("Job", back_populates="client")
    invoices = relationship("Invoice", back_populates="client")
    messages = relationship("Message", back_populates="client")
    properties = relationship("Property", back_populates="client")
    recurring_schedules = relationship("RecurringSchedule", back_populates="client")
    opportunities = relationship("Opportunity", back_populates="client")
    contact_emails = relationship("ContactEmail", back_populates="client", cascade="all, delete-orphan")
    contact_phones = relationship("ContactPhone", back_populates="client", cascade="all, delete-orphan")
    activities = relationship("Activity", back_populates="client", order_by="Activity.created_at.desc()")


class Property(Base):
    """An STR property belonging to a client — has an iCal feed URL."""
    __tablename__ = "properties"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)

    name = Column(String, nullable=False)           # "Ocean View Condo"
    address = Column(String, nullable=False)
    city = Column(String)
    state = Column(String)
    zip_code = Column(String)
    property_type = Column(String, default="str")   # "str" for now

    ical_url = Column(String, nullable=True)
    ical_last_synced_at = Column(DateTime, nullable=True)
    default_duration_hours = Column(Float, default=3.0)  # turnover duration

    notes = Column(Text, nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="properties")
    ical_events = relationship("ICalEvent", back_populates="property")
    jobs = relationship("Job", back_populates="property")


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
    day_of_week = Column(Integer, nullable=False)   # 0=Mon … 6=Sun (kept for compat)
    days_of_week = Column(JSON, nullable=True)      # [0,2,4] for Mon/Wed/Fri multi-day
    day_of_month = Column(Integer, nullable=True)   # 1–28, only for monthly

    start_time = Column(String, nullable=False)     # HH:MM
    end_time = Column(String, nullable=False)       # HH:MM

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
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    quote_id = Column(Integer, ForeignKey("quotes.id"), nullable=True)

    # Job classification
    job_type = Column(String, nullable=False, default="residential")
    # "residential" | "commercial" | "str_turnover"

    # Links — only set for the relevant type
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=True)
    recurring_schedule_id = Column(Integer, ForeignKey("recurring_schedules.id"), nullable=True)
    ical_event_id = Column(Integer, ForeignKey("ical_events.id"), nullable=True)

    # Notification tracking
    calendar_invite_sent = Column(Boolean, default=False, nullable=False)
    sms_reminder_sent = Column(Boolean, default=False, nullable=False)
    gcal_event_id = Column(String, nullable=True)   # Google Calendar event ID for two-way sync

    title = Column(String, nullable=False)
    scheduled_date = Column(String)     # YYYY-MM-DD
    start_time = Column(String)         # HH:MM
    end_time = Column(String)           # HH:MM
    address = Column(String)
    cleaner_ids = Column(JSON, default=list)
    status = Column(String, default="scheduled")
    # "scheduled" | "in_progress" | "completed" | "cancelled"
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    dispatched = Column(Integer, default=0)
    connecteam_shift_ids = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="jobs")
    property = relationship("Property", back_populates="jobs", foreign_keys=[property_id])
    recurring_schedule = relationship("RecurringSchedule", back_populates="jobs")
    ical_event = relationship(
        "ICalEvent", back_populates="job",
        foreign_keys="ICalEvent.job_id", uselist=False
    )


class LeadIntake(Base):
    __tablename__ = "lead_intakes"

    id = Column(Integer, primary_key=True, index=True)
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
    followed_up_at = Column(DateTime, nullable=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    opportunity = relationship("Opportunity", back_populates="intake")


class Quote(Base):
    __tablename__ = "quotes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    intake_id = Column(Integer, ForeignKey("lead_intakes.id"), nullable=True)
    quote_number = Column(String, unique=True, nullable=True)
    address = Column(String, nullable=True)
    service_type = Column(String, nullable=True)  # residential/commercial/str
    items = Column(JSON, default=list)
    subtotal = Column(Float, default=0)
    tax_rate = Column(Float, default=0)
    tax = Column(Float, default=0)
    total = Column(Float, default=0)
    status = Column(String, default="draft")
    notes = Column(Text)
    valid_until = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="quotes")


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"))
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    invoice_number = Column(String, unique=True)
    items = Column(JSON, default=list)
    subtotal = Column(Float, default=0)
    tax_rate = Column(Float, default=0)
    tax = Column(Float, default=0)
    total = Column(Float, default=0)
    status = Column(String, default="draft")
    due_date = Column(String)
    paid_at = Column(DateTime, nullable=True)
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="invoices")


class Conversation(Base):
    """
    A single multi-channel conversation thread with a contact.

    Groups related Messages across SMS / email / chat / etc. Carries
    inbox-level state: status, assignment, SLA, unread, priority, tags.
    """
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)

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

    client = relationship("Client")
    messages = relationship(
        "Message", back_populates="conversation",
        cascade="all, delete-orphan", order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)

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
    conversation = relationship("Conversation", back_populates="messages")


class Opportunity(Base):
    """
    Pipeline deal between lead qualification and quoting.
    Inspired by Twenty CRM's opportunity model and Fieldcamp's deal stages.
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

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    client = relationship("Client", back_populates="opportunities")
    intake = relationship("LeadIntake", back_populates="opportunity", uselist=False)


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
    is_primary = Column(Boolean, default=False)
    phone_type = Column(String, nullable=True)         # mobile | office | home
    source = Column(String, nullable=True)             # website | twilio | manual
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="contact_phones")


class Activity(Base):
    """
    Unified timeline entry for any client/opportunity touchpoint.
    Inspired by Twenty CRM's TimelineActivity pattern.
    """
    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=True)

    actor = Column(String, nullable=True)
    activity_type = Column(String, nullable=False, index=True)
    # email_sent | email_received | sms_sent | sms_received
    # note_added | status_changed | quote_sent | job_completed
    # form_submitted | call_logged | opportunity_created | opportunity_won
    summary = Column(String, nullable=True)
    extra_data = Column(JSON, default=dict)

    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="activities")
    opportunity = relationship("Opportunity")


class AppSetting(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, nullable=False, unique=True, index=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
