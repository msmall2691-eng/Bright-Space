"""
Quote Email Service
Sends quotes via Resend with delivery tracking
"""

import os
from typing import Optional
from datetime import datetime
from resend import Resend
from jinja2 import Template


class QuoteEmailService:
    """Send quote emails with delivery tracking"""

    def __init__(self):
        self.resend = Resend(api_key=os.getenv("RESEND_API_KEY"))
        self.from_email = os.getenv("RESEND_FROM_EMAIL", "quotes@bright-space.com")
        self.company_name = os.getenv("COMPANY_NAME", "Bright-Space")

    def get_email_template(self) -> str:
        """Return the quote email HTML template"""
        return """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #374151; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1f2937 0%, #111827 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; font-weight: bold; }
        .header p { margin: 8px 0 0 0; color: #d1d5db; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; }
        .content h2 { color: #1f2937; margin: 0 0 16px 0; font-size: 20px; }
        .quote-info { background: #f9fafb; padding: 16px; border-radius: 6px; margin: 20px 0; }
        .quote-info-row { display: flex; justify-content: space-between; margin: 8px 0; font-size: 14px; }
        .quote-info-row strong { color: #1f2937; }
        .quote-info-row span { color: #6b7280; }
        .cta-button { display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 24px 0; text-align: center; }
        .cta-button:hover { background: #1d4ed8; }
        .footer { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; font-size: 12px; color: #6b7280; text-align: center; }
        .divider { border-top: 1px solid #e5e7eb; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{{ company_name }}</h1>
            <p>Quote for {{ client_name }}</p>
        </div>

        <div class="content">
            <h2>Hello {{ client_name }},</h2>

            <p>We've prepared a quote for your request. Please review the attached PDF and let us know if you have any questions.</p>

            <div class="quote-info">
                <div class="quote-info-row">
                    <strong>Quote Number:</strong>
                    <span>{{ quote_number }}</span>
                </div>
                <div class="quote-info-row">
                    <strong>Total Amount:</strong>
                    <span>${{ total_amount }}</span>
                </div>
                <div class="quote-info-row">
                    <strong>Valid Until:</strong>
                    <span>{{ expires_at }}</span>
                </div>
            </div>

            <p style="text-align: center;">
                <a href="{{ quote_link }}" class="cta-button">Review Quote</a>
            </p>

            <div class="divider"></div>

            <p style="margin-top: 20px; font-size: 14px;">
                <strong>Next Steps:</strong><br>
                1. Review the attached quote PDF<br>
                2. Reply to this email or call us with any questions<br>
                3. When ready, click "Accept" in your client portal to proceed
            </p>

            <p style="margin-top: 20px; font-size: 14px;">
                Questions? Don't hesitate to reach out to us at <strong>{{ company_email }}</strong>
            </p>
        </div>

        <div class="footer">
            <p style="margin: 0;">© {{ current_year }} {{ company_name }}. All rights reserved.</p>
            <p style="margin: 8px 0 0 0;">This quote is valid until the expiration date.</p>
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
        total_amount: float,
        expires_at: str,
        quote_link: str,
        pdf_bytes: Optional[bytes] = None,
        pdf_filename: str = "quote.pdf",
    ) -> dict:
        """
        Send quote email with PDF attachment

        Args:
            to_email: Recipient email
            client_name: Client name
            quote_number: Quote number (e.g., "QT-2026-0001")
            total_amount: Quote total amount
            expires_at: Expiration date string
            quote_link: Link to quote in portal
            pdf_bytes: PDF file as bytes (optional)
            pdf_filename: Filename for PDF attachment

        Returns:
            Response dict with status and email ID
        """

        try:
            # Render template
            template = Template(self.get_email_template())
            html_content = template.render(
                company_name=self.company_name,
                company_email=self.from_email,
                client_name=client_name,
                quote_number=quote_number,
                total_amount=f"{total_amount:.2f}",
                expires_at=expires_at,
                quote_link=quote_link,
                current_year=datetime.now().year,
            )

            # Prepare attachments
            attachments = []
            if pdf_bytes:
                import base64
                attachments.append({
                    "filename": pdf_filename,
                    "content": base64.b64encode(pdf_bytes).decode("utf-8"),
                    "content_type": "application/pdf",
                })

            # Send email
            email_response = self.resend.emails.send({
                "from": self.from_email,
                "to": to_email,
                "subject": f"Your Quote {quote_number} from {self.company_name}",
                "html": html_content,
                "attachments": attachments if attachments else None,
            })

            return {
                "success": True,
                "email_id": email_response.get("id"),
                "sent_at": datetime.utcnow().isoformat(),
                "recipient": to_email,
                "status": "sent",
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "sent_at": datetime.utcnow().isoformat(),
                "recipient": to_email,
                "status": "failed",
            }

    def send_quote_to_multiple(
        self,
        recipients: list[str],
        client_name: str,
        quote_number: str,
        total_amount: float,
        expires_at: str,
        quote_link: str,
        pdf_bytes: Optional[bytes] = None,
    ) -> list[dict]:
        """
        Send quote email to multiple recipients

        Args:
            recipients: List of email addresses
            client_name: Client name
            quote_number: Quote number
            total_amount: Quote total amount
            expires_at: Expiration date string
            quote_link: Link to quote
            pdf_bytes: PDF file as bytes (optional)

        Returns:
            List of response dicts, one per recipient
        """

        results = []
        for email in recipients:
            result = self.send_quote_email(
                to_email=email,
                client_name=client_name,
                quote_number=quote_number,
                total_amount=total_amount,
                expires_at=expires_at,
                quote_link=quote_link,
                pdf_bytes=pdf_bytes,
            )
            results.append(result)

        return results
