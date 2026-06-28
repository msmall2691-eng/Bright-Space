"""
Quote Email Service
Sends quotes via SMTP with delivery tracking.

Credentials come from the ONE canonical source the rest of the app uses —
integrations.email._load_smtp_creds() (Settings → Email in the DB, then
SMTP_USER/SMTP_PASS env, then legacy GMAIL_EMAIL/GMAIL_PASSWORD). This service
previously read GMAIL_* directly, so a Railway env with only SMTP_* configured
sent invoices fine but silently failed every quote.
"""

import logging
import os
import re
import smtplib
import uuid
from typing import Optional
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from jinja2 import Template

from integrations.email import _load_smtp_creds

logger = logging.getLogger(__name__)

# A "client name" that's really a phone number or intake placeholder must not
# end up in a greeting ("Hello +12074329492," — seen in prod June 11).
_PLACEHOLDER_NAME_RE = re.compile(
    r"^(unknown|webhook test|brightbase webhook test|test client|n/?a|\+?[\d\s().-]{7,})$",
    re.IGNORECASE,
)


def customer_display_name(name: str | None) -> str:
    """The name as greet-able text, or '' when it's a placeholder/phone."""
    name = (name or "").strip()
    if not name or _PLACEHOLDER_NAME_RE.match(name):
        return ""
    return name


def format_money(amount) -> str:
    """'183.00' / '1,234.50' — never Python float repr like '183.0'."""
    try:
        return f"{float(amount or 0):,.2f}"
    except (TypeError, ValueError):
        return "0.00"


def phone_tel_href(phone: str | None) -> str:
    """Digits-only (leading + kept) tel: target. Spaces/parens in a tel href
    don't dial reliably, so the href must be normalized even though the visible
    number stays formatted."""
    if not phone:
        return ""
    cleaned = re.sub(r"[^\d+]", "", phone)
    # Collapse any stray '+' to a single leading one.
    if cleaned.count("+") > 1 or (cleaned and "+" in cleaned[1:]):
        cleaned = ("+" if cleaned.startswith("+") else "") + cleaned.replace("+", "")
    return cleaned


def first_name_of(name: str | None) -> str:
    """First name for a friendly greeting, or '' for placeholder/phone names."""
    display = customer_display_name(name)
    return display.split()[0] if display else ""


