"""
Email sending via SMTP (Gmail or any SMTP provider).

Required env vars:
  SMTP_USER     — Gmail address (e.g. hello@maineclean.co)
  SMTP_PASS     — Gmail App Password (not your regular password)
  SMTP_HOST     — default smtp.gmail.com
  SMTP_PORT     — default 587
  FROM_NAME     — display name, default "Maine Cleaning Co"
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def send_email(to: str, subject: str, html_body: str, text_body: str = "") -> dict:
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    from_name = os.getenv("FROM_NAME", "Maine Cleaning Co")
    from_email = os.getenv("FROM_EMAIL", smtp_user)

    if not smtp_user or not smtp_pass:
        raise ValueError("SMTP_USER and SMTP_PASS are not configured in .env")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = to

    if text_body:
        msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.ehlo()
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(from_email, to, msg.as_string())

    return {"status": "sent", "to": to}


def build_quote_email(quote: dict, client_name: str, company_phone: str = "", public_url: str = "") -> tuple[str, str]:
    """Returns (html, plain_text) for a quote email."""
    q_num = quote.get("quote_number") or f"QT-{quote['id']}"
    items = quote.get("items") or []
    valid_until = quote.get("valid_until") or "30 days from issue"
    address = quote.get("address") or ""
    service_type = (quote.get("service_type") or "residential").title()
    notes = quote.get("notes") or ""
    from_email = os.getenv("SMTP_USER", "")
    from_name = os.getenv("FROM_NAME", "Maine Cleaning Co")

    rows = ""
    for item in items:
        qty = float(item.get("qty", 1))
        price = float(item.get("unit_price", 0))
        line_total = qty * price
        rows += f"""
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">
            <div style="font-weight:600;color:#111;">{item.get('name','')}</div>
            {f'<div style="font-size:12px;color:#6b7280;margin-top:2px;">{item["description"]}</div>' if item.get('description') else ''}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#4b5563;">{qty:.0f}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#4b5563;">${price:.2f}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#111;">${line_total:.2f}</td>
        </tr>"""

    tax_row = ""
    if quote.get("tax", 0) and float(quote.get("tax", 0)) > 0:
        tax_row = f"""
        <tr>
          <td colspan="3" style="padding:8px;text-align:right;color:#6b7280;font-size:14px;">Tax ({quote.get('tax_rate', 0)}%)</td>
          <td style="padding:8px;text-align:right;color:#6b7280;">${float(quote.get('tax', 0)):.2f}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:620px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#1d4ed8;padding:28px 32px;">
      <div style="color:#93c5fd;font-size:13px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Quote</div>
      <div style="color:#ffffff;font-size:26px;font-weight:700;">{q_num}</div>
      {f'<div style="color:#bfdbfe;font-size:14px;margin-top:6px;">{service_type} · {address}</div>' if address else f'<div style="color:#bfdbfe;font-size:14px;margin-top:6px;">{service_type}</div>'}
    </div>

    <!-- Client + validity -->
    <div style="padding:20px 32px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;background:#f9fafb;">
      <div>
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Prepared for</div>
        <div style="font-size:16px;font-weight:600;color:#111;margin-top:2px;">{client_name}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Valid until</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin-top:2px;">{valid_until}</div>
      </div>
    </div>

    <!-- Line items -->
    <div style="padding:24px 32px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Description</th>
            <th style="padding:8px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Qty</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Price</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Total</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>

      <!-- Totals -->
      <table style="width:100%;margin-top:8px;">
        <tr>
          <td colspan="3" style="padding:8px;text-align:right;color:#6b7280;font-size:14px;">Subtotal</td>
          <td style="padding:8px;text-align:right;color:#6b7280;">${float(quote.get('subtotal', 0)):.2f}</td>
        </tr>
        {tax_row}
        <tr style="background:#f0fdf4;border-radius:8px;">
          <td colspan="3" style="padding:12px 8px;text-align:right;font-size:18px;font-weight:700;color:#111;">Total</td>
          <td style="padding:12px 8px;text-align:right;font-size:20px;font-weight:700;color:#16a34a;">${float(quote.get('total', 0)):.2f}</td>
        </tr>
      </table>
    </div>

    {f'<div style="margin:0 32px 24px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #1d4ed8;"><div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Notes</div><div style="font-size:14px;color:#374151;">{notes}</div></div>' if notes else ''}

    <!-- CTA -->
    <div style="margin:0 32px 32px;padding:20px;background:#eff6ff;border-radius:10px;text-align:center;">
      <div style="font-size:15px;color:#1e40af;font-weight:600;margin-bottom:12px;">Ready to get started?</div>
      {f'<a href="{public_url}" style="display:inline-block;padding:12px 24px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;margin-bottom:12px;">Accept Quote</a>' if public_url else ''}
      <div style="font-size:14px;color:#3b82f6;margin-bottom:4px;">Reply to this email to ask any questions.</div>
      {f'<div style="font-size:14px;color:#3b82f6;">Or call/text us at {company_phone}</div>' if company_phone else ''}
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <div style="font-size:13px;color:#9ca3af;">{from_name} · {from_email}</div>
    </div>
  </div>
