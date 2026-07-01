from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text, Date, Time, BigInteger,
    JSON, ForeignKey, Boolean, UniqueConstraint, Index, Enum as SQLEnum, ARRAY
)
from sqlalchemy.orm import relationship, validates

from utils.source import normalize_source
from datetime import datetime, timezone, date

def _utcnow():
    return datetime.now(timezone.utc)
from uuid import uuid4
from enum import Enum
from database.base import Base



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
    created_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        UniqueConstraint("entity_type", "key", name="uq_field_entity_key"),
    )


class Org(Base):
    """Workspace/tenant (Twenty-style). v1 is single-org (id=1, seeded at boot)
    but every new table carries org_id so a second company later is a data
    backfill, not a redesign. See docs/auth-workspaces-plan-2026-06.md."""
    __tablename__ = "orgs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    slug = Column(String(64), nullable=False, unique=True)
    created_at = Column(DateTime, default=_utcnow)


class User(Base):
    """System users: admins, cleaners, and clients who log in to the app."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, nullable=False, unique=True, index=True)
    # Nullable: Google-SSO-only users have no password.
    password_hash = Column(String, nullable=True)
    # Google sign-in identity (stable subject id), bound on first Google login.
    google_sub = Column(String, nullable=True, unique=True, index=True)
    auth_provider = Column(String, nullable=True)  # 'password' | 'google' (informational)
    full_name = Column(String, nullable=True)
    role = Column(String, nullable=False, default=UserRole.CLIENT)
    # admin | manager | member | viewer | cleaner | client
    # FK to Client — only set for role=client users. Admins/cleaners have no client profile.
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    phone = Column(String, nullable=True)
    active = Column(Boolean, default=True, nullable=False)
    # Workspace membership + approval. New self-signups are 'pending' (no API
    # access) until an admin approves; allow-list emails/domains auto-approve.
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)
    status = Column(String(16), nullable=False, default="active")  # active | pending | disabled
    approved_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="user", foreign_keys="User.client_id")
    jobs_assigned = relationship("Job", back_populates="assigned_cleaner", foreign_keys="Job.assigned_cleaner_user_id")


class UserGoogleAccount(Base):
    """Per-user Google OAuth grant (Twenty's connectedAccount): each member
    connects their OWN Google account; tokens are Fernet-encrypted with
    TOKEN_ENCRYPTION_KEY (never plaintext); Gmail/Calendar sync cursors live
    here so each account feeds the workspace independently. Replaces the
    single shared google_token AppSetting / GOOGLE_TOKEN_B64 pattern."""
    __tablename__ = "user_google_accounts"

    id = Column(Integer, primary_key=True, index=True)
    # One Google account per user (v1).
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, unique=True, index=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=False, index=True)
    google_sub = Column(String(64), nullable=False)
    email = Column(String(255), nullable=False)
    access_token = Column(Text, nullable=True)    # encrypted
    refresh_token = Column(Text, nullable=True)   # encrypted
    token_expiry = Column(DateTime, nullable=True)
    scopes = Column(JSON, default=list, nullable=False)  # granted, not requested
    status = Column(String(16), nullable=False, default="connected")
    # connected | expired | revoked

    # Per-channel sync state (Twenty's message/calendar channels).
    gmail_sync_enabled = Column(Boolean, default=False, nullable=False)
    gmail_history_id = Column(String(32), nullable=True)   # incremental Gmail cursor
    gcal_sync_enabled = Column(Boolean, default=False, nullable=False)
    gcal_calendar_id = Column(String(255), nullable=True)
    gcal_sync_token = Column(Text, nullable=True)          # incremental events cursor
    last_sync_at = Column(DateTime, nullable=True)
    last_sync_error = Column(Text, nullable=True)
    connected_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        UniqueConstraint("org_id", "google_sub", name="uq_user_google_accounts_org_sub"),
    )

    user = relationship("User", foreign_keys=[user_id])


class Client(Base):
    """Central hub entity connected to all business records."""
    __tablename__ = "clients"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)          # full display name (derived or manually set)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    email = Column(String)
    phone = Column(String)
    phone_tail = Column(String(10), nullable=True, index=True)
    # Lead-phase contact address. Used before any Property exists, and as
    # a fallback when client.properties is empty. Once properties exist,
    # prefer properties[0].address (or the property selected in the UI)
    # for correspondence and job defaults.
    address = Column(String)
    city = Column(String)
    state = Column(String)
    zip_code = Column(String)
    # Billing address (where invoices are sent)
    billing_address = Column(String, nullable=True)
    billing_city = Column(String, nullable=True)
    billing_state = Column(String, nullable=True)
    billing_zip = Column(String, nullable=True)
    status = Column(String, default="lead", index=True)  # lead, active, inactive
    notes = Column(Text)
    source = Column(String)  # canonical: website|sms|email|referral|manual|ical|phone|unknown
    custom_fields = Column(JSON, default=dict)
    created_at = Column(DateTime, default=_utcnow)
    # Audit actor metadata (Twenty's ActorMetadata): who/what created and last
    # updated the record, and when. Nullable — public/website writes have no user.
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # client_type column removed by migration 007 — duplicated property_type
    # semantically. The CRM summary endpoint now derives it from
    # client.properties (single type → that type, multiple → "mixed",
    # none → "residential" default).
    # lifecycle_stage was dropped by migration 036: it duplicated
    # Opportunity.stage and the value is now derived from client.opportunities
    # (won → customer, any → opportunity, none → new).
    source_detail = Column(String, nullable=True)       # "maineclean.co contact form", "gmail auto-create"
    last_contacted_at = Column(DateTime, nullable=True)
    email_verified = Column(Boolean, default=False)

    # Relationships - all cascade delete with client
    user = relationship("User", back_populates="client", uselist=False, foreign_keys="User.client_id")  # One client per user (for role=client users)
    quotes = relationship("Quote", back_populates="client", cascade="all, delete-orphan", foreign_keys="Quote.client_id")
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

    @validates("source")
    def _canonicalize_source(self, _key, value):
        """Enforce the canonical source set on every write path (API, Gmail,
        Twilio, calendar sync) so reporting groups cleanly. Only canonicalizes a
        non-None assignment — leaving source unset stays NULL until something
        sets it."""
        return normalize_source(value) if value is not None else None


class Property(Base):
    """A property (residential, commercial, or STR) belonging to a client."""
    __tablename__ = "properties"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)

    name = Column(String, nullable=False)           # "4 Red Barn Circle" (address, not service description)
    address = Column(String, nullable=False)
    city = Column(String)
    state = Column(String)
    zip_code = Column(String)
    # Constrained at the DB level via migration 006's CHECK constraint
    # (`ck_properties_property_type`) to one of: residential | commercial | str.
    property_type = Column(String, default="residential", nullable=False)

    # Property.ical_url (single-feed legacy column) was dropped by migration
    # 037; iCal feeds live exclusively in the PropertyIcal table now.
    # ical_last_synced_at still tracks "last time we ran a property-wide sync"
    # (across all PropertyIcal feeds), so it stays.
    ical_last_synced_at = Column(DateTime, nullable=True)
    default_duration_hours = Column(Float, default=3.0)  # turnover duration
    default_crew_size = Column(Integer, nullable=True)    # default crew size for jobs

    access_notes = Column(Text, nullable=True)      # "Side door, lockbox 4251"
    parking_notes = Column(Text, nullable=True)     # Parking information
    notes = Column(Text, nullable=True)

    # STR property specific fields (NULL for residential/commercial)
    check_in_time = Column(String(5), nullable=True)   # "14:00" format
    check_out_time = Column(String(5), nullable=True)  # "10:00" format
    house_code = Column(String(255), nullable=True)    # Access code or combination
    timezone = Column(String, nullable=True)           # Property timezone for STR

    # Commercial property specific fields (NULL for residential/str)
    business_name = Column(String, nullable=True)      # If different from Client.name
    hours_of_operation = Column(Text, nullable=True)   # Hours as text or JSON

    # Onsite contact (different from billing client)
    site_contact_name = Column(String, nullable=True)
    site_contact_phone = Column(String, nullable=True)
    site_contact_email = Column(String, nullable=True)

    # Per-property cleaning checklist template. JSON array of areas, each
    # containing a list of tasks. Used to populate the "Complete Visit"
    # flow — cleaners check off tasks, results get saved to Visit.checklist_results.
    # Shape: [{"area": "Kitchen", "tasks": ["Wipe counters", "Clean sink", "Mop floor"]}, ...]
    checklist_template = Column(JSON, nullable=True)

    # Admin-defined custom fields (metadata), same mechanism as Client/Job/Invoice.
    custom_fields = Column(JSON, default=dict)

    active = Column(Boolean, default=True, nullable=False)
    # Structured size details, carried over from the lead/intake on convert so a
    # quote can pre-fill from the customer's request instead of re-typing.
    bedrooms = Column(Integer, nullable=True)
    bathrooms = Column(Integer, nullable=True)
    square_footage = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    client = relationship("Client", back_populates="properties")
    ical_events = relationship("ICalEvent", back_populates="property", cascade="all, delete-orphan")
    property_icals = relationship("PropertyIcal", back_populates="property", cascade="all, delete-orphan")
    jobs = relationship("Job", back_populates="property")


class PropertyIcal(Base):
    """Multiple iCal URLs per property (Airbnb, VRBO, manual calendars, etc.)"""
    __tablename__ = "property_icals"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

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

    # PR 6: Sync status — per-feed observability
    last_synced_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String, nullable=True)  # 'ok', 'failed', 'retrying', 'paused'
    last_sync_error = Column(Text, nullable=True)     # Error message from last failed sync
    sync_retry_count = Column(Integer, default=0)     # How many times we've retried after failure

    created_at = Column(DateTime, default=_utcnow)

    property = relationship("Property", back_populates="property_icals")


class ICalEvent(Base):
    """A single event parsed from an STR property's iCal feed."""
    __tablename__ = "ical_events"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

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
    created_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        UniqueConstraint("property_id", "uid", name="uq_ical_property_uid"),
    )

    property = relationship("Property", back_populates="ical_events")
    job = relationship("Job", back_populates="ical_event", foreign_keys=[job_id], uselist=False)


