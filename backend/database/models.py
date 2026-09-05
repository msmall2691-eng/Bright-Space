from sqlalchemy import (
    Column, Integer, String, Float, DateTime, Text, Date, Time, BigInteger,
    JSON, ForeignKey, Boolean, UniqueConstraint, Index, Enum as SQLEnum, ARRAY, text,
    LargeBinary,
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

    # Crew accounts (Phase 1 — native crew directory): links a role="cleaner"
    # login to the crew-ID string space Job.cleaner_ids already uses (these
    # were originally Connecteam employee IDs — see CleanerTimeOff). NULL
    # for everyone else. Additive: existing dispatch and
    # payroll are untouched; this only lets a cleaner log in and see the jobs
    # already assigned to their crew ID.
    cleaner_id = Column(String, nullable=True, index=True)

    # Per-cleaner pay rate overrides ($/hr) for the native payroll source. NULL
    # = use the global Settings rate for that bucket (pay_rate_residential /
    # pay_rate_rental_weekday). Only meaningful for role="cleaner" logins; lets
    # an admin pay individual crew above/below the shop default.
    pay_rate_residential = Column(Float, nullable=True)
    pay_rate_rental = Column(Float, nullable=True)
    # Per-cleaner override ($/hr) for deep-clean jobs (job_type="deep_clean").
    # NULL = use the shop default (Settings pay_rate_deep_clean, which itself
    # falls back to the residential rate). Native payroll only.
    pay_rate_deep = Column(Float, nullable=True)

    # Emergency contact, self-maintained from the crew app's Me tab (migration
    # 082) — on file for people working alone in clients' homes.
    emergency_contact_name = Column(String, nullable=True)
    emergency_contact_phone = Column(String, nullable=True)
    # Crew app: a lead cleaner the admin flagged can see the WHOLE month
    # schedule (titles/times/names only — access details stay need-to-know,
    # own jobs only). Admin-set via the users PATCH; never self-service.
    can_view_full_schedule = Column(Boolean, default=False, nullable=False)
    # Secret token for the personal read-only iCal feed (/api/crew-cal/
    # {token}.ics) that cleaners subscribe to from Google/Apple Calendar.
    # Unguessable, revocable by rotation; NULL until first requested.
    calendar_token = Column(String(64), nullable=True, unique=True, index=True)

    # Cleaner home address, office-entered (migration 092) — the start/end of
    # the pre-calculated mileage chain (home → first job → between houses).
    # home_lat/home_lng cache the geocode result (services/geocoding.py) so
    # each address hits Google once; cleared whenever home_address changes.
    # Office-facing only: this never rides any crew/customer payload.
    home_address = Column(String(400), nullable=True)
    home_lat = Column(Float, nullable=True)
    home_lng = Column(Float, nullable=True)

    # Per-user, per-category push notification opt-out (migration 094). NULL,
    # or a missing key within it, means that category is ON — opt-OUT
    # semantics so nobody's existing notifications go silent on deploy day.
    # Keys are the category names in services/push_service.py's category
    # list (role-scoped: office roles get requests/messages/quotes/crew,
    # cleaners get job_assignments/office_messages/time_off/digest); only an
    # explicit `false` turns one off. Never rides any crew/customer payload.
    notification_prefs = Column(JSON, nullable=True)

    client = relationship("Client", back_populates="user", foreign_keys="User.client_id")
    # User.jobs_assigned was dropped by migration 040 — its FK column
    # (Job.assigned_cleaner_user_id) was never wired up; Job.cleaner_ids is
    # the single assignment source.


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
    gcal_sync_enabled = Column(Boolean, default=False, nullable=False)
    last_sync_at = Column(DateTime, nullable=True)
    last_sync_error = Column(Text, nullable=True)
    # Gmail History API cursor: the mailbox historyId the last sync reached.
    # Incremental syncs read changes *from* here instead of re-scanning the
    # inbox each poll. NULL until the first (full) sync seeds it.
    gmail_history_id = Column(String, nullable=True)
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
    # Cached geocode of the address (migration 092), filled lazily the first
    # time the payroll mileage report needs this stop (services/geocoding.py).
    # NULL = not geocoded yet. Not office-editable directly — derived data.
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
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
    # Guest WiFi (migration 090): on crew job cards AND in the offline cache,
    # so a cleaner in a dead zone can read the credentials and get online.
    wifi_ssid = Column(String(120), nullable=True)
    wifi_password = Column(String(120), nullable=True)
    notes = Column(Text, nullable=True)

    # STR property specific fields (NULL for residential/commercial)
    check_in_time = Column(String(5), nullable=True)   # "14:00" format
    check_out_time = Column(String(5), nullable=True)  # "10:00" format
    house_code = Column(String(255), nullable=True)    # Access code or combination
    timezone = Column(String, nullable=True)           # Property timezone for STR

    # Commercial property specific fields (NULL for residential/str)
    business_name = Column(String, nullable=True)      # If different from Client.name
    hours_of_operation = Column(Text, nullable=True)   # Hours as text or JSON

    # Weekend rental turnovers are paid piece-rate, not hourly, and the amount
    # varies per property. Payroll reads this to price weekend str_turnover work.
    # NULL = not set yet (Payroll flags weekend turnovers it can't price).
    turnover_rate = Column(Float, nullable=True)

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
    # Float, not Integer — homes have half-baths (2½). Storing as int rounded
    # the customer's real bath count and made the operator's view disagree
    # with the quote the customer was shown.
    bathrooms = Column(Float, nullable=True)
    square_footage = Column(Integer, nullable=True)
    # Year the home was built — pulled from public property records (RentCast)
    # via the Add/Edit Property "look up specs" action, or entered by hand.
    # NULL = unknown. Same lineage as bedrooms/bathrooms/square_footage above.
    year_built = Column(Integer, nullable=True)
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
    # events_seen from this feed's most recent successful sync — lets the next
    # sync detect a suspiciously small/partial fetch (a truncated response can
    # still parse as valid iCal with a handful of VEVENTs) and skip the
    # cancellation sweep for that tick rather than false-cancelling bookings
    # that just didn't make it into the partial read.
    last_events_seen = Column(Integer, nullable=True)

    created_at = Column(DateTime, default=_utcnow)

    property = relationship("Property", back_populates="property_icals")


class ICalEvent(Base):
    """A single event parsed from an STR property's iCal feed."""
    __tablename__ = "ical_events"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=False, index=True)
    # Which specific feed produced this event — lets the multi-feed
    # cancellation sweep tell "this booking's own feed says it's gone" apart
    # from "a DIFFERENT feed on this property just didn't mention it".
    # Nullable: rows created before this column existed are unattributed.
    property_ical_id = Column(Integer, ForeignKey("property_icals.id"), nullable=True, index=True)

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
    # The deal this recurring engagement belongs to. A won, recurring deal is
    # the shape of an ongoing customer — carrying opportunity_id lets the deal
    # board show a won deal's cadence directly instead of inferring it through
    # the shared client (migration 065). Nullable: set when the schedule is
    # created from an accepted quote; NULL for ad-hoc schedules.
    opportunity_id = Column(Integer, ForeignKey("opportunities.id", ondelete="SET NULL"), nullable=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=True, index=True)
    active = Column(Boolean, default=True, nullable=False)
    generate_weeks_ahead = Column(Integer, default=8)
    # Exclusive upper bound on generated dates — set when a "this and all
    # future" edit splits the series: this schedule stops here, and a new
    # RecurringSchedule picks up from the split date with the edited rule.
    # NULL (the common case) means open-ended.
    series_end_date = Column(Date, nullable=True)
    # When the owner CANCELLED the series, as opposed to pausing it. Both set
    # `active=False` — that stays the single authority on whether visits are
    # generated — so this column only ever changes what the UI calls the row.
    # NULL = never cancelled, which is how every pre-migration row reads.
    # Cleared on resume: a series generating visits again isn't cancelled.
    cancelled_at = Column(DateTime, nullable=True)
    # Inclusive lower bound — set on the NEW schedule a split creates, so a
    # changed day-of-week can't generate occurrences before the split point
    # (generate_dates always expands from today forward with no floor
    # otherwise). NULL (the common case) means no floor.
    series_start_date = Column(Date, nullable=True)
    # User-facing "ends after N occurrences" choice, kept purely for display
    # round-trip (see migration 051) — series_end_date remains the single
    # column generate_dates() enforces; this is NULL whenever the series
    # never ends or ends on an explicit date instead of a count.
    series_end_occurrences = Column(Integer, nullable=True)
    # Stable phase reference for weekly/biweekly/every-N-week cadence. Before
    # this column, generate_dates() re-derived the "on-week/off-week" phase
    # from business_today() on every daily tick, so a biweekly series re-seated
    # its phase each day and silently filled in the off-weeks — biweekly
    # collapsed to weekly (see migration 060). anchor_date pins the phase to
    # the series' first intended occurrence so the cadence stays put. NULL for
    # rows that predate the column and haven't regenerated yet; generation
    # falls back to series_start_date → earliest Job → today when unset.
    anchor_date = Column(Date, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    client = relationship("Client", back_populates="recurring_schedules")
    opportunity = relationship("Opportunity")
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
    # One job per quote. NULLs allowed for ad-hoc jobs (Postgres treats NULLs as
    # distinct, so unique=True does not block multiple quote-less jobs).
    quote_id = Column(Integer, ForeignKey("quotes.id"), nullable=True, unique=True, index=True)
    opportunity_id = Column(Integer, ForeignKey("opportunities.id"), nullable=True)

    # Job classification
    job_type = Column(String, nullable=False, default="residential")
    # "residential" | "deep_clean" | "commercial" | "str_turnover"
    # Native-payroll override for how THIS job is paid, beating the automatic
    # rule (weekend str_turnover → piece rate; everything else hourly).
    # NULL/"auto" = automatic; "hourly" = pay hours at the job's hourly rate even
    # on a weekend; "piece" = pay the property's turnover piece rate. Lets the
    # office pay a specific weekend airbnb hourly (or force piece) per job.
    pay_mode = Column(String(16), nullable=True)
    # Extra dollars-per-hour on top of each cleaner's normal hourly rate for
    # THIS job — the shop's "+$1/hr for a two-cleaner deep clean / weekday
    # immediate turnover" offer, set per job during the week. Hourly pay only;
    # piece-rate pay ignores it (the flat turnover rate is the whole payment).
    # NULL/0 = no bump. Migration 078.
    pay_rate_bump = Column(Float, nullable=True)

    # Links — only set for the relevant type
    property_id = Column(Integer, ForeignKey("properties.id"), nullable=False)  # PR 2: Every job must have a property
    recurring_schedule_id = Column(Integer, ForeignKey("recurring_schedules.id"), nullable=True)
    ical_event_id = Column(Integer, ForeignKey("ical_events.id"), nullable=True, index=True)
    # Job.assigned_cleaner_user_id was dropped by migration 040 — it was a
    # never-used placeholder ("Future: replace cleaner_ids JSON") that had
    # sat unread since 001. Job.cleaner_ids is the single assignment source.

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
    # same booking instead of spawning a duplicate.
    gcal_ical_uid = Column(String, nullable=True, index=True)

    title = Column(String, nullable=False)
    scheduled_date = Column(Date)       # ISO date
    start_time = Column(Time)           # HH:MM:SS
    end_time = Column(Time)             # HH:MM:SS
    address = Column(String)
    cleaner_ids = Column(JSON, default=list)
    status = Column(String, default="scheduled")
    # "unscheduled" | "scheduled" | "in_progress" | "completed" | "cancelled"
    # "unscheduled" is the state a converted quote lands in until an operator
    # picks a date; the scheduling PATCH endpoint auto-flips to "scheduled"
    # when scheduled_date is set so the Job listing stops mislabeling
    # date-less jobs as "Scheduled".
    notes = Column(Text)
    custom_fields = Column(JSON, default=dict)
    dispatched = Column(Boolean, default=False, nullable=False)
    # Crew app Phase 3: the office flips this to put the job "up for grabs" on
    # every cleaner's Schedule tab (owner decision #2: ONLY office-marked jobs
    # are claimable — an unassigned job is not automatically open). The first
    # successful claim adds the claimer to cleaner_ids and flips this back off.
    open_for_claims = Column(Boolean, default=False, nullable=False)
    # Marketplace pivot (migration 097): the office's asking rate when a job
    # is posted open, and the FINAL agreed rate once a request is approved
    # (may differ from posted_rate — the winning sub may have countered).
    # NULL posted_rate = not currently posted. Payroll/invoicing for a
    # marketplace job should read agreed_rate, never posted_rate.
    posted_rate = Column(Float, nullable=True)
    agreed_rate = Column(Float, nullable=True)
    # (connecteam_shift_ids / connecteam_synced_schedule were dropped by
    # migration 079 with the Connecteam removal.)

    # Completion tracking — set when the cleaner marks the job done. Migrated
    # from the Visit table as part of the Job/Visit unification (see
    # docs/job-visit-unification.md and migration 038); Visit is retained until
    # PR-C drops it, but Job is now the single source of truth for completion.
    completed_at = Column(DateTime, nullable=True)
    completed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    checklist_results = Column(JSON, nullable=True)
    photos = Column(JSON, default=list)
    # Internal note the cleaner left when marking the job done ("lockbox was
    # empty"). Deliberately its OWN column, not appended to Job.notes:
    # _auto_create_draft_invoice copies Job.notes onto the customer-facing
    # invoice, and a crew field report must never leak to a client. Migration 080.
    completion_note = Column(Text, nullable=True)

    # Customer-facing confirm/reschedule-request link (Part 2 Tier 2 — mirrors
    # Quote.public_token). Lazily generated the first time it's needed (the
    # reminder SMS, or a staff-initiated "send confirm link").
    public_token = Column(String(64), nullable=True, unique=True, index=True)
    customer_confirmed_at = Column(DateTime, nullable=True)
    # A request does NOT auto-reschedule the job — it queues for staff to
    # action, same as the roadmap doc's "requests land in your queue".
    reschedule_requested_at = Column(DateTime, nullable=True)
    reschedule_request_message = Column(Text, nullable=True)
    # Customer self-reschedule that landed on a busy slot (a double-book): the
    # requested move is held here as a pending approval instead of moving the
    # job. The owner approves (applies these) or declines (clears them). NULL
    # when there's no pending self-reschedule. A free-slot self-reschedule
    # applies immediately and never populates these.
    reschedule_requested_date = Column(Date, nullable=True)
    reschedule_requested_start_time = Column(Time, nullable=True)
    reschedule_requested_end_time = Column(Time, nullable=True)
    # "this" (single visit) or "future" (this + all future, for a recurring
    # series) — the scope the customer chose for the pending move.
    reschedule_requested_scope = Column(String, nullable=True)

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
    # Job.visits relationship was dropped by migration 039; the Visit table is
    # retired and completion state now lives on Job itself.
    # Job.assigned_cleaner was dropped by migration 040 (see the column note).

    __table_args__ = (
        Index("idx_job_property_date", property_id, scheduled_date),
        Index("idx_job_client_status", client_id, status),
        Index("idx_job_scheduled_date_status", scheduled_date, status),
        # DB-level backstop against the cancel<->recreate duplicate-turnover
        # bug: at most one live (non-cancelled) str_turnover job per
        # property/checkout-date. Scoped to str_turnover only — residential/
        # commercial properties can legitimately have more than one job on
        # the same date. Mirrors migration 052's Postgres/SQLite index so the
        # constraint is enforced in the create_all-based test schema too.
        Index(
            "uq_jobs_turnover_property_date_live",
            property_id, scheduled_date, job_type,
            unique=True,
            postgresql_where=text("status <> 'cancelled' AND job_type = 'str_turnover'"),
            sqlite_where=text("status <> 'cancelled' AND job_type = 'str_turnover'"),
        ),
    )



class TimeEntry(Base):
    """A crew clock-in/out punch — BrightBase's native time & attendance record
    (Phase 2a of the native crew app).

    This is a NEW canonical domain: *when a cleaner actually worked*. It is
    distinct from the schedule (Job owns date/time/assignment) and from job
    completion (Job.completed_at is a "marked done" stamp, not worked time).
    Writing a punch never touches Job schedule state, so it stays clear of the
    scheduling-authority contract.

    Native payroll's source of hours: /api/payroll/summary classifies each
    punch by its linked job and computes pay from it.

    cleaner_id is the same string identifier Job.cleaner_ids / User.cleaner_id
    use, so a punch ties to the same person the schedule assigns. job_id
    (nullable) links a punch to the job being worked — how payroll classifies
    hours by job_type.
    """
    __tablename__ = "time_entries"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    cleaner_id = Column(String, nullable=False, index=True)   # matches Job.cleaner_ids / User.cleaner_id
    # The login that punched (audit / a future "edit my timesheet"). SET NULL so
    # deleting a user never destroys the worked-time record.
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Optional link to the job being worked; SET NULL so cancelling/deleting a
    # job never erases that someone was present and working.
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True)

    # Naive UTC, matching the rest of the app's stored timestamps. The endpoints
    # set these explicitly (not via a column default) so clock arithmetic never
    # mixes aware/naive datetimes.
    clock_in_at = Column(DateTime, nullable=False)
    clock_out_at = Column(DateTime, nullable=True)    # NULL = still on the clock (open punch)
    break_minutes = Column(Integer, nullable=False, default=0)
    note = Column(Text, nullable=True)
    # Miles driven for this job, entered by the crew at clock-out. NULL = not
    # entered (treated as 0 in payroll); reimbursed at the Settings
    # 'mileage_rate' (IRS default) in the payroll path.
    miles = Column(Float, nullable=True)
    # 'native' today; room to tag an imported entry later without a migration.
    source = Column(String(16), nullable=False, default="native")

    # GPS captured at clock-in (Phase 2b) — browser geolocation, best-effort.
    # NULL when the device denied location or it was unavailable; a punch is
    # never blocked on GPS. accuracy is the browser's reported radius in meters.
    clock_in_lat = Column(Float, nullable=True)
    clock_in_lng = Column(Float, nullable=True)
    clock_in_accuracy_m = Column(Float, nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    job = relationship("Job")

    __table_args__ = (
        # "Am I currently clocked in?" — the open-punch lookup (clock_out IS NULL).
        Index("idx_time_entry_cleaner_open", "cleaner_id", "clock_out_at"),
        # "My punches for a day" — hours-today / history.
        Index("idx_time_entry_cleaner_in", "cleaner_id", "clock_in_at"),
        # One open punch per cleaner per org (payroll integrity): at most one row
        # with clock_out_at IS NULL. The endpoint pre-checks too, but this is the
        # race backstop. Mirrors the Job turnover-uniqueness pattern so it holds
        # in both Postgres (prod) and the SQLite test schema.
        Index("uq_time_entry_one_open_per_cleaner", "org_id", "cleaner_id",
              unique=True,
              postgresql_where=text("clock_out_at IS NULL"),
              sqlite_where=text("clock_out_at IS NULL")),
    )


class JobPhoto(Base):
    """A before/after photo a cleaner (or the office) attached to a job.

    Stored as bytes IN the database, deliberately: Railway's container disk is
    ephemeral (a deploy would eat photos on the filesystem) and there is no
    object store configured. The frontend downscales to ~1600px JPEG before
    upload (~200-400KB), and the endpoint hard-caps size and count, so rows
    stay small enough for Postgres to be the photo store at this shop's scale.

    Its own table rather than the legacy Job.photos JSON blob: Job rows are
    bulk-fetched constantly (Schedule, My Day, dashboards), and photo bytes
    inlined there would ride along on every one of those queries. Here the
    bytes load only when a single photo is actually served.
    """
    __tablename__ = "job_photos"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    # Photos are completion evidence for one specific visit — no standalone
    # value once the job row is gone, so they go with it.
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    # Who took it (drives "you can delete your own"). SET NULL so removing a
    # user never destroys the photo record.
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    kind = Column(String(8), nullable=True)            # "before" | "after" | NULL (untagged)
    content_type = Column(String(64), nullable=False)  # image/jpeg | image/png | image/webp
    size_bytes = Column(Integer, nullable=False)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    job = relationship("Job")


class JobResponse(Base):
    """A cleaner's answer to being put on a job — accepted, or declined with a
    reason. This is a STATUS, not a schedule write (crew-app plan decision #1):
    declining never edits Job.cleaner_ids — the office sees the flag and
    decides the reassignment, so nothing silently falls off the schedule.

    One row per (job, cleaner), updated in place when they change their mind;
    the unique constraint is the upsert backstop.
    """
    __tablename__ = "job_responses"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    # Same crew-ID string space as Job.cleaner_ids / User.cleaner_id.
    cleaner_id = Column(String, nullable=False, index=True)
    # The login that answered (audit). SET NULL so removing a user keeps the record.
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    response = Column(String(8), nullable=False)   # "accepted" | "declined"
    reason = Column(Text, nullable=True)           # declines only, optional
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    job = relationship("Job")

    __table_args__ = (
        UniqueConstraint("job_id", "cleaner_id", name="uq_job_response_job_cleaner"),
    )


class JobClaimRequest(Base):
    """A subcontractor's request to take an open (open_for_claims) job, with
    an optional counter-offer on the office's posted_rate. Marketplace pivot
    (migration 097) — replaces the old first-come-first-served instant claim.

    Multiple pending rows can exist for the same job (several subs asking);
    approving one auto-declines the rest (application logic — see
    modules/scheduling/router.py's approve/decline-claim-request endpoints,
    not a DB trigger, so the notification/activity-log side effects stay in
    one place). One row per (job, cleaner) — a second request from the same
    sub updates their existing pending row rather than duplicating it.
    """
    __tablename__ = "job_claim_requests"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    cleaner_id = Column(String, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requested_rate = Column(Float, nullable=True)  # NULL = accepting posted_rate
    message = Column(Text, nullable=True)
    status = Column(String(16), nullable=False, default="pending")  # pending|approved|declined|withdrawn
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    job = relationship("Job")


class SubDocument(Base):
    """One vetting document on a subcontractor's file (migration 098).

    Bytes live in the database, the same deliberate choice JobPhoto makes:
    Railway's container disk is ephemeral, so a file written to it is a file
    lost on the next deploy.

    UNIQUE on (user_id, kind) — re-uploading a COI replaces the one on file
    rather than leaving three rows and the office guessing which is live.

    NO SSN/TIN FIELD, deliberately. A sole-proprietor W-9 carries one; the
    document is stored as bytes and never parsed, and `ein` is the only
    identifier with a column because it identifies a business, not a person.
    """
    __tablename__ = "sub_documents"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", name="uq_sub_documents_user_kind"),
    )
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    kind = Column(String(16), nullable=False, index=True)   # w9|coi|license|agreement|id
    status = Column(String(16), nullable=False, default="pending")  # missing|pending|accepted|expired
    expires_at = Column(Date, nullable=True)
    filename = Column(String(255), nullable=True)
    content_type = Column(String(64), nullable=True)
    size_bytes = Column(Integer, nullable=True)
    data = Column(LargeBinary, nullable=True)
    notes = Column(Text, nullable=True)
    uploaded_at = Column(DateTime, nullable=True)
    reviewed_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class SubAgreement(Base):
    """One acceptance of the subcontractor agreement, versioned (migration 098).

    Append-only: a new acceptance is a new row, never an update to the last
    one. The whole value of this table is being able to say which text a
    person agreed to and when — an updated row destroys exactly that.
    """
    __tablename__ = "sub_agreements"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    version = Column(String(32), nullable=False)
    accepted_at = Column(DateTime, nullable=False, default=_utcnow)
    accepted_ip = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class SubPayout(Base):
    """One amount owed to a subcontractor, and whether it went out
    (migration 099).

    Subs are VENDORS, not payroll: Square's Labor timecard path carries hours
    at an hourly rate, which is the exact shape a subcontractor's pay must not
    have. This is the ledger that survives whatever payment rail is chosen
    later — the rail changes, the record of what was owed does not.

    UNIQUE (user_id, job_id): re-running a period must never pay the same
    cleaning twice. Adjustments carry a NULL job_id and are exempt for free,
    since NULLs compare distinct in a unique constraint.
    """
    __tablename__ = "sub_payouts"
    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_sub_payouts_user_job"),
    )
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    cleaner_id = Column(String, nullable=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="SET NULL"),
                    nullable=True, index=True)
    amount = Column(Float, nullable=False)
    status = Column(String(16), nullable=False, default="due")  # due|sent|paid|void
    method = Column(String(32), nullable=True)
    external_ref = Column(String(128), nullable=True)
    memo = Column(Text, nullable=True)
    # The work date this pays for. A January payout for December work belongs
    # to December, so a year-to-date total groups by this and not created_at.
    earned_on = Column(Date, nullable=True, index=True)
    paid_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class SubApplication(Base):
    """Somebody asking to join the bench (migration 102).

    An application is NOT a user, and this is not `users`. Anyone on the
    internet can create a row here; nobody can create a login. Approval is the
    step that mints a crew account, and it is a person clicking a button.

    NO SSN OR TIN COLUMN, deliberately. A sub's tax identifier arrives later
    inside the W-9 held in `sub_documents` — bytes, never parsed. `ein`
    identifies a BUSINESS rather than a person, which is why it is the only
    identifier here, and it is optional.

    `user_id` records the account approval created, so an application can be
    traced to the person it became and approving twice can't mint two logins.
    """
    __tablename__ = "sub_applications"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    email = Column(String(255), nullable=False, index=True)
    phone = Column(String(32), nullable=True)
    business_name = Column(String(200), nullable=True)
    ein = Column(String(32), nullable=True)
    towns = Column(Text, nullable=True)
    experience = Column(Text, nullable=True)
    message = Column(Text, nullable=True)
    # Self-reported and treated as such — the real answers come from the
    # documents on file once they're accepted. These only decide who is worth
    # a phone call.
    has_insurance = Column(Boolean, nullable=True)
    has_transport = Column(Boolean, nullable=True)
    weekends = Column(Boolean, nullable=True)
    source = Column(String(64), nullable=True)
    status = Column(String(16), nullable=False, default="new")  # new|reviewing|approved|declined
    notes = Column(Text, nullable=True)                          # office-only
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"),
                     nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class TurnoverWindow(Base):
    """One week's turnovers, staffed as a batch (migration 101).

    STR turnovers can't be a route — the volume swings week to week — so they
    stay posted jobs. A window is the schedule and the price ladder around a
    single service day: it opens that day's turnovers to the bench all at once
    and raises the price on whatever is still unclaimed as the date closes in.

    UNIQUE (org_id, service_date): the date is the identity. Two windows for
    one Saturday would step the same jobs twice.

    It owns no work. Opening writes `open_for_claims` and `posted_rate` on
    ordinary Jobs — the marketplace path from 097 — and the claim, the
    approval and the money all run exactly as they already do.
    """
    __tablename__ = "turnover_windows"
    __table_args__ = (
        UniqueConstraint("org_id", "service_date", name="uq_turnover_windows_org_date"),
    )
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    service_date = Column(Date, nullable=False, index=True)
    status = Column(String(16), nullable=False, default="pending")  # pending|open|closed
    base_rate = Column(Float, nullable=True)
    # A step adds this percentage of the BASE rate, not of the current one.
    # Compounding turns a 10% ladder into a 61% raise by step five, which is
    # not what anybody typed.
    step_pct = Column(Float, nullable=False, default=10.0)
    max_steps = Column(Integer, nullable=False, default=3)
    # Stored, not derived from the current price: the office can nudge a job's
    # posted_rate by hand, and a ladder that re-read its position from the rate
    # would restart or skip depending on which way they nudged it.
    steps_taken = Column(Integer, nullable=False, default=0)
    open_days_before = Column(Integer, nullable=False, default=10)
    first_step_days_before = Column(Integer, nullable=False, default=4)
    opened_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    last_stepped_at = Column(DateTime, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class Route(Base):
    """A standing block of recurring work owned by one subcontractor
    (migration 100).

    The marketplace (097) fits one-off work: post, request, approve, done.
    Recurring work is most of the book and re-bidding the same Tuesday house
    every week serves nobody — so a route is offered ONCE, accepted once, and
    then simply happens.

    `rate` is per occurrence of the whole block. Generation splits it across
    that occurrence's jobs into Job.agreed_rate, which is the flat-rate path
    payroll already pays — see services/routes.py for the split, and note the
    deliberate consequence that a route job is indistinguishable from an
    approved marketplace job by the time it reaches money.

    Offered, never assigned: a route a sub can decline is work they chose,
    which is the same control point the marketplace claim provides and is
    load-bearing for contractor classification.
    """
    __tablename__ = "routes"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    day_of_week = Column(Integer, nullable=False)      # 0=Mon … 6=Sun, display/grouping
    owner_cleaner_id = Column(String, nullable=True, index=True)
    backup_cleaner_id = Column(String, nullable=True)
    rate = Column(Float, nullable=True)                # per occurrence, whole block
    status = Column(String(16), nullable=False, default="draft")  # draft|offered|active|ended
    offered_at = Column(DateTime, nullable=True)
    accepted_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    members = relationship("RouteMember", back_populates="route",
                           cascade="all, delete-orphan",
                           order_by="RouteMember.position")


class RouteMember(Base):
    """One recurring schedule's place in a route, in drive order.

    UNIQUE on recurring_schedule_id: a schedule in two routes means two people
    are paid for one house.
    """
    __tablename__ = "route_members"
    __table_args__ = (
        UniqueConstraint("recurring_schedule_id", name="uq_route_members_schedule"),
    )
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    route_id = Column(Integer, ForeignKey("routes.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    recurring_schedule_id = Column(Integer,
                                   ForeignKey("recurring_schedules.id", ondelete="CASCADE"),
                                   nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=_utcnow)

    route = relationship("Route", back_populates="members")
    schedule = relationship("RecurringSchedule")

class CrewDoc(Base):
    """One training / reference document for the crew (crew app Phase 5):
    cleaning standards, chemical guides, onboarding steps, policies. The
    office writes them (modules/crew_docs), cleaners read published ones in
    the crew app's Learn tab. Plain text body rendered as-is — deliberately
    no attachments or rich markup, so the library stays maintainable by one
    person and readable on a phone in a driveway.
    """
    __tablename__ = "crew_docs"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    # NULL = a company doc (office-authored, crew-readable). Set = a PRIVATE
    # note owned by that user: visible ONLY to them — excluded from the
    # office list AND the crew feed (migration 089).
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=False, default="")
    # Optional external link (training video, manufacturer guide). A doc with
    # a URL renders as an open-in-browser row in the Learn tab; body optional.
    url = Column(String(500), nullable=True)
    category = Column(String(40), nullable=False, default="how-to")
    pinned = Column(Boolean, nullable=False, default=False)
    published = Column(Boolean, nullable=False, default=True)
    updated_by = Column(String, nullable=True)   # display name of last editor
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class CleanerWeekAvailability(Base):
    """A cleaner's availability for ONE SPECIFIC WEEK (crew app Phase 4b,
    owner feedback on the live template editor: "show which week; let them
    set weeks in advance but not change the week that's underway").

    week_start is the MONDAY the week begins (design-review decision: the
    {mon..sun}-keyed week JSON and the Me tab's Monday-anchored pay week
    make Monday the only anchor where the grid's first row is the week's
    first day; the office Schedule's Sunday-first strip is display-only —
    it consumes availability per single date). Always snap through
    utils.dates.week_monday() before lookup or lock checks. Same
    {mon..sun: [am,pm]} JSON shape as the CleanerAvailability template; a
    missing row for a week means "use the template". Rows for the
    current/past weeks are LOCKED server-side: the office schedules against
    a stable picture, and same-week emergencies go through the office
    (CleanerTimeOff), not here.
    """
    __tablename__ = "cleaner_week_availability"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    cleaner_id = Column(String, nullable=False, index=True)
    week_start = Column(Date, nullable=False)   # the Monday this week begins
    week = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    __table_args__ = (
        UniqueConstraint("cleaner_id", "week_start", name="uq_cleaner_week_availability"),
    )


class PropertyCrewNote(Base):
    """Field knowledge about ONE property, written by the crew who clean it
    ("the upstairs drain clogs", "spare linens in the basement"). A note
    starts visible to its author + the office; the office can mark it SHARED
    so every cleaner working that property sees it on their card. Rentals
    are the heavy users — recurring houses accumulate quirks.
    """
    __tablename__ = "property_crew_notes"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    author_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    author_name = Column(String, nullable=True)
    body = Column(Text, nullable=False)
    shared = Column(Boolean, nullable=False, default=False)   # office-promoted
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class PropertyPhoto(Base):
    """A REFERENCE photo for a property — how the beds are staged, where the
    supplies live — viewed by every cleaner before/while cleaning there.
    Distinct from JobPhoto (one visit's before/after evidence): these
    persist across visits. Bytes in-DB for the same reasons as JobPhoto
    (ephemeral container disk, no object store, downscaled uploads); they
    load only when the gallery sheet is actually opened, never on my-day.
    """
    __tablename__ = "property_photos"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    caption = Column(String(200), nullable=True)      # "Master bed — 4 pillows, throw folded"
    content_type = Column(String(64), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime, default=_utcnow)


class CrewMessage(Base):
    """One message in a cleaner↔office thread (crew app: "chat message the
    office"). One thread per cleaner user; sender says which side wrote it.
    Push notifications carry attention both ways (notify_staff on crew
    sends, notify_user on office replies); read_at is set when the other
    side loads the thread."""
    __tablename__ = "crew_messages"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    sender = Column(String(8), nullable=False)      # "cleaner" | "office"
    sender_name = Column(String, nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    read_at = Column(DateTime, nullable=True)


class CleanerAvailability(Base):
    """A cleaner's WEEKLY availability pattern, self-maintained from the crew
    app's Me tab (crew app Phase 4, owner decision #3: per-day AM / PM / Off).

    `week` is {"mon": ["am","pm"], "tue": ["am"], ... "sun": []} — a missing
    day means off, a missing ROW means the cleaner never set a pattern
    (unknown, not off). This is a SIGNAL for the office's assign surfaces
    ("usually off Friday afternoon"), never a hard block — the office can
    always assign anyway. One-off absences stay in CleanerTimeOff (date
    ranges); this is the recurring shape of their week.
    """
    __tablename__ = "cleaner_availability"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    # Same crew-ID string space as Job.cleaner_ids / User.cleaner_id.
    cleaner_id = Column(String, nullable=False, unique=True, index=True)
    week = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


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
    # The service the customer actually chose on maineclean.co (e.g. "deep",
    # "move-in-out") BEFORE it's bucketed into the canonical service_type above.
    # A deep clean is priced as residential + a multiplier, so without this the
    # request shows "Residential" and the deep-driven estimate looks wrong.
    requested_service = Column(String, nullable=True)
    bedrooms = Column(Integer, nullable=True)
    # Float so half-baths (2½) survive — see the Property.bathrooms note.
    bathrooms = Column(Float, nullable=True)
    square_footage = Column(Integer, nullable=True)
    guests = Column(Integer, nullable=True)
    # Home condition + pet hair the customer reported. These are pricing inputs
    # (they add labor on the same engine the website uses), so they were driving
    # the estimate but weren't stored — the request showed a number with no
    # explanation. Persist them so the operator sees the whole request.
    condition = Column(String, nullable=True)   # maintenance | moderate | heavy
    pet_hair = Column(String, nullable=True)    # none | some | heavy
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
    # Client-supplied idempotency token (UUID). Every public POST from
    # maineclean.co carries one so retries, dual-forwards from the Express
    # middle layer, and the two-endpoint pattern (booking + intake) all
    # collapse to a single Lead row instead of racing past the 5-minute
    # recency SELECT. Unique index enforces this at the DB level;
    # `upsert_lead` short-circuits when a match is found. Nullable so
    # pre-migration rows and any non-website callers still work.
    idempotency_key = Column(String(64), nullable=True, unique=True, index=True)
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

    # Automatic overdue-invoice email chase (T-03).
    # dunning_stage: 0 = none sent yet, 1/2/3 = which cadence reminder was
    # last sent. Once 3 fires we stop. Reset to 0 if the invoice flips to
    # `paid` — the dunning_service handles that.
    dunning_stage = Column(Integer, nullable=False, default=0, server_default="0")
    dunning_last_sent_at = Column(DateTime(timezone=True), nullable=True)

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

    assignee = Column(String, nullable=True, index=True)   # display label / legacy free-text
    # Real teammate reference (Phase F). Nullable — an unassigned or a legacy
    # string-only assignment has no id. `assignee` above stays the display label
    # and back-compat; new assignments set both. FK declared here only (the
    # migration adds a plain indexed column, per this repo's convention).
    assignee_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
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


class InboxTriageItem(Base):
    """A low-priority automated/bulk inbound email captured for the Ops Board's
    triage sections (Systems & Subscriptions / Safe to Ignore).

    BrightBase threads *human* email into Conversations (the "Real People
    Waiting" board section). The automated stream — SaaS/billing notices,
    receipts, security alerts, newsletters, promotions — used to be filtered out
    by integrations/email_filter and silently discarded. This table captures
    that stream, classified, so the board can surface "subscriptions worth a
    glance" vs "safe to ignore" instead of the operator wading through Gmail.

    Populated from the inbound sync (services/inbox_triage.capture_triage_item),
    deduped on the email Message-ID (external_id) per org. Rows are never sent
    or replied to; an operator "Dismiss" just stamps dismissed_at so the card
    drops off the board (the raw email stays in Gmail untouched)."""
    __tablename__ = "inbox_triage_items"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    external_id = Column(String, nullable=True, index=True)   # email Message-ID (dedup key)
    # Which member's connected Google account synced it (NULL = shared inbox).
    source_account_id = Column(
        Integer, ForeignKey("user_google_accounts.id", ondelete="SET NULL"), nullable=True)

    from_addr = Column(String, nullable=True)
    from_name = Column(String, nullable=True)
    subject = Column(String, nullable=True)
    snippet = Column(Text, nullable=True)
    received_at = Column(DateTime, nullable=True, index=True)

    # Classification (services/inbox_triage.classify_email)
    category = Column(String, nullable=False, default="other")
    # saas | finance | security | promotions | social | updates | other
    section = Column(String, nullable=False, default="safe_to_ignore")
    # which board section it routes to: "systems" | "safe_to_ignore"
    vendor = Column(String, nullable=True)            # best-effort brand/sender label
    unsubscribe_url = Column(String, nullable=True)   # http(s) List-Unsubscribe target
    classified_by = Column(String, nullable=False, default="rules")  # rules | ai

    is_read = Column(Boolean, default=False, nullable=False)
    dismissed_at = Column(DateTime, nullable=True)    # operator cleared it → hidden from board
    # True once the underlying email has been moved to Gmail Trash (a "Delete",
    # not just a board dismiss). Drives the Undo path (untrash) and lets the list
    # show whether the real email is gone. Requires the account's gmail.modify grant.
    gmail_trashed = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    __table_args__ = (
        # Board read: non-dismissed rows for an org, grouped by section.
        Index("idx_inbox_triage_org_section", "org_id", "section", "dismissed_at"),
    )


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
    CHANGES_REQUESTED = "changes_requested"
    ACCEPTED = "accepted"
    CONVERTED = "converted"
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
    were originally Connecteam employee IDs). Used by the scheduling guard so
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
    # Crew-app requests (migration 089): office-created rows default
    # 'approved' (the historical behavior); crew-submitted rows arrive
    # 'requested' and only count as OFF once the office approves. 'denied'
    # rows are kept for the cleaner's own history, never for scheduling.
    status = Column(String(12), nullable=False, default="approved")
    requested_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
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
    provider = Column(String, nullable=False)      # 'gcal' | 'email' | 'sms' | 'connecteam' (legacy rows)
    action = Column(String, nullable=False)        # 'create' | 'update' | 'delete' | 'send'
    status = Column(String, nullable=False)        # 'ok' | 'failed'
    external_id = Column(String, nullable=True)    # gcal_event_id, message sid, email id, ...
    error_message = Column(String, nullable=True)  # failure reason (status='failed')
    request_payload = Column(String, nullable=True)   # short human note (e.g. "to a@b.com")
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


class PushSubscription(Base):
    """A single browser/device Web Push subscription for a staff user.

    One user can have several (phone PWA, laptop Chrome, …), so the natural key
    is the push `endpoint` (unique). We store the endpoint + the p256dh/auth
    keys the VAPID send needs, scoped to (org, user). Rows are pruned when a
    send returns 404/410 Gone (the browser dropped the subscription)."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(String(255), nullable=False)
    auth = Column(String(255), nullable=False)
    user_agent = Column(String(255), nullable=True)  # for a readable device list
    created_at = Column(DateTime, default=_utcnow)
    last_used_at = Column(DateTime, nullable=True)


class ScheduleEvent(Base):
    """Append-only, immutable, ordered log of canonical schedule mutations.

    Phase 2 of the scheduling redesign (docs/scheduling-sync-redesign.md, under
    the `scheduling-invariants` contract). Every canonical Job mutation — create,
    reschedule, reassign, cancel, complete, delete — emits exactly one row here,
    written IN THE SAME TRANSACTION as the Job write by a Session flush listener
    (services/schedule_events.py), gated by SCHEDULE_EVENT_LOG_ENABLED (default
    OFF). Nothing READS this yet: it is the dual-write foundation the Phase 3
    reconciler will drain into `projection_state`, built alongside today's
    behavior (R8) so it can be verified against real data before any cutover.
    Ordered by `id`; never updated or deleted (append-only).
    """
    __tablename__ = "schedule_events"
    # No FKs on this table by design: an append-only, immutable log must OUTLIVE
    # the rows it records. A jobs FK with CASCADE would erase a deleted job's
    # history, and logging a `deleted` event in the same transaction that removes
    # the job would FK-violate the just-gone row on Postgres and roll back the
    # deletion itself. org_id is a denormalized tenant tag (RLS reads the value,
    # not a FK). Migration 077 drops the constraints migration 068 created.
    org_id = Column(Integer, nullable=True, index=True)  # tenant scope (MT-1); denormalized, no FK

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, nullable=False, index=True)  # references jobs.id, but intentionally NO FK (see note above)
    # created | rescheduled | reassigned | cancelled | completed | updated | deleted
    event_type = Column(String(24), nullable=False)
    # {field: [old, new]} for the tracked fields that changed (dates/times as ISO
    # strings), or a full snapshot for create/delete. JSON so it round-trips on
    # both Postgres and SQLite.
    payload = Column(JSON, nullable=True)
    actor = Column(String(64), nullable=True)  # best-effort cause (reserved; unused in Phase 2)
    created_at = Column(DateTime, default=_utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("idx_schedule_events_job", "job_id", "id"),
    )


class ProjectionState(Base):
    """Per-target sync bookkeeping for the Phase 3 reconciler.

    For each (target, job) it records how far that projection has been advanced
    from the `schedule_events` log plus the last push outcome, so "sync health"
    becomes a row you READ rather than a scan you recompute. Written by the
    Phase 3 reconciler (not yet built) and read by the sync-status surfaces.
    Additive and unused in Phase 2 — shipped now so the migration lands once.
    """
    __tablename__ = "projection_state"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)  # tenant scope (MT-1)

    id = Column(Integer, primary_key=True, index=True)
    target = Column(String(24), nullable=False)  # "gcal" (was also "connecteam" pre-removal)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    last_event_applied = Column(Integer, nullable=True)  # schedule_events.id cursor
    last_push_at = Column(DateTime, nullable=True)
    last_push_status = Column(String(16), nullable=True)  # "ok" | "failed" | "pending"
    drift_count = Column(Integer, nullable=False, default=0)
    external_id = Column(String, nullable=True)  # stable target id (gcal event / ct shift) — R4
    version = Column(String(64), nullable=True)  # etag/version for idempotent push — R4
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("target", "job_id", name="uq_projection_state_target_job"),
        Index("idx_projection_state_job", "job_id"),
    )


class ProposedAction(Base):
    """Autopilot approval gate: an action an AI tick/persona WANTS to take,
    parked here for a human to approve or dismiss (migration 091).

    Nothing automated executes from this table. Approval (modules/ai/router.py
    → services/proposals.py) runs the action through the SAME write path a
    human uses — assign_cleaner goes through scheduling's update_job (GCal
    side effects and conflict guards included), send_sms through the comms
    send paths — never raw column writes (scheduling-invariants R6). The
    'propose' mode of the EXISTING STR turnover auto-assign tick writes rows
    here instead of assigning (R1: no new tick).

    `kind` is validated against the allowlist in services/proposals.py;
    `status` is pending | approved | dismissed | executed | failed, validated
    in code (deliberately no DB enum type). `payload` is the kind-specific
    input (e.g. {job_id, cleaner_id}); `result` records the execution outcome
    (or {'error': ...} on failure)."""
    __tablename__ = "proposed_actions"
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=False, index=True)  # tenant scope (MT-3)

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(String(40), nullable=True)   # which persona/tick proposed ('mia', ...)
    kind = Column(String(40), nullable=False)      # 'assign_cleaner' | 'send_sms'
    title = Column(String(255), nullable=False)    # human summary ("Assign Ana to Sea Rose turnover on 2026-08-20")
    detail = Column(Text, nullable=True)
    payload = Column(JSON, nullable=False, default=dict)
    status = Column(String(20), nullable=False, default="pending", index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    decided_at = Column(DateTime, nullable=True)
    decided_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    result = Column(JSON, nullable=True)

    __table_args__ = (
        Index("idx_proposed_actions_org_status", "org_id", "status"),
    )