</body>
</html>"""

    # Plain text fallback
    item_lines = "\n".join(
        f"  {i.get('name','')} x{i.get('qty',1)} @ ${float(i.get('unit_price',0)):.2f} = ${float(i.get('qty',1))*float(i.get('unit_price',0)):.2f}"
        for i in items
    )
    plain = f"""{from_name}
Quote {q_num}

Hi {client_name},

Here is your quote for {service_type} cleaning{f' at {address}' if address else ''}.

{item_lines}

Subtotal: ${float(quote.get('subtotal',0)):.2f}
{f"Tax: ${float(quote.get('tax',0)):.2f}" if quote.get('tax') else ''}
TOTAL: ${float(quote.get('total',0)):.2f}

Valid until: {valid_until}

{f'Notes: {notes}' if notes else ''}

To accept this quote, click here: {public_url if public_url else 'Reply to this email'}
{f'You can also call or text us at {company_phone}.' if company_phone else ''}

Thank you,
{from_name}
"""
    return html, plain


def build_invoice_email(invoice: dict, client_name: str, company_phone: str = "") -> tuple[str, str]:
    """Returns (html, plain_text) for an invoice email."""
    inv_num = invoice.get("invoice_number") or f"INV-{invoice['id']}"
    items = invoice.get("items") or []
    due_date = invoice.get("due_date") or "Upon receipt"
    notes = invoice.get("notes") or ""
    status = invoice.get("status", "sent")
    from_email = os.getenv("SMTP_USER", "")
    from_name = os.getenv("FROM_NAME", "Maine Cleaning Co")

    rows = ""
    for item in items:
        qty = float(item.get("qty", 1))
        price = float(item.get("unit_price", 0))
        line_total = qty * price
        rows += f"""
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">
            <div style="font-weight:600;color:#111;">{item.get('name','')}</div>
            {f'<div style="font-size:12px;color:#6b7280;margin-top:2px;">{item["description"]}</div>' if item.get('description') else ''}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#4b5563;">{qty:.0f}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#4b5563;">${price:.2f}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#111;">${line_total:.2f}</td>
        </tr>"""

    tax_row = ""
    if invoice.get("tax", 0) and float(invoice.get("tax", 0)) > 0:
        tax_row = f"""
        <tr>
          <td colspan="3" style="padding:8px;text-align:right;color:#6b7280;font-size:14px;">Tax ({invoice.get('tax_rate', 0)}%)</td>
          <td style="padding:8px;text-align:right;color:#6b7280;">${float(invoice.get('tax', 0)):.2f}</td>
        </tr>"""

    header_color = "#dc2626" if status == "overdue" else "#1d4ed8"
    label = "OVERDUE INVOICE" if status == "overdue" else "Invoice"

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <div style="max-width:620px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:{header_color};padding:28px 32px;">
      <div style="color:rgba(255,255,255,0.7);font-size:13px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">{label}</div>
      <div style="color:#ffffff;font-size:26px;font-weight:700;">{inv_num}</div>
    </div>

    <!-- Client + due date -->
    <div style="padding:20px 32px;border-bottom:1px solid #e5e7eb;background:#f9fafb;">
      <div style="display:flex;justify-content:space-between;">
        <div>
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Billed to</div>
          <div style="font-size:16px;font-weight:600;color:#111;margin-top:2px;">{client_name}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Due by</div>
          <div style="font-size:15px;font-weight:600;color:{'#dc2626' if status == 'overdue' else '#111'};margin-top:2px;">{due_date}</div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <div style="padding:24px 32px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Description</th>
            <th style="padding:8px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Qty</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Price</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Total</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>

      <!-- Totals -->
      <table style="width:100%;margin-top:8px;">
        <tr>
          <td colspan="3" style="padding:8px;text-align:right;color:#6b7280;font-size:14px;">Subtotal</td>
          <td style="padding:8px;text-align:right;color:#6b7280;">${float(invoice.get('subtotal', 0)):.2f}</td>
        </tr>
        {tax_row}
        <tr style="background:#f0fdf4;border-radius:8px;">
          <td colspan="3" style="padding:12px 8px;text-align:right;font-size:18px;font-weight:700;color:#111;">Total Due</td>
          <td style="padding:12px 8px;text-align:right;font-size:20px;font-weight:700;color:#16a34a;">${float(invoice.get('total', 0)):.2f}</td>
        </tr>
      </table>
    </div>

    {f'<div style="margin:0 32px 24px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #1d4ed8;"><div style="font-size:12px;color:#6b7280;margin-bottom:4px;">Notes</div><div style="font-size:14px;color:#374151;">{notes}</div></div>' if notes else ''}

    <!-- CTA -->
    <div style="margin:0 32px 32px;padding:20px;background:#eff6ff;border-radius:10px;text-align:center;">
      <div style="font-size:15px;color:#1e40af;font-weight:600;margin-bottom:8px;">Payment due by {due_date}</div>
      <div style="font-size:14px;color:#3b82f6;margin-bottom:4px;">Reply to this email with any questions.</div>
      {f'<div style="font-size:14px;color:#3b82f6;">Or call/text us at {company_phone}</div>' if company_phone else ''}
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <div style="font-size:13px;color:#9ca3af;">{from_name} · {from_email}</div>
    </div>
  </div>
</body>
</html>"""

    item_lines = "\n".join(
        f"  {i.get('name','')} x{i.get('qty',1)} @ ${float(i.get('unit_price',0)):.2f} = ${float(i.get('qty',1))*float(i.get('unit_price',0)):.2f}"
        for i in items
    )
    plain = f"""{from_name}
{'OVERDUE ' if status == 'overdue' else ''}Invoice {inv_num}

Hi {client_name},

{'This invoice is overdue. ' if status == 'overdue' else ''}Please find your invoice details below.

{item_lines}

Subtotal: ${float(invoice.get('subtotal',0)):.2f}
{f"Tax: ${float(invoice.get('tax',0)):.2f}" if invoice.get('tax') else ''}
TOTAL DUE: ${float(invoice.get('total',0)):.2f}

Due by: {due_date}

{f'Notes: {notes}' if notes else ''}

Reply to this email with any questions.
{f'You can also call or text us at {company_phone}.' if company_phone else ''}

Thank you,
{from_name}
"""
    return html, plain