class RecurringSchedule(Base):
    """Defines a recurring cleaning engagement for residential or commercial clients."""
    __tablename__ = "recurring_schedules"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)

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
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=True, index=True)
    active = Column(Boolean, default=True, nullable=False)
    generate_weeks_ahead = Column(Integer, default=8)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="recurring_schedules")
    jobs = relationship("Job", back_populates="recurring_schedule")
    exceptions = relationship(
        "RecurrenceException",
        back_populates="recurring_schedule",
        cascade="all, delete-orphan",
    )


class RecurrenceException(Base):
    """A skip or reschedule applied to a single occurrence of a RecurringSchedule.

    Phase 1: durable RFC-5545-style exception model. A row here means the
    corresponding date in the recurrence rule should NOT generate a Job (skip),
    or should generate a Job at a different date/time (reschedule). The
    UNIQUE(recurring_schedule_id, exception_date) constraint guarantees at
    most one exception per (schedule, original date) pair so repeated user
    actions are idempotent.
    """
    __tablename__ = "recurrence_exceptions"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    recurring_schedule_id = Column(
        Integer,
        ForeignKey("recurring_schedules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    exception_date = Column(Date, nullable=False, index=True)
    # "skip" — date is excluded from generation entirely
    # "reschedule" — date is excluded; a Job is created at rescheduled_date instead
    exception_type = Column(String, nullable=False)
    rescheduled_date = Column(Date, nullable=True)
    rescheduled_start_time = Column(Time, nullable=True)
    rescheduled_end_time = Column(Time, nullable=True)
    reason = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    recurring_schedule = relationship(
        "RecurringSchedule", back_populates="exceptions"
    )
    creator = relationship("User", foreign_keys=[created_by])

    __table_args__ = (
        UniqueConstraint(
            "recurring_schedule_id",
            "exception_date",
            name="uq_recurrence_exception_schedule_date",
        ),
    )


class Job(Base):
    """A cleaning job/task linked to a client, opportunity, and possibly quote."""
    __tablename__ = "jobs"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

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
    ical_event_id = Column(Integer, ForeignKey("ical_events.id"), nullable=True, index=True)
    assigned_cleaner_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # Future: replace cleaner_ids JSON

    # Notification tracking
    calendar_invite_sent = Column(Boolean, default=False, nullable=False)
    sms_reminder_sent = Column(Boolean, default=False, nullable=False)
    # Hybrid reminder opt-out: reminders are sent by default; staff can set this
    # True to suppress the 24h SMS for a single job without disabling the system.
    skip_sms_reminder = Column(Boolean, default=False, nullable=False)
    gcal_event_id = Column(String, nullable=True)   # Google Calendar event ID for two-way sync
    # Whose connected Google account owns the calendar event (NULL = legacy
    # shared business calendar token).
    gcal_account_id = Column(
        Integer, ForeignKey("user_google_accounts.id", ondelete="SET NULL"), nullable=True)
    # Stable Google identifier for idempotent matching (Twenty stores iCalUid on
    # CalendarEvent). Matched on FIRST during sync — before extendedProperties,
    # attendee, and address — so a re-created/moved event is recognized as the
    # same booking instead of spawning a duplicate. externalUpdatedAt is Google's
    # last-modified time, kept for drift detection.
    gcal_ical_uid = Column(String, nullable=True, index=True)
    gcal_external_updated_at = Column(DateTime(timezone=True), nullable=True)

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
    dispatched = Column(Boolean, default=False, nullable=False)
    connecteam_shift_ids = Column(JSON, default=list)

    # Completion tracking — set when the cleaner marks the job done. Migrated
    # from the Visit table as part of the Job/Visit unification (see
    # docs/job-visit-unification.md and migration 038); Visit is retained until
    # PR-C drops it, but Job is now the single source of truth for completion.
    completed_at = Column(DateTime, nullable=True)
    completed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    checklist_results = Column(JSON, nullable=True)
    photos = Column(JSON, default=list)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    client = relationship("Client", back_populates="jobs")
    opportunity = relationship("Opportunity", back_populates="jobs")
    property = relationship("Property", back_populates="jobs", foreign_keys=[property_id])
    recurring_schedule = relationship("RecurringSchedule", back_populates="jobs")
    ical_event = relationship(
        "ICalEvent", back_populates="job",
        foreign_keys="ICalEvent.job_id", uselist=False
    )
    assigned_cleaner = relationship("User", back_populates="jobs_assigned", foreign_keys=[assigned_cleaner_user_id])
    visits = relationship("Visit", back_populates="job", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_job_property_date", property_id, scheduled_date),
        Index("idx_job_client_status", client_id, status),
        Index("idx_job_scheduled_date_status", scheduled_date, status),
    )


class Visit(Base):
    """A single physical visit/occurrence of a Job. One job can have many visits (recurring cleans, multi-day projects)."""
    __tablename__ = "visits"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    # BIGINT on Postgres (prod); plain INTEGER on SQLite so the primary key
    # autoincrements there (SQLite only aliases rowid for INTEGER PRIMARY KEY,
    # not BIGINT) — needed for the test suite to insert visits.
    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, index=True)

    # When is this visit scheduled?
    scheduled_date = Column(Date, nullable=False, index=True)
    start_time = Column(Time, nullable=False)
    end_time = Column(Time, nullable=False)

    # Who is assigned?
    cleaner_ids = Column(JSON, default=list)  # [user_id, ...] for backcompat; will migrate to dedicated assignment table later

    # Visit lifecycle
    status = Column(String, nullable=False, default="scheduled")
    # scheduled | dispatched | en_route | in_progress | completed | no_show | cancelled

    # iCal source (for STR turnovers)
    ical_source = Column(String, nullable=True)  # "airbnb", "vrbo", "hospitable", etc.
    ical_uid = Column(String, nullable=True, index=True)  # RFC 5545 UID for idempotency
    ical_synced_at = Column(DateTime, nullable=True)  # When this visit was imported from iCal

    # GCal integration
    gcal_event_id = Column(String, nullable=True)

    # Completion tracking
    completed_at = Column(DateTime, nullable=True)
    completed_by = Column(Integer, ForeignKey("users.id"), nullable=True)  # Which user marked it complete
    notes = Column(Text)

    # Photos, checklist (structured data)
    checklist_results = Column(JSON, nullable=True)  # {"task_id": "done"/"skipped"/"failed", ...}
    photos = Column(JSON, default=list)  # [{"url": "...", "timestamp": "...", "label": "before"}, ...]

    # Audit trail
    created_at = Column(DateTime, nullable=False, default=_utcnow)
    updated_at = Column(DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

    # Constraints
    __table_args__ = (
        UniqueConstraint("ical_source", "ical_uid", name="uq_visit_ical_source_uid"),  # iCal idempotency
        Index("idx_visit_scheduled_date_status", scheduled_date, status),
        Index("idx_visit_job_date", job_id, scheduled_date),
    )

    job = relationship("Job", back_populates="visits")
    completed_by_user = relationship("User", foreign_keys=[completed_by], uselist=False)


class LeadIntake(Base):
    """Initial contact form submission from lead before client/opportunity creation."""
    __tablename__ = "lead_intakes"
    # The Requests list filters by status and orders by created_at; this
    # composite index serves both in one structure (Phase 0).
    __table_args__ = (Index("idx_intake_status_created", "status", "created_at"),)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)
    # Back-reference to the quote this intake was converted into (§6 traceability).
    converted_quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True)

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
    property_id = Column(Integer, ForeignKey("properties.id", ondelete="SET NULL"), nullable=True)
    property_name = Column(String, nullable=True)
    message = Column(Text)
    preferred_date = Column(String)
    preferred_time = Column(String, nullable=True)
    source = Column(String, default="website")
    status = Column(String, default="new")  # new/reviewed/quoted/converted/archived
    priority = Column(String, default="normal")  # low/normal/high/urgent
    assigned_to = Column(String, nullable=True)
    internal_notes = Column(Text, nullable=True)
    custom_fields = Column(JSON, default=dict)
    followed_up_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    client = relationship("Client", back_populates="lead_intakes")
    opportunity = relationship("Opportunity", back_populates="intake", uselist=False)





