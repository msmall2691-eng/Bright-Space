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


class QuoteEmailService:
    """Send quote emails with PDF attachments over the shared SMTP config"""

    def __init__(self):
        creds = _load_smtp_creds()
        self.smtp_user = creds["smtp_user"]
        self.smtp_pass = creds["smtp_pass"]
        self.smtp_host = creds["smtp_host"]
        self.smtp_port = creds["smtp_port"]
        self.from_email = creds["from_email"] or "quotes@bright-space.com"
        self.company_name = os.getenv("COMPANY_NAME") or creds["from_name"] or "Bright-Space"

        if not self.smtp_user or not self.smtp_pass:
            msg = ("Email credentials missing — set SMTP_USER + SMTP_PASS "
                   "(legacy GMAIL_EMAIL + GMAIL_PASSWORD also accepted), or save them "
                   "in BrightBase → Settings → Email.")
            logger.error(f"[quote-email] {msg}")
            raise ValueError(msg)

    def get_email_template(self) -> str:
        """Quote email HTML. Mirrors what the send panel promises: title,
        intro message, every line item, formatted totals, and an expiry line
        only when the quote actually has one (the old footer claimed "valid
        for 30 days" regardless — contradicting the Expires row)."""
        return """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1f2937 0%, #111827 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; font-weight: bold; }
        .header p { margin: 8px 0 0; color: #d1d5db; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
        .content h2 { color: #1f2937; }
        .quote-info { background: #f9fafb; padding: 16px; border-radius: 6px; margin: 20px 0; }
        .quote-info-row { display: flex; justify-content: space-between; margin: 8px 0; font-size: 14px; }
        .items { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
        .items th { text-align: left; color: #6b7280; font-size: 12px; text-transform: uppercase; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
        .items th.amt, .items td.amt { text-align: right; }
        .items td { padding: 8px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
        .items .desc { color: #6b7280; font-size: 12px; }
        .totals td { padding: 4px 0; border: none; }
        .totals .label { color: #6b7280; }
        .totals .grand { font-weight: bold; font-size: 16px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
        .cta-button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 20px 0; font-weight: 600; }
        .footer { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; text-align: center; font-size: 12px; color: #6b7280; }
        .divider { border-top: 1px solid #e5e7eb; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ company_name }}</h1>
            {% if quote_title %}<p>{{ quote_title }}</p>{% else %}<p>Quote {{ quote_number }}</p>{% endif %}
        </div>
        <div class="content">
            <h2>{{ greeting_line }}</h2>
            {% if intro_message %}<p style="white-space: pre-wrap;">{{ intro_message }}</p>
            {% else %}<p>We've prepared a quote for your request. Please review it below and let us know if you have any questions.</p>{% endif %}

            <div class="quote-info">
                <div class="quote-info-row">
                    <strong>Quote #:</strong>
                    <span>{{ quote_number }}</span>
                </div>
                {% if expires_at %}
                <div class="quote-info-row">
                    <strong>Valid until:</strong>
                    <span>{{ expires_at }}</span>
                </div>
                {% endif %}
            </div>

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
            <table class="items totals">
                <tr><td class="label">Total</td><td class="amt grand">${{ total_amount }}</td></tr>
            </table>

            <p>You can view, accept, or request changes to this quote online{% if pdf_attached %} — a PDF copy is also attached{% endif %}:</p>

            <a href="{{ quote_link }}" class="cta-button">View Quote Online</a>

            <div class="divider"></div>

            <p>If you have any questions about this quote, just reply to this email — we're here to help!</p>
        </div>
        <div class="footer">
            <p>&copy; {{ company_name }} - All rights reserved</p>
            {% if expires_at %}<p>This quote is valid until {{ expires_at }}.</p>{% endif %}
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
    ) -> dict:
        """Send a quote email with optional PDF attachment.

        expires_at: pre-formatted date string, or None when the quote has no
        valid-until (no expiry text is shown at all — never a made-up "30
        days"). subject/greeting are per-send overrides from the Send panel;
        intro_message is the personal note / stored customer message.
        """
        try:
            # Create message
            msg = MIMEMultipart('alternative')
            msg['Subject'] = (subject or "").strip() or f"Your Quote {quote_number} from {self.company_name}"
            msg['From'] = f"{self.company_name} <{self.from_email}>"
            msg['To'] = to_email

            # Greeting: explicit override > greet-able client name > neutral.
            name = (greeting or "").strip() or customer_display_name(client_name)
            greeting_line = f"Hello {name}," if name else "Hello,"

            line_items = [{
                "name": (it.get("name") or "").strip() or "Service",
                "description": (it.get("description") or "").strip(),
                "qty": ("%g" % float(it.get("qty") or 1)),
                "amount": format_money(float(it.get("qty") or 1) * float(it.get("unit_price") or 0)),
            } for it in (items or []) if isinstance(it, dict)]

            # Render HTML template
            template = Template(self.get_email_template())
            html_content = template.render(
                company_name=self.company_name,
                quote_number=quote_number,
                quote_title=(quote_title or "").strip() or None,
                greeting_line=greeting_line,
                intro_message=(intro_message or "").strip() or None,
                items=line_items,
                total_amount=format_money(total_amount),
                expires_at=(expires_at or "").strip() or None,
                quote_link=quote_link,
                pdf_attached=bool(pdf_bytes),
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
