"""
Quote Email Service
Sends quotes via Gmail SMTP with delivery tracking
"""

import os
import smtplib
import uuid
from typing import Optional
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from jinja2 import Template


class QuoteEmailService:
    """Send quote emails with PDF attachments using Gmail SMTP"""

    def __init__(self):
        self.gmail_email = os.getenv("GMAIL_EMAIL")
        self.gmail_password = os.getenv("GMAIL_PASSWORD")
        self.from_email = os.getenv("RESEND_FROM_EMAIL", self.gmail_email or "quotes@bright-space.com")
        self.company_name = os.getenv("COMPANY_NAME", "Bright-Space")

        if not self.gmail_email or not self.gmail_password:
            raise ValueError("GMAIL_EMAIL and GMAIL_PASSWORD environment variables are required")

    def get_email_template(self) -> str:
        """Return the quote email HTML template"""
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
        .cta-button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 20px 0; font-weight: 600; }
        .footer { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; text-align: center; font-size: 12px; color: #6b7280; }
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
                    <strong>Quote #:</strong>
                    <span>{{ quote_number }}</span>
                </div>
                <div class="quote-info-row">
                    <strong>Total Amount:</strong>
                    <span>${{ total_amount }}</span>
                </div>
                <div class="quote-info-row">
                    <strong>Expires:</strong>
                    <span>{{ expires_at }}</span>
                </div>
            </div>

            <p>Please review the quote document attached and let us know if you'd like to proceed. You can also view and accept the quote online:</p>

            <a href="{{ quote_link }}" class="cta-button">View Quote Online</a>

            <div class="divider"></div>

            <p>If you have any questions about this quote, please don't hesitate to reach out. We're here to help!</p>
        </div>
        <div class="footer">
            <p>&copy; {{ company_name }} - All rights reserved</p>
            <p>This quote is valid for 30 days from the date above.</p>
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
        total_amount: str,
        expires_at: str,
        quote_link: str,
        pdf_bytes: Optional[bytes] = None,
        pdf_filename: str = "quote.pdf",
    ) -> dict:
        """Send a quote email with optional PDF attachment"""
        try:
            # Create message
            msg = MIMEMultipart('alternative')
            msg['Subject'] = f"Your Quote {quote_number} from {self.company_name}"
            msg['From'] = self.gmail_email
            msg['To'] = to_email

            # Render HTML template
            template = Template(self.get_email_template())
            html_content = template.render(
                company_name=self.company_name,
                client_name=client_name,
                quote_number=quote_number,
                total_amount=total_amount,
                expires_at=expires_at,
                quote_link=quote_link,
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

            # Send via Gmail SMTP
            with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
                server.login(self.gmail_email, self.gmail_password)
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
