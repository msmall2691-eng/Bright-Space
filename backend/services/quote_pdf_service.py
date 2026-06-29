"""
Quote PDF Generation Service
Generates professional PDF quotes using ReportLab
"""

from io import BytesIO
from datetime import datetime
from decimal import Decimal
from typing import Optional

from utils.dates import coerce_date
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT, TA_LEFT, TA_CENTER


class QuotePDFService:
    """Generate professional PDF quotes"""

    def __init__(self, company_name: str = "Bright-Space", company_email: Optional[str] = None,
                 company_phone: Optional[str] = None, brand_color: str = "#1f2937",
                 terms: Optional[str] = None, logo_url: Optional[str] = None):
        from config import DEFAULT_FROM_EMAIL
        company_email = company_email or DEFAULT_FROM_EMAIL
        self.company_name = company_name
        self.company_email = company_email
        self.company_phone = company_phone
        self.logo_url = logo_url
        # Guard the only consumer that RAISES on a bad color (CSS surfaces
        # just render nothing): a legacy/hand-edited setting must never make
        # PDF generation — and therefore quote sends — fail.
        try:
            colors.HexColor(brand_color or "#1f2937")
            self.brand_color = brand_color or "#1f2937"
        except Exception:
            self.brand_color = "#1f2937"
        self.terms = terms

    def generate_quote_pdf(
        self,
        quote_number: str,
        client_name: str,
        client_email: str,
        client_phone: Optional[str],
        line_items: list,
        subtotal: Decimal,
        tax_amount: Decimal,
        discount_amount: Decimal,
        total_amount: Decimal,
        notes: Optional[str] = None,
        expires_at: Optional[datetime] = None,
        quote_title: Optional[str] = None,
        property_photo_url: Optional[str] = None,
    ) -> bytes:
        """
        Generate a professional quote PDF

        Args:
            quote_number: Quote number (e.g., "QT-2026-0001")
            client_name: Client name
            client_email: Client email
            client_phone: Client phone (optional)
            line_items: List of dicts with {description, quantity, unit, unit_price, line_total}
            subtotal: Quote subtotal
            tax_amount: Tax amount
            discount_amount: Discount amount
            total_amount: Total amount
            notes: Additional notes
            expires_at: Quote expiration date

        Returns:
            PDF as bytes
        """

        # Prod schema drift can hand us a str (or even a human-formatted
        # string) instead of a date; coerce once so both .strftime() sites
        # below are safe and an unparseable value just hides the Expires row
        # rather than 500-ing the whole quote send.
        expires_at = coerce_date(expires_at)

        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.5*inch, bottomMargin=0.5*inch)

        styles = getSampleStyleSheet()
        story = []

        # Header with company branding
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.HexColor(self.brand_color),
            spaceAfter=6,
            fontName='Helvetica-Bold'
        )

        subtitle_style = ParagraphStyle(
            'Subtitle',
            parent=styles['Normal'],
            fontSize=10,
            textColor=colors.HexColor('#6b7280'),
            spaceAfter=20
        )

        # Logo at the top when configured — the strongest "real business"
        # signal. Best-effort: a fetch/decode failure must never break the PDF
        # (and therefore quote sending), so we silently fall back to the name.
        logo_flowable = self._logo_flowable()
        if logo_flowable is not None:
            story.append(logo_flowable)
            story.append(Spacer(1, 0.12 * inch))
        story.append(Paragraph(self.company_name, title_style))
        if quote_title:
            quote_title_style = ParagraphStyle(
                'QuoteTitle', parent=styles['Heading2'], fontSize=14,
                textColor=colors.HexColor('#374151'), spaceAfter=4,
            )
            story.append(Paragraph(quote_title, quote_title_style))
        contact_bits = " · ".join(b for b in (self.company_email, self.company_phone) if b)
        story.append(Paragraph(contact_bits, subtitle_style))

        # Front-of-house photo (Street View) when available. Best-effort: a
        # broken/missing image just doesn't render — never breaks the PDF.
        photo_flowable = self._photo_flowable(property_photo_url)
        if photo_flowable is not None:
            story.append(Spacer(1, 0.1 * inch))
            story.append(photo_flowable)
            story.append(Spacer(1, 0.05 * inch))

        # Quote header info. No internal "Status: DRAFT/ACTIVE" row — that's an
        # internal state the customer should never see on their quote.
        quote_header_data = [
            ['QUOTE', f'Quote #{quote_number}'],
            ['Date', datetime.now().strftime('%B %d, %Y')],
        ]
        if expires_at:
            quote_header_data.append(['Valid until', expires_at.strftime('%B %d, %Y')])

        quote_header_table = Table(quote_header_data, colWidths=[1.5*inch, 4*inch])
        quote_header_table.setStyle(TableStyle([
            ('FONT', (0, 0), (0, -1), 'Helvetica-Bold', 10),
            ('FONT', (1, 0), (1, -1), 'Helvetica', 10),
            ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (1, 0), (1, -1), colors.HexColor('#6b7280')),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
        ]))
        story.append(quote_header_table)
        story.append(Spacer(1, 0.3*inch))

        # Client info
        client_data = [
            ['BILL TO', 'CONTACT'],
            [client_name, client_email],
        ]
        if client_phone:
            client_data.append(['', client_phone])

        client_table = Table(client_data, colWidths=[2.5*inch, 4*inch])
        client_table.setStyle(TableStyle([
            ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 10),
            ('FONT', (0, 1), (-1, -1), 'Helvetica', 9),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (0, 1), (-1, -1), colors.HexColor('#6b7280')),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, 0), 1, colors.HexColor('#1f2937')),
        ]))
        story.append(client_table)
        story.append(Spacer(1, 0.3*inch))

        # Line items table
        line_items_data = [['Description', 'Qty', 'Unit', 'Unit Price', 'Total']]
        for item in line_items:
            line_items_data.append([
                item.get('description', ''),
                str(item.get('quantity', 1)),
                item.get('unit', ''),
                f"${item.get('unit_price', 0):.2f}",
                f"${item.get('line_total', 0):.2f}",
            ])

        line_items_table = Table(
            line_items_data,
            colWidths=[2.5*inch, 0.75*inch, 0.75*inch, 1.25*inch, 1.25*inch]
        )
        line_items_table.setStyle(TableStyle([
            ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 10),
            ('FONT', (0, 1), (-1, -1), 'Helvetica', 9),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (0, 1), (-1, -1), colors.HexColor('#374151')),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
            ('ALIGN', (0, 0), (0, -1), 'LEFT'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
        ]))
        story.append(line_items_table)
        story.append(Spacer(1, 0.2*inch))

        # Totals section. Only show Tax / Discount when non-zero so a simple
        # quote isn't cluttered with $0.00 rows.
        totals_data = [['', 'Subtotal', f"${subtotal:.2f}"]]
        if tax_amount:
            totals_data.append(['', 'Tax', f"${tax_amount:.2f}"])
        if discount_amount:
            totals_data.append(['', 'Discount', f"-${discount_amount:.2f}"])
        totals_data.append(['', 'TOTAL', f"${total_amount:.2f}"])
        total_row = len(totals_data) - 1  # TOTAL is always the last row

        totals_table = Table(totals_data, colWidths=[2.5*inch, 1.5*inch, 1.5*inch])
        totals_table.setStyle(TableStyle([
            ('FONT', (0, 0), (-1, total_row - 1), 'Helvetica', 9),
            ('FONT', (0, total_row), (-1, total_row), 'Helvetica-Bold', 12),
            ('TEXTCOLOR', (0, 0), (-1, total_row - 1), colors.HexColor('#6b7280')),
            ('TEXTCOLOR', (0, total_row), (-1, total_row), colors.HexColor('#1f2937')),
            ('ALIGN', (0, 0), (-1, -1), 'RIGHT'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('GRID', (0, total_row), (-1, total_row), 2, colors.HexColor('#1f2937')),
            ('BACKGROUND', (0, total_row), (-1, total_row), colors.HexColor('#f3f4f6')),
        ]))
        story.append(totals_table)
        story.append(Spacer(1, 0.3*inch))

        # Notes section
        if notes:
            notes_style = ParagraphStyle(
                'Notes',
                parent=styles['Normal'],
                fontSize=9,
                textColor=colors.HexColor('#6b7280'),
                spaceAfter=12
            )
            story.append(Paragraph(f"<b>Notes:</b> {notes}", notes_style))

        # Footer
        footer_style = ParagraphStyle(
            'Footer',
            parent=styles['Normal'],
            fontSize=8,
            textColor=colors.HexColor('#9ca3af'),
            alignment=TA_CENTER
        )
        story.append(Spacer(1, 0.2*inch))
        if self.terms:
            terms_style = ParagraphStyle(
                'Terms', parent=styles['Normal'], fontSize=8,
                textColor=colors.HexColor('#6b7280'),
            )
            story.append(Paragraph("<b>Terms &amp; Conditions</b>", terms_style))
            for line in self.terms.splitlines():
                if line.strip():
                    story.append(Paragraph(line.strip(), terms_style))
            story.append(Spacer(1, 0.15*inch))
        contact = " or call ".join(b for b in (f"email {self.company_email}" if self.company_email else None,
                                               self.company_phone) if b)
        # Validity is already shown once in the header ("Valid until …"); don't
        # repeat it here. Footer is just the contact prompt.
        story.append(Paragraph(f"Questions? {contact}".strip(), footer_style))

        # Build PDF
        doc.build(story)
        pdf_bytes = buffer.getvalue()
        buffer.close()

        return pdf_bytes

    def _logo_flowable(self):
        """Best-effort logo Image flowable from self.logo_url, or None.

        Fetches over HTTP with a short timeout and never raises — a broken or
        slow logo URL must not break quote PDF generation (and thus sending)."""
        if not self.logo_url:
            return None
        try:
            import urllib.request
            from reportlab.platypus import Image
            req = urllib.request.Request(self.logo_url, headers={"User-Agent": "BrightBase/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read()
            img = Image(BytesIO(data))
            # Scale to a max 1.6in height, preserving aspect ratio.
            max_h = 1.6 * inch
            if img.drawHeight > max_h:
                ratio = max_h / float(img.drawHeight)
                img.drawHeight = max_h
                img.drawWidth = img.drawWidth * ratio
            img.hAlign = 'LEFT'
            return img
        except Exception:
            return None

    def _photo_flowable(self, photo_url: Optional[str]):
        """Best-effort front-of-house photo, scaled to the page width, or None.

        Fetches over HTTP with a short timeout and never raises — no coverage
        (our proxy returns 404) or a slow URL simply skips the photo."""
        if not photo_url:
            return None
        try:
            import urllib.request
            from reportlab.platypus import Image
            req = urllib.request.Request(photo_url, headers={"User-Agent": "BrightBase/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read()
            img = Image(BytesIO(data))
            # Fit to ~6.5in content width, preserving aspect ratio.
            max_w = 6.5 * inch
            if img.drawWidth > max_w:
                ratio = max_w / float(img.drawWidth)
                img.drawWidth = max_w
                img.drawHeight = img.drawHeight * ratio
            img.hAlign = 'CENTER'
            return img
        except Exception:
            return None