class Invoice(Base):
    """Invoice linked to client, job, and opportunity."""
    __tablename__ = "invoices"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
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
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    client = relationship("Client", back_populates="invoices")
    opportunity = relationship("Opportunity", back_populates="invoices")


class Conversation(Base):
    """
    Multi-channel conversation thread with a contact.
    Groups related Messages across SMS / email / chat / etc.
    Linked to client and opportunity for full context.
    """
    __tablename__ = "conversations"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

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

    # Which member's connected Google account synced this in (NULL = legacy
    # shared business inbox). Lets per-user sync be attributed and unsynced.
    synced_by_google_account_id = Column(
        Integer, ForeignKey("user_google_accounts.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    client = relationship("Client", back_populates="conversations")
    opportunity = relationship("Opportunity", back_populates="conversations")
    messages = relationship(
        "Message", back_populates="conversation",
        cascade="all, delete-orphan", order_by="Message.created_at",
    )


class Message(Base):
    """Single message (email, SMS, chat, etc.) within a conversation."""
    __tablename__ = "messages"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
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

    # Which member's connected Google account synced this in (NULL = legacy
    # shared business inbox).
    synced_by_google_account_id = Column(
        Integer, ForeignKey("user_google_accounts.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, default=_utcnow)

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
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

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

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    # Relationships
    client = relationship("Client", back_populates="opportunities")
    intake = relationship("LeadIntake", back_populates="opportunity", uselist=False)
    # Quote is now Integer-keyed (since migration 018), so the back-reference
    # binds cleanly. The earlier "Quote uses UUID FKs" removal note was stale.
    quotes = relationship(
        "Quote", back_populates="opportunity",
        foreign_keys="Quote.opportunity_id",
    )
    invoices = relationship("Invoice", back_populates="opportunity")
    jobs = relationship("Job", back_populates="opportunity")
    conversations = relationship("Conversation", back_populates="opportunity")
    messages = relationship("Message", back_populates="opportunity")
    activities = relationship("Activity", back_populates="opportunity")


class ContactEmail(Base):
    """Multiple email addresses per client (Twenty CRM pattern for enrichment)."""
    __tablename__ = "contact_emails"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    email = Column(String, nullable=False, index=True)
    is_primary = Column(Boolean, default=False)
    source = Column(String, nullable=True)             # website | gmail_sync | manual
    verified_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="contact_emails")


class ContactPhone(Base):
    """Multiple phone numbers per client."""
    __tablename__ = "contact_phones"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    phone = Column(String, nullable=False, index=True)
    phone_tail = Column(String(10), nullable=True, index=True)
    is_primary = Column(Boolean, default=False)
    phone_type = Column(String, nullable=True)         # mobile | office | home
    source = Column(String, nullable=True)             # website | twilio | manual
    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="contact_phones")


class Activity(Base):
    """
    Unified timeline entry for any client/opportunity/job touchpoint.
    Tracks all interactions: emails, SMS, calls, notes, status changes, etc.
    """
    __tablename__ = "activities"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True)
    # SET NULL: deleting a message (any channel — SMS or email) must orphan
    # the timeline entry, not be blocked by it.
    message_id = Column(Integer, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)

    actor = Column(String, nullable=True)
    activity_type = Column(String, nullable=False, index=True)
    # Uses ActivityType enum values (email_sent, email_received, sms_sent, etc.)
    summary = Column(String, nullable=True)
    extra_data = Column(JSON, default=dict)

    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="activities")
    opportunity = relationship("Opportunity", back_populates="activities")


