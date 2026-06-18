"""
Canonical client `source` values.

`source` had drifted into free text — `website` and `Website`, plus internal
markers like `gcal_instance`, `xlsx_import`, `parsed_from_id`, `merge`,
`completed/cancelled visit`. That makes the funnel "where do leads come from?"
meaningless. normalize_source() maps every known variant onto a small canonical
set and sends anything unrecognized to "unknown", so reporting can group cleanly.
"""

# The canonical set (matches the Phase 1 plan).
SOURCE_CANONICAL = {
    "website", "sms", "email", "referral", "manual", "ical", "phone", "unknown",
}

# Known historical / internal variants → canonical bucket.
SOURCE_ALIASES = {
    "web": "website",
    "gmail": "email",
    "twilio": "sms",
    "text": "sms",
    "call": "phone",
    "phone_call": "phone",
    # Spreadsheet / bulk imports are a manual add.
    "xlsx": "manual",
    "xlsx_import": "manual",
    "import": "manual",
    "merge": "manual",
    # Calendar-sourced records (Google Calendar / iCal turnovers).
    "gcal": "ical",
    "google": "ical",
    "gcal_instance": "ical",
    "gcal_all_day": "ical",
    "calendar": "ical",
}


def normalize_source(value) -> str:
    """Map any source string to a canonical value; unknown/blank → "unknown"."""
    if not value or not str(value).strip():
        return "unknown"
    key = str(value).strip().lower()
    if key in SOURCE_CANONICAL:
        return key
    return SOURCE_ALIASES.get(key, "unknown")
