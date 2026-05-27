"""
Quote Email Service
Sends quotes via Gmail SMTP with delivery tracking
"""

import os
import smtplib
import uuid
from typing import Optional
from datetime import datetime
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