class AppSetting(Base):
    """Application-wide settings (email credentials, integrations, etc.)."""
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, nullable=False, unique=True, index=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


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


# ── Quote Models ──────────────────────────────────────────────────────
from decimal import Decimal
from typing import Optional
from uuid import UUID
from sqlalchemy import Numeric, CheckConstraint, func
from sqlalchemy.dialects.postgresql import UUID as PGUUID



class QuoteStatus(str, Enum):
    """Quote lifecycle status."""
    DRAFT = "draft"
    SENT = "sent"
    VIEWED = "viewed"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    EXPIRED = "expired"
    ARCHIVED = "archived"


class Quote(Base):
    """A customer quote.

    Integer-keyed to match clients/jobs/invoices/opportunities (the rest of the
    app). Line items are stored inline as JSON (the same shape Invoice.items
    uses) rather than in a separate table, which matches what the Quoting UI
    sends and reads. Replaces the earlier UUID-keyed Quote + QuoteLineItem
    design that couldn't link to the integer Client/Job ids."""
    __tablename__ = "quotes"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)

    # Relationships (all integer FKs)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    intake_id = Column(Integer, ForeignKey("lead_intakes.id", ondelete="SET NULL"), nullable=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id", ondelete="SET NULL"), nullable=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id", ondelete="SET NULL"), nullable=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Metadata
    quote_number = Column(String(50), nullable=False, unique=True)
    # Opaque token for the public (no-login) accept page link.
    public_token = Column(String(64), nullable=True, unique=True, index=True)
    title = Column(String(255), nullable=True)
    service_type = Column(String(100), nullable=True)   # residential | commercial | str
    # Customer's stated cleaning cadence (weekly | biweekly | monthly), carried
    # from the lead so a won quote can pre-fill the recurring-plan setup.
    frequency = Column(String(50), nullable=True)
    address = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)

    # Line items, inline JSON: [{"name", "description", "qty", "unit_price"}]
    items = Column(JSON, nullable=False, default=list)

    # Pricing (tax_rate is a percent, e.g. 5.5)
    subtotal = Column(Float, nullable=False, default=0.0)
    tax_rate = Column(Float, nullable=False, default=0.0)
    tax = Column(Float, nullable=False, default=0.0)
    discount = Column(Float, nullable=False, default=0.0)
    total = Column(Float, nullable=False, default=0.0)

    # Customer-facing intro paragraph: shown on the public quote page and in
    # the quote email, editable in the quote editor (distinct from the
    # send-time "personal note", which is one-off).
    customer_message = Column(Text, nullable=True)
    # Operator-only notes (intake context, access details, reminders). NEVER
    # rendered to customers — an intake note ("TEST submission ... Please
    # disregard") leaked onto a live public quote page on June 11. `notes`
    # remains the customer-facing scope.
    internal_notes = Column(Text, nullable=True)

    # Status & workflow
    status = Column(String(50), nullable=False, default="draft")
    valid_until = Column(Date, nullable=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    viewed_at = Column(DateTime(timezone=True), nullable=True)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    declined_at = Column(DateTime(timezone=True), nullable=True)
    # When an accepted quote was turned into a Job (conversion tracking).
    converted_at = Column(DateTime(timezone=True), nullable=True)
    # Soft-delete: archived quotes are hidden from lists but recoverable, and
    # their linked data (jobs/emails) is preserved.
    archived_at = Column(DateTime(timezone=True), nullable=True)
    # When a follow-up nudge was last sent on a stale sent/viewed quote.
    follow_up_sent_at = Column(DateTime(timezone=True), nullable=True)
    # Delivery visibility: the last send attempt and why it failed (cleared on
    # a successful send). A failed send used to leave the quote sitting in
    # "draft" with no trace in the UI.
    last_send_attempt_at = Column(DateTime(timezone=True), nullable=True)
    last_send_error = Column(Text, nullable=True)

    # Acceptance capture (from the public accept page)
    accepted_by_name = Column(String(255), nullable=True)
    accepted_by_email = Column(String(255), nullable=True)

    # Customer response capture from the public page (change request / decline),
    # so the message/reason is persisted on the quote, not just an activity log.
    requested_changes_message = Column(Text, nullable=True)
    requested_changes_at = Column(DateTime(timezone=True), nullable=True)
    declined_reason = Column(Text, nullable=True)
    declined_by_name = Column(String(255), nullable=True)

    custom_fields = Column(JSON, default=dict)

    created_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)

    # Relationships
    client = relationship("Client", back_populates="quotes", foreign_keys=[client_id])
    property = relationship("Property", foreign_keys=[property_id])
    created_by_user = relationship("User", foreign_keys=[created_by])
    opportunity = relationship(
        "Opportunity", back_populates="quotes", foreign_keys=[opportunity_id],
    )
    # Delivery history (email + SMS sends) lives on IntegrationEvent rather
    # than per-channel tables — see migration 035.

    __table_args__ = (
        UniqueConstraint("quote_number", name="uq_quote_number"),
    )


