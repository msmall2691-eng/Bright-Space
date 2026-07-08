"""services.booking_email_service — customer booking-confirmation renderer.

The old inline builder in modules/booking/router.py rendered the receipt as
plain `<div><br>`-text and pasted the raw ISO timestamp into the subject
and body (`Booking request received — 2026-07-07T22:18:23.208Z`). These
tests pin the new template's guarantees:

  - Subject NEVER contains an ISO timestamp — only the human date.
  - Date rendering copes with both YYYY-MM-DD (the common booking-form
    shape) and a full ISO timestamp (defensive against leaks).
  - Service type maps to human labels; unknown values are titlecased.
  - CTAs (`tel:`, `sms:`, `mailto:`) render iff we have the number/email.
  - Estimate line + address only appear when the caller provides them.
  - Plain-text body never contains HTML tags.
"""
from services.booking_email_service import (
    build_booking_confirmation_email,
    format_requested_date,
    service_label,
    _phone_tel_href,
    _parse_requested_date,
)


# ── date parsing ───────────────────────────────────────────────────────────

def test_format_requested_date_from_ymd():
    # The most common booking-form shape.
    assert format_requested_date("2026-07-15") == "Wed, Jul 15, 2026"


def test_format_requested_date_from_full_iso_timestamp():
    # Defensive: earlier versions leaked the full ISO. Must still render nicely.
    assert format_requested_date("2026-07-07T22:18:23.208Z") == "Tue, Jul 7, 2026"


def test_format_requested_date_missing_or_garbage_falls_back():
    """A truly unparseable value shouldn't crash — surface it verbatim so
    the customer at least sees something recognizable."""
    assert format_requested_date(None) == "your requested date"
    assert format_requested_date("") == "your requested date"
    assert format_requested_date("not-a-date") == "not-a-date"


def test_parse_requested_date_returns_none_on_junk():
    assert _parse_requested_date(None) is None
    assert _parse_requested_date("nope") is None


# ── service labels ─────────────────────────────────────────────────────────

def test_service_label_known_types():
    assert service_label("standard") == "Standard clean"
    assert service_label("deep") == "Deep clean"
    assert service_label("str") == "Airbnb / STR turnover"
    assert service_label("commercial") == "Commercial clean"


def test_service_label_unknown_falls_through_titlecased():
    assert service_label("power-wash") == "Power wash"


def test_service_label_missing_uses_generic():
    assert service_label(None) == "your cleaning"
    assert service_label("") == "your cleaning"


# ── phone parsing for tel: hrefs ───────────────────────────────────────────

def test_phone_tel_href_strips_formatting():
    assert _phone_tel_href("(207) 572-0502") == "2075720502"
    assert _phone_tel_href("+1 207-572-0502") == "+12075720502"


def test_phone_tel_href_rejects_short_input():
    assert _phone_tel_href(None) is None
    assert _phone_tel_href("") is None
    assert _phone_tel_href("911") is None      # emergency-only shortcode


# ── build_booking_confirmation_email ──────────────────────────────────────

BASE_ARGS = dict(
    customer_name="Megan Small",
    service_type="standard",
    requested_date="2026-07-15",
    address="102 Keystone Dr",
    company_name="The Maine Cleaning Co.",
    company_phone="+12075720502",
    company_email="office@mainecleaningco.com",
    company_website="https://maineclean.co",
    estimate_min=320.0,
    estimate_max=350.0,
)


def _build(**overrides):
    args = {**BASE_ARGS, **overrides}
    return build_booking_confirmation_email(**args)


def test_subject_uses_human_date_not_iso():
    subject, _, _ = _build()
    assert subject == "We got your booking request — Wed, Jul 15, 2026"
    assert "T22" not in subject
    assert "Z" not in subject      # no timestamp suffix leaked in


def test_subject_still_human_when_input_is_full_iso():
    """Regression against the customer-visible leak in the screenshot."""
    subject, _, _ = _build(requested_date="2026-07-07T22:18:23.208Z")
    assert "T22:18:23" not in subject
    assert "Tue, Jul 7, 2026" in subject


def test_html_greets_by_first_name_and_shows_summary():
    _, html, _ = _build()
    assert "Hi Megan," in html
    assert "Standard clean" in html
    assert "Wed, Jul 15, 2026" in html
    assert "102 Keystone Dr" in html
    # Estimate range renders when provided.
    assert "$320–$350" in html


def test_html_ctas_render_when_contact_info_present():
    _, html, _ = _build()
    assert 'href="tel:+12075720502"' in html
    assert 'href="sms:+12075720502"' in html
    assert 'href="mailto:office@mainecleaningco.com"' in html
    assert ">Call us<" in html
    assert ">Text us<" in html
    assert ">Reply by email<" in html


def test_html_omits_ctas_when_contact_info_missing():
    _, html, _ = _build(company_phone=None, company_email=None)
    assert "tel:" not in html
    assert "sms:" not in html
    assert "mailto:" not in html


def test_summary_row_hides_estimate_when_not_supplied():
    _, html, text = _build(estimate_min=None, estimate_max=None)
    # No estimate row header should render in the summary card.
    # Weak assertion — key is that no $-formatted range appears.
    assert "$" not in html.split('background:#f9fafb;border:1px solid #e5e7eb;')[1].split("</table>")[0]
    assert "Estimate:" not in text


def test_text_body_is_plaintext_and_ascii_safe():
    _, _, text = _build()
    # Must not contain any HTML markup — this is what non-HTML mail clients
    # (or plain-text-only forwarding rules) render.
    assert "<" not in text
    assert ">" not in text
    assert "Wed, Jul 15, 2026" in text
    assert "1. We review your request" in text


def test_html_input_is_escaped_against_injection():
    """A customer with `<script>` in their name / address should NOT get
    that HTML rendered. The old plain-text builder used html.escape too —
    keep the guarantee."""
    _, html, _ = _build(
        customer_name="<script>alert(1)</script> Bad",
        address="<b>evil</b>",
    )
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "<b>evil</b>" not in html
    assert "&lt;b&gt;evil&lt;/b&gt;" in html


def test_greeting_falls_back_to_generic_when_no_name():
    _, html, text = _build(customer_name="")
    assert "Hi there," in html
    assert "Hi there," in text