def build_invoice_sms(invoice: dict, client_name: str, company_phone: str = "") -> str:
    inv_num = invoice.get("invoice_number") or f"INV-{invoice['id']}"
    due_date = invoice.get("due_date") or "upon receipt"
    total = float(invoice.get("total", 0))
    status = invoice.get("status", "sent")
    from_name = os.getenv("FROM_NAME", "Maine Cleaning Co")

    prefix = "OVERDUE — " if status == "overdue" else ""
    lines = [
        f"{from_name} — {prefix}Invoice {inv_num}",
        f"Amount due: ${total:.2f}",
        f"Due by: {due_date}",
        "",
        "Reply to this message with any questions.",
    ]
    if company_phone:
        lines.append(f"Call/text: {company_phone}")
    return "\n".join(lines)


def build_quote_sms(quote: dict, client_name: str, company_phone: str = "", public_url: str = "") -> str:
    q_num = quote.get("quote_number") or f"QT-{quote['id']}"
    service_type = (quote.get("service_type") or "residential").title()
    address = quote.get("address") or ""
    total = float(quote.get("total", 0))
    valid_until = quote.get("valid_until") or ""
    from_name = os.getenv("FROM_NAME", "Maine Cleaning Co")

    lines = [
        f"{from_name} — Quote {q_num}",
        f"{service_type} clean{f' at {address}' if address else ''}",
        f"Total: ${total:.2f}",
    ]
    if valid_until:
        lines.append(f"Valid until: {valid_until}")
    lines.append("")
    if public_url:
        lines.append(f"Accept your quote: {public_url}")
    else:
        lines.append("Reply YES to accept or ask any questions.")
    if company_phone:
        lines.append(f"Call/text: {company_phone}")
    return "\n".join(lines)