class QuoteEmailService:
    """Send quote emails with PDF attachments over the shared SMTP config"""

    def __init__(self):
        creds = _load_smtp_creds()
        self.smtp_user = creds["smtp_user"]
        self.smtp_pass = creds["smtp_pass"]
        self.smtp_host = creds["smtp_host"]
        self.smtp_port = creds["smtp_port"]
        from config import DEFAULT_FROM_EMAIL
        self.from_email = creds["from_email"] or DEFAULT_FROM_EMAIL
        self.company_name = (self._db_setting("company_name") or os.getenv("COMPANY_NAME")
                             or creds["from_name"] or "Bright-Space")
        # Shared customer-facing identity (same Settings rows as the public
        # quote page, so all surfaces match).
        self.company_email = (self._db_setting("company_email") or os.getenv("COMPANY_EMAIL")
                              or self.from_email)
        self.company_phone = self._db_setting("company_phone") or os.getenv("COMPANY_PHONE")
        self.quote_terms = self._db_setting("quote_terms")
        self.brand_color = self._db_setting("brand_color") or "#1f2937"
        self.company_logo_url = self._db_setting("company_logo_url")

        if not self.smtp_user or not self.smtp_pass:
            msg = ("Email credentials missing — set SMTP_USER + SMTP_PASS "
                   "(legacy GMAIL_EMAIL + GMAIL_PASSWORD also accepted), or save them "
                   "in BrightBase → Settings → Email.")
            logger.error(f"[quote-email] {msg}")
            raise ValueError(msg)

    @staticmethod
    def _db_setting(key: str):
        """A Settings → General row (the same rows the public quote page
        uses). Best-effort: no DB, no problem — env/defaults win."""
        try:
            from database.db import SessionLocal
            from database.models import AppSetting
            db = SessionLocal()
            try:
                row = db.query(AppSetting).filter(AppSetting.key == key).first()
                return (row.value or "").strip() or None
            finally:
                db.close()
        except Exception:
            return None

    def get_email_template(self) -> str:
        """Quote email HTML. Table-based layout (no flexbox) so it renders
        consistently in Gmail, Apple Mail, and Outlook's Word engine. Shows the
        money breakdown (subtotal + tax/discount when non-zero + total), the
        service address, a brand-colored CTA, and a single 30-day validity line
        that always agrees with the date."""
        return """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f3f4f6; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .content { background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
        .content h2 { color: #1f2937; margin-top: 0; }
        .info-box { background: #f9fafb; border-radius: 6px; margin: 20px 0; }
        .items { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
        .items th { text-align: left; color: #6b7280; font-size: 12px; text-transform: uppercase; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
        .items th.amt, .items td.amt { text-align: right; }
        .items td { padding: 8px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
        .items .desc { color: #6b7280; font-size: 12px; }
        .totals td { padding: 4px 0; border: none; font-size: 14px; }
        .totals .label { color: #6b7280; }
        .totals .grand td { font-weight: bold; font-size: 16px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
        .footer { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; text-align: center; font-size: 12px; color: #6b7280; }
        .divider { border-top: 1px solid #e5e7eb; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header (table, not flex, for Outlook) -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: {{ brand_color }}; border-radius: 8px 8px 0 0;">
            <tr>
                <td style="padding: 20px; text-align: center;">
                    {% if company_logo_url %}<img src="{{ company_logo_url }}" alt="{{ company_name }}" height="48" style="max-height:48px; margin-bottom:8px; display:inline-block;"><br>{% endif %}
                    <span style="color: #ffffff; font-size: 28px; font-weight: bold;">{{ company_name }}</span>
                    <div style="color: #d1d5db; font-size: 14px; margin-top: 6px;">{% if quote_title %}{{ quote_title }}{% else %}Quote {{ quote_number }}{% endif %}</div>
                </td>
            </tr>
        </table>
        <div class="content">
            <h2>{{ greeting_line }}</h2>
            {% if intro_message %}<p style="white-space: pre-wrap;">{{ intro_message }}</p>
            {% else %}<p>We've prepared a quote for your request. Please review it below and let us know if you have any questions.</p>{% endif %}

            <!-- Quote info (table rows, not flex) -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="info-box">
                <tr><td style="padding: 12px 16px 4px;"><strong>Quote #:</strong></td><td style="padding: 12px 16px 4px; text-align: right;">{{ quote_number }}</td></tr>
                {% if expires_at %}<tr><td style="padding: 4px 16px;"><strong>Valid until:</strong></td><td style="padding: 4px 16px; text-align: right;">{{ expires_at }}</td></tr>{% endif %}
                {% if address %}<tr><td style="padding: 4px 16px 12px;"><strong>Service address:</strong></td><td style="padding: 4px 16px 12px; text-align: right;">{{ address }}</td></tr>{% endif %}
            </table>

            {% if items %}
            <table class="items">
                <tr><th>Service</th><th class="amt">Qty</th><th class="amt">Amount</th></tr>
                {% for it in items %}
                <tr>
                    <td>{{ it.name }}{% if it.description %}<div class="desc">{{ it.description }}</div>{% endif %}</td>
                    <td class="amt">{{ it.qty }}</td>
                    <td class="amt">${{ it.amount }}</td>
                </tr>
                {% endfor %}
            </table>
            {% endif %}
            <table class="items totals" role="presentation">
                <tr><td class="label">Subtotal</td><td class="amt">${{ subtotal }}</td></tr>
                {% if show_tax %}<tr><td class="label">Tax{% if tax_rate %} ({{ tax_rate }}%){% endif %}</td><td class="amt">${{ tax }}</td></tr>{% endif %}
                {% if show_discount %}<tr><td class="label">Discount</td><td class="amt">-${{ discount }}</td></tr>{% endif %}
                <tr class="grand"><td>Total</td><td class="amt">${{ total_amount }}</td></tr>
            </table>

            <p>You can view, accept, or request changes to this quote online{% if pdf_attached %} — a PDF copy is also attached{% endif %}:</p>

            <!-- Brand-colored CTA (table cell + bgcolor for Outlook) -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
                <tr><td bgcolor="{{ brand_color }}" style="border-radius: 6px;">
                    <a href="{{ quote_link }}" style="display: inline-block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-weight: 600;">View Quote Online</a>
                </td></tr>
            </table>

            <div class="divider"></div>

            <p>If you have any questions about this quote, just reply to this email — we're here to help!</p>
        </div>
        <div class="footer">
            {% if company_email or company_phone %}
            <p>Questions? {% if company_email %}Reply or email <a href="mailto:{{ company_email }}">{{ company_email }}</a>{% endif %}{% if company_phone %}{% if company_email %} · {% endif %}call <a href="tel:{{ company_phone_href }}">{{ company_phone }}</a>{% endif %}</p>
            {% endif %}
            {% if expires_at %}<p>This quote is valid for 30 days from the date issued (through {{ expires_at }}).</p>{% endif %}
            {% if terms %}<p style="text-align:left; white-space: pre-wrap;">{{ terms }}</p>{% endif %}
            <p>&copy; {{ company_name }} - All rights reserved</p>
        </div>
    </div>
</body>
</html>
        """

    def send_quote_email(
        self,
        to_email: str,
        client_name: str,
        quote_number: str,
        total_amount,
        expires_at: Optional[str],
        quote_link: str,
        pdf_bytes: Optional[bytes] = None,
        pdf_filename: str = "quote.pdf",
        subject: Optional[str] = None,
        greeting: Optional[str] = None,
        intro_message: Optional[str] = None,
        quote_title: Optional[str] = None,
        items: Optional[list] = None,
        subtotal=None,
        tax=None,
        discount=None,
        tax_rate=None,
        address: Optional[str] = None,
        bcc: Optional[str] = None,
    ) -> dict:
        """Send a quote email with optional PDF attachment.

        expires_at: pre-formatted date string, or None when the quote has no
        valid-until (no expiry text is shown at all — never a made-up "30
        days"). subject/greeting are per-send overrides from the Send panel;
        intro_message is the personal note / stored customer message.

        bcc: optional owner copy address(es) — the business owner gets a blind
        copy of exactly what the customer received. Invalid/blank values are
        ignored rather than failing the send.
        """
        try:
            # Create message
            msg = MIMEMultipart('alternative')
            # Subject includes the price — quotes with the amount get opened
            # more — unless an explicit override is supplied.
            default_subject = (f"Your ${format_money(total_amount)} quote from "
                               f"{self.company_name} ({quote_number})")
            msg['Subject'] = (subject or "").strip() or default_subject
            msg['From'] = f"{self.company_name} <{self.from_email}>"
            msg['To'] = to_email
            # Owner copy: a Bcc so the customer never sees the internal address.
            # smtplib.send_message() adds Bcc recipients to the envelope and
            # strips the header before transmission, so it stays blind. Only set
            # it when it's a real, distinct address.
            bcc_addr = (bcc or "").strip()
            if bcc_addr and "@" in bcc_addr and bcc_addr.lower() != to_email.strip().lower():
                msg['Bcc'] = bcc_addr

            # Greeting: explicit override > friendly first name > greet-able
            # full name > neutral. "Hi Megan," reads better than the full name.
            override = (greeting or "").strip()
            first = first_name_of(client_name)
            if override:
                greeting_line = f"Hello {override},"
            elif first:
                greeting_line = f"Hi {first},"
            else:
                greeting_line = "Hello,"

            def _qty(it):
                """Default only when MISSING — an explicit 0 stays 0, matching
                _compute_totals (the email used to bill qty-0 items as 1)."""
                raw = it.get("qty")
                if raw is None or raw == "":
                    return 1.0
                try:
                    return float(raw)
                except (TypeError, ValueError):
                    return 1.0

            line_items = [{
                "name": (it.get("name") or "").strip() or "Service",
                "description": (it.get("description") or "").strip(),
                "qty": ("%g" % _qty(it)),
                "amount": format_money(_qty(it) * float(it.get("unit_price") or 0)),
            } for it in (items or []) if isinstance(it, dict)]

            # Money breakdown: subtotal always; tax/discount only when non-zero.
            tax_val = float(tax or 0)
            discount_val = float(discount or 0)
            subtotal_val = subtotal if subtotal is not None else total_amount
            rate = float(tax_rate or 0)

            # Render HTML template
            template = Template(self.get_email_template())
            html_content = template.render(
                company_name=self.company_name,
                company_logo_url=self.company_logo_url,
                quote_number=quote_number,
                quote_title=(quote_title or "").strip() or None,
                greeting_line=greeting_line,
                intro_message=(intro_message or "").strip() or None,
                items=line_items,
                subtotal=format_money(subtotal_val),
                tax=format_money(tax_val),
                discount=format_money(discount_val),
                tax_rate=("%g" % rate) if rate else None,
                show_tax=bool(tax_val),
                show_discount=bool(discount_val),
                total_amount=format_money(total_amount),
                expires_at=(expires_at or "").strip() or None,
                address=(address or "").strip() or None,
                quote_link=quote_link,
                pdf_attached=bool(pdf_bytes),
                brand_color=self.brand_color,
                company_email=self.company_email,
                company_phone=self.company_phone,
                company_phone_href=phone_tel_href(self.company_phone),
                terms=self.quote_terms,
            )

            # Attach HTML content
            html_part = MIMEText(html_content, 'html')
            msg.attach(html_part)

            # Attach PDF if provided
            if pdf_bytes:
                pdf_part = MIMEBase('application', 'octet-stream')
                pdf_part.set_payload(pdf_bytes)
                encoders.encode_base64(pdf_part)
                pdf_part.add_header('Content-Disposition', f'attachment; filename= {pdf_filename}')
                msg.attach(pdf_part)

            # Send over the shared SMTP config (STARTTLS, like send_email()).
            # timeout is REQUIRED: without it a slow/blocked SMTP socket hangs
            # the whole web request until Railway's gateway times out
            # (~30-60s) and returns a 502. With a timeout the call fails fast
            # and is caught below, so the endpoint returns a clean result.
            with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=20) as server:
                server.ehlo()
                server.starttls()
                server.login(self.smtp_user, self.smtp_pass)
                server.send_message(msg)

            # Generate email ID for tracking
            email_id = str(uuid.uuid4())

            return {
                "success": True,
                "email_id": email_id,
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "to_email": to_email,
                "quote_number": quote_number,
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "email_id": None,
            }

    def send_quote_to_multiple(
        self,
        recipients: list[dict],
        quote_number: str,
        total_amount: str,
        expires_at: str,
        quote_link: str,
        pdf_bytes: Optional[bytes] = None,
    ) -> list[dict]:
        """Send quote emails to multiple recipients"""
        results = []
        for recipient in recipients:
            result = self.send_quote_email(
                to_email=recipient['email'],
                client_name=recipient['name'],
                quote_number=quote_number,
                total_amount=total_amount,
                expires_at=expires_at,
                quote_link=quote_link,
                pdf_bytes=pdf_bytes,
            )
            results.append(result)
        return results
