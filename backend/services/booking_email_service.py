"""Customer-facing booking-confirmation email (rendered HTML + text bodies).

Before this the confirmation went out as `<div><br>`-joined plain text with
a raw ISO timestamp in the subject (`Booking request received —
2026-07-07T22:18:23.208Z`) and the same ISO in the body copy — the customer
saw an unformatted wall of text and a machine-readable date. This module
renders a real HTML template that:
  - drops the ISO from the subject and body (uses a human date instead),
  - matches the maineclean.co brand (`--brand` = the invoice-email blue so
    the two customer touchpoints look like they came from the same shop),
  - surfaces three tap-targets: Call / Text (`tel:`) and Reply (`mailto:`)
    so the customer can react with one tap,
  - links back to the marketing site + a "what happens next" mini-timeline
    so the customer knows to expect the calendar invite.

Kept as a service module so the /booking/submit router doesn't grow another
inline HTML blob. Same pattern as `services/dunning_service.py`,
`services/reminder_service.py`.
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from html import escape as _esc
from typing import Optional


# --- date parsing -----------------------------------------------------------

def _parse_requested_date(raw: str | None) -> datetime | None:
    """Accept both the YYYY-MM-DD date the booking form sends and the ISO
    timestamp we've seen leak through (`2026-07-07T22:18:23.208Z`). Never
    raises — returns None if we can't recognize the shape, and the caller
    falls back to rendering the raw string so a genuinely-weird value still
    appears in the receipt."""
    if not raw:
        return None
    s = str(raw).strip()
    # Try YYYY-MM-DD first — the common case.
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        pass
    # Full ISO with time (with or without `Z`). fromisoformat handles most.
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def format_requested_date(raw: str | None) -> str:
    """Render a booking date as 'Wed, Jul 15, 2026' — the receipt's single
    biggest quality-of-life win."""
    d = _parse_requested_date(raw)
    if not d:
        return str(raw or "your requested date")
    return d.strftime("%a, %b %-d, %Y")


# --- copy helpers -----------------------------------------------------------

_SERVICE_LABELS = {
    "standard": "Standard clean",
    "deep": "Deep clean",
    "residential": "Residential clean",
    "residential-cleaning": "Residential clean",
    "str": "Airbnb / STR turnover",
    "str-turnover": "Airbnb / STR turnover",
    "airbnb-turnover": "Airbnb / STR turnover",
    "vrbo-turnover": "Airbnb / STR turnover",
    "vacation-rental": "Airbnb / STR turnover",
    "commercial": "Commercial clean",
    "commercial-cleaning": "Commercial clean",
    "move-in-out": "Move-in / Move-out clean",
    "deep-cleaning": "Deep clean",
}


def service_label(raw: str | None) -> str:
    if not raw:
        return "your cleaning"
    key = str(raw).strip().lower()
    return _SERVICE_LABELS.get(key, key.replace("-", " ").capitalize())


def _phone_tel_href(phone: str | None) -> str | None:
    """Strip a phone to digits + optional leading `+` so `tel:` links work
    regardless of how the customer formatted their number on the booking
    form. Returns None when the phone doesn't have enough digits to be a
    real number (fewer than 7 — an SMS shortcode floor)."""
    if not phone:
        return None
    stripped = re.sub(r"[^\d+]", "", str(phone))
    digits = re.sub(r"\D", "", stripped)
    if len(digits) < 7:
        return None
    return stripped if stripped.startswith("+") else digits


# --- email builder ----------------------------------------------------------

def build_booking_confirmation_email(
    *,
    customer_name: str,
    service_type: str | None,
    requested_date: str | None,
    address: str | None,
    company_name: str,
    company_phone: str | None,
    company_email: str | None,
    company_website: str = "https://maineclean.co",
    estimate_min: Optional[float] = None,
    estimate_max: Optional[float] = None,
) -> tuple[str, str, str]:
    """Return `(subject, html_body, text_body)` for the customer-facing
    booking-request receipt."""
    friendly_date = format_requested_date(requested_date)
    first = (customer_name or "").strip().split(" ")[0] or "there"
    svc = service_label(service_type)
    est_line = ""
    if estimate_min is not None and estimate_max is not None:
        est_line = f"${int(estimate_min)}–${int(estimate_max)}"

    subject = f"We got your booking request — {friendly_date}"

    tel_href = _phone_tel_href(company_phone)
    sms_href = tel_href  # Same href; iOS mail lets long-press → Send SMS.
    mailto_href = f"mailto:{company_email}" if company_email else None

    def _cta(href: str | None, label: str, primary: bool = False) -> str:
        if not href:
            return ""
        bg = "#1d4ed8" if primary else "#ffffff"
        color = "#ffffff" if primary else "#1d4ed8"
        border = "#1d4ed8"
        return (
            f'<a href="{_esc(href)}" '
            f'style="display:inline-block;background:{bg};color:{color};'
            f'text-decoration:none;font-weight:600;font-size:14px;'
            f'padding:11px 20px;border-radius:8px;border:1px solid {border};'
            f'margin:4px 6px 4px 0;">{_esc(label)}</a>'
        )

    ctas_html = "".join([
        _cta(tel_href and f"tel:{tel_href}", "Call us", primary=True),
        _cta(sms_href and f"sms:{sms_href}", "Text us"),
        _cta(mailto_href, "Reply by email"),
    ])

    summary_rows = ""
    for label, value in [
        ("Service", svc),
        ("Requested date", friendly_date),
        ("Service address", address),
        ("Estimate", est_line or None),
    ]:
        if not value:
            continue
        summary_rows += (
            '<tr>'
            f'<td style="padding:8px 0;color:#6b7280;font-size:13px;width:150px;vertical-align:top;">{_esc(label)}</td>'
            f'<td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;">{_esc(str(value))}</td>'
            '</tr>'
        )

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;color:#111827;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
    <!-- Header -->
    <div style="background:#1d4ed8;padding:28px 32px;">
      <div style="color:rgba(255,255,255,0.75);font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Booking request received</div>
      <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">{_esc(friendly_date)}</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="font-size:16px;line-height:1.55;margin:0 0 14px;">Hi {_esc(first)},</p>
      <p style="font-size:15px;line-height:1.55;color:#374151;margin:0 0 22px;">
        Thanks for booking with <strong>{_esc(company_name)}</strong>! We got your request and we'll review it shortly.
      </p>

      <!-- Summary card -->
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:6px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          {summary_rows}
        </table>
      </div>

      <!-- What happens next -->
      <div style="margin-bottom:24px;">
        <div style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">What happens next</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5;color:#374151;">
          <tr>
            <td style="padding:6px 12px 6px 0;width:26px;vertical-align:top;">
              <div style="width:22px;height:22px;border-radius:11px;background:#dbeafe;color:#1d4ed8;font-weight:700;font-size:12px;text-align:center;line-height:22px;">1</div>
            </td>
            <td style="padding:6px 0;vertical-align:top;">We review your request and confirm by call or text within <strong>1 business day</strong>.</td>
          </tr>
          <tr>
            <td style="padding:6px 12px 6px 0;vertical-align:top;">
              <div style="width:22px;height:22px;border-radius:11px;background:#dbeafe;color:#1d4ed8;font-weight:700;font-size:12px;text-align:center;line-height:22px;">2</div>
            </td>
            <td style="padding:6px 0;vertical-align:top;">Once confirmed, you'll get a Google Calendar invite — the cleaning drops onto your phone automatically, no app to install.</td>
          </tr>
          <tr>
            <td style="padding:6px 12px 6px 0;vertical-align:top;">
              <div style="width:22px;height:22px;border-radius:11px;background:#dbeafe;color:#1d4ed8;font-weight:700;font-size:12px;text-align:center;line-height:22px;">3</div>
            </td>
            <td style="padding:6px 0;vertical-align:top;">On the day, our crew arrives at the scheduled time. That's it.</td>
          </tr>
        </table>
      </div>

      {'<div style="margin-bottom:8px;">' + ctas_html + '</div>' if ctas_html else ''}
      <p style="font-size:13px;color:#6b7280;margin:14px 0 0;line-height:1.55;">
        Questions in the meantime? Just reply to this email — it goes straight to our office.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center;color:#9ca3af;font-size:12px;">
      <a href="{_esc(company_website)}" style="color:#6b7280;text-decoration:none;font-weight:600;">{_esc(company_name)}</a>
      · Southern Maine
      { f'· <a href="tel:{_esc(tel_href)}" style="color:#6b7280;text-decoration:none;">{_esc(company_phone)}</a>' if tel_href and company_phone else '' }
    </div>
  </div>
</body>
</html>"""

    # Plain-text fallback — mirrors the same summary + timeline. Never
    # includes an ISO timestamp, always uses `friendly_date`.
    text_lines = [
        f"Hi {first},",
        "",
        f"Thanks for booking with {company_name}! We got your request and we'll review it shortly.",
        "",
        f"Requested date: {friendly_date}",
        f"Service: {svc}",
    ]
    if address:
        text_lines.append(f"Service address: {address}")
    if est_line:
        text_lines.append(f"Estimate: {est_line}")
    text_lines.extend([
        "",
        "What happens next:",
        "  1. We review your request and confirm by call or text within 1 business day.",
        "  2. Once confirmed, you'll get a Google Calendar invite so the cleaning drops onto your phone automatically.",
        "  3. On the day, our crew arrives at the scheduled time.",
        "",
        "Questions? Just reply to this email — it goes straight to our office.",
    ])
    if company_phone:
        text_lines.append(f"Call or text: {company_phone}")
    text_lines.append(f"— {company_name}")

    return subject, html, "\n".join(text_lines)