class CleanerTimeOff(Base):
    """A date range a cleaner is unavailable (vacation, sick, etc.).

    cleaner_id matches the string identifiers stored in Job.cleaner_ids (these
    are Connecteam employee IDs in production). Used by the scheduling guard so
    a cleaner can't be assigned to a job on a day they're off. Dates are
    inclusive (start_date..end_date)."""
    __tablename__ = "cleaner_time_off"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    cleaner_id = Column(String, nullable=False, index=True)
    cleaner_name = Column(String, nullable=True)   # denormalized label for the UI
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    reason = Column(String, nullable=True)         # "vacation" | "sick" | free text
    created_at = Column(DateTime, default=_utcnow)

    __table_args__ = (
        Index("idx_cleaner_timeoff_lookup", "cleaner_id", "start_date", "end_date"),
    )

    def __repr__(self):
        return f"<CleanerTimeOff(cleaner_id={self.cleaner_id}, {self.start_date}..{self.end_date})>"


class IntegrationEvent(Base):
    """Audit log of outbound integration actions (Google Calendar, email, SMS).

    One row per attempt to push/update/delete something on an external provider,
    so the operator can answer "did this job's calendar event actually get
    created/deleted?" and "did the quote email/text go out?" without reading
    server logs. Write-only/best-effort: logging must never break the action it
    records (§5.5 of the April audit).

    The table itself was scaffolded in 001_initial_schema.py but never wired to a
    model or used; this model adopts that exact schema (no new migration), so
    create_all (tests) and the existing prod table stay in lockstep."""
    __tablename__ = "integration_events"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String, nullable=False)   # 'job' | 'visit' | 'quote' | 'invoice'
    entity_id = Column(Integer, nullable=False)    # the row this action was for
    provider = Column(String, nullable=False)      # 'gcal' | 'email' | 'sms' | 'connecteam'
    action = Column(String, nullable=False)        # 'create' | 'update' | 'delete' | 'send'
    status = Column(String, nullable=False)        # 'ok' | 'failed'
    external_id = Column(String, nullable=True)    # gcal_event_id, message sid, email id, ...
    error_message = Column(String, nullable=True)  # failure reason (status='failed')
    error_code = Column(String, nullable=True)     # provider error code, if any
    request_payload = Column(String, nullable=True)   # short human note (e.g. "to a@b.com")
    response_payload = Column(String, nullable=True)  # provider response summary, if any
    created_at = Column(DateTime, default=_utcnow, index=True)


class SavedView(Base):
    """A user's saved list-view preset (Twenty's "views"): a named bundle of a
    list page's filters / sort / visible-columns / layout for one entity type.

    Per-user AND per-workspace (org), so each member curates their own views
    without affecting anyone else. `config` is an opaque JSON blob owned by the
    frontend (e.g. {"statusFilter": "active", "viewMode": "table"}) — keeping it
    schemaless lets each list page evolve what it persists without a migration.
    At most one default per (user, entity_type)."""
    __tablename__ = "saved_views"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=False, index=True)  # tenant scope (MT-1)
    entity_type = Column(String(40), nullable=False, index=True)  # 'client' | 'opportunity' | ...
    name = Column(String(120), nullable=False)
    config = Column(JSON, default=dict, nullable=False)
    is_default = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
