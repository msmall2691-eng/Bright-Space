"""
Quote PDF Generation Service
Generates professional PDF quotes using ReportLab
"""

from io import BytesIO
from datetime import datetime
from decimal import Decimal
from typing import Optional
from xml.sax.saxutils import escape as _xml_escape, quoteattr


def _esc(text) -> str:
    """Escape user-controlled text for a ReportLab Paragraph, which parses its
    input as XML markup. Without this, an item name like 'Clean <b>' or pasted
    HTML raises a parse error and breaks PDF generation (and thus quote sends)."""
    return _xml_escape("" if text is None else str(text))


def _esc_ml(text) -> str:
    """Escape, then turn newlines into <br/> for multi-line Paragraph text."""
    return _esc(text).replace("\n", "<br/>")

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
        quote_link: Optional[str] = None,
        address: Optional[str] = None,
        service_type: Optional[str] = None,
        customer_message: Optional[str] = None,
    ) -> bytes:
        """Generate a professional quote PDF that mirrors the customer web view.

        The layout matches the public quote page (QuoteDocument): a brand-colored
        header band with the logo / company / title / validity, an "accept or
        request changes online" link (since a PDF can't have live buttons), the
        front-of-house photo, a service-address card, the itemized table, totals,
        and terms — so the printed/attached quote looks the same as the link.
        """

        # Prod schema drift can hand us a str (or even a human-formatted
        # string) instead of a date; coerce once so the .strftime() sites below
        # are safe and an unparseable value just hides the validity line.
        expires_at = coerce_date(expires_at)

        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.5*inch,
                                bottomMargin=0.6*inch, leftMargin=0.6*inch, rightMargin=0.6*inch)
        styles = getSampleStyleSheet()
        story = []
        brand = colors.HexColor(self.brand_color)
        CONTENT_W = 7.3 * inch
        white = colors.white

        # ── Brand header band (logo / COMPANY / title / quote# · date / validity)
        band_company = ParagraphStyle('bandCompany', parent=styles['Normal'], fontSize=10,
                                      textColor=white, fontName='Helvetica-Bold', leading=13)
        band_title = ParagraphStyle('bandTitle', parent=styles['Normal'], fontSize=22,
                                    textColor=white, fontName='Helvetica-Bold', leading=26)
        band_meta = ParagraphStyle('bandMeta', parent=styles['Normal'], fontSize=10,
                                   textColor=colors.HexColor('#e5e7eb'), leading=15)

        band_rows = []
        logo_flowable = self._logo_flowable()
        if logo_flowable is not None:
            band_rows.append([logo_flowable])
        band_rows.append([Paragraph(_esc(self.company_name.upper()), band_company)])
        band_rows.append([Paragraph(_esc(quote_title) or 'Your Cleaning Quote', band_title)])
        band_rows.append([Paragraph(f"Quote #{_esc(quote_number)} &middot; {datetime.now().strftime('%B %d, %Y')}", band_meta)])
        if expires_at:
            band_rows.append([Paragraph(f"Valid until {expires_at.strftime('%B %d, %Y')}", band_meta)])

        band = Table(band_rows, colWidths=[CONTENT_W])
        band.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), brand),
            ('LEFTPADDING', (0, 0), (-1, -1), 22),
            ('RIGHTPADDING', (0, 0), (-1, -1), 22),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (0, 0), 22),
            ('BOTTOMPADDING', (0, -1), (-1, -1), 22),
        ]))
        story.append(band)

        # ── "Accept / request changes online" link (a PDF can't have buttons)
        if quote_link:
            cta_style = ParagraphStyle('cta', parent=styles['Normal'], fontSize=10.5,
                                       textColor=colors.HexColor('#1f2937'), leading=15)
            cta = Table([[Paragraph(
                f'<b>To accept or request changes, view your quote online:</b><br/>'
                f'<a href={quoteattr(quote_link)} color="#1d4ed8">{_esc(quote_link)}</a>', cta_style)]],
                colWidths=[CONTENT_W])
            cta.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#eff6ff')),
                ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#bfdbfe')),
                ('LEFTPADDING', (0, 0), (-1, -1), 14), ('RIGHTPADDING', (0, 0), (-1, -1), 14),
                ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
            ]))
            story.append(Spacer(1, 0.18 * inch))
            story.append(cta)

        # ── Front-of-house photo (Street View) when available
        photo_flowable = self._photo_flowable(property_photo_url)
        if photo_flowable is not None:
            story.append(Spacer(1, 0.18 * inch))
            story.append(photo_flowable)

        label_style = ParagraphStyle('lbl', parent=styles['Normal'], fontSize=8,
                                     textColor=colors.HexColor('#6b7280'), fontName='Helvetica-Bold')
        val_style = ParagraphStyle('val', parent=styles['Normal'], fontSize=10,
                                   textColor=colors.HexColor('#1f2937'), leading=14)

        # ── Service address + service type card (matches the web view)
        svc_label = ('STR / Vacation rental' if service_type == 'str'
                     else (f"{service_type.capitalize()} cleaning" if service_type else ''))
        if address or svc_label:
            left = [Paragraph('SERVICE ADDRESS', label_style), Spacer(1, 2), Paragraph(_esc(address), val_style)] if address else ''
            right = [Paragraph('SERVICE TYPE', label_style), Spacer(1, 2), Paragraph(_esc(svc_label), val_style)] if svc_label else ''
            card = Table([[left, right]], colWidths=[CONTENT_W / 2, CONTENT_W / 2])
            card.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f9fafb')),
                ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 14), ('RIGHTPADDING', (0, 0), (-1, -1), 14),
                ('TOPPADDING', (0, 0), (-1, -1), 12), ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
            ]))
            story.append(Spacer(1, 0.22 * inch))
            story.append(card)

        # ── Customer message (the personal intro, like the web view)
        if customer_message:
            msg_style = ParagraphStyle('msg', parent=styles['Normal'], fontSize=10.5,
                                       textColor=colors.HexColor('#374151'), leading=15)
            story.append(Spacer(1, 0.22 * inch))
            story.append(Paragraph(_esc_ml(customer_message), msg_style))

        # ── Customer-facing scope / details
        if notes:
            story.append(Spacer(1, 0.2 * inch))
            story.append(Paragraph('SCOPE &amp; DETAILS', label_style))
            story.append(Spacer(1, 3))
            story.append(Paragraph(_esc_ml(notes), val_style))

        # ── Itemized table (Service / Qty / Amount — same columns as the web)
        name_style = ParagraphStyle('itemName', parent=styles['Normal'], fontSize=10,
                                    textColor=colors.HexColor('#1f2937'), fontName='Helvetica-Bold', leading=13)
        desc_style = ParagraphStyle('itemDesc', parent=styles['Normal'], fontSize=8.5,
                                    textColor=colors.HexColor('#6b7280'), leading=11)
        head_style = ParagraphStyle('itemHead', parent=styles['Normal'], fontSize=8,
                                    textColor=colors.HexColor('#6b7280'), fontName='Helvetica-Bold')
        amt_style = ParagraphStyle('itemAmt', parent=styles['Normal'], fontSize=10,
                                   textColor=colors.HexColor('#1f2937'), alignment=TA_RIGHT, leading=13)

        rows = [[Paragraph('SERVICE', head_style),
                 Paragraph('QTY', ParagraphStyle('h2', parent=head_style, alignment=TA_RIGHT)),
                 Paragraph('AMOUNT', ParagraphStyle('h3', parent=head_style, alignment=TA_RIGHT))]]
        for item in line_items:
            cell = [Paragraph(_esc(item.get('name') or 'Service'), name_style)]
            if item.get('description'):
                cell.append(Paragraph(_esc(item['description']), desc_style))
            qty = item.get('quantity', 1)
            qty_str = ('%g' % qty) if isinstance(qty, (int, float)) else str(qty)
            rows.append([cell,
                         Paragraph(qty_str, ParagraphStyle('q', parent=val_style, alignment=TA_RIGHT)),
                         Paragraph(f"${item.get('line_total', 0):,.2f}", amt_style)])

        items_table = Table(rows, colWidths=[CONTENT_W - 2.6*inch, 0.9*inch, 1.7*inch])
        items_table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 9), ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
            ('LINEBELOW', (0, 0), (-1, 0), 0.75, colors.HexColor('#e5e7eb')),
            ('LINEBELOW', (0, 1), (-1, -1), 0.5, colors.HexColor('#f0f0f0')),
        ]))
        story.append(Spacer(1, 0.22 * inch))
        story.append(items_table)

        # ── Totals (subtotal, optional tax/discount, bold total) right-aligned
        totals_data = [['Subtotal', f"${subtotal:,.2f}"]]
        if tax_amount:
            totals_data.append(['Tax', f"${tax_amount:,.2f}"])
        if discount_amount:
            totals_data.append(['Discount', f"-${discount_amount:,.2f}"])
        totals_data.append(['Total', f"${total_amount:,.2f}"])
        total_row = len(totals_data) - 1

        totals_table = Table(totals_data, colWidths=[1.4*inch, 1.7*inch], hAlign='RIGHT')
        totals_table.setStyle(TableStyle([
            ('FONT', (0, 0), (-1, total_row - 1), 'Helvetica', 10),
            ('FONT', (0, total_row), (-1, total_row), 'Helvetica-Bold', 13),
            ('TEXTCOLOR', (0, 0), (-1, total_row - 1), colors.HexColor('#6b7280')),
            ('TEXTCOLOR', (0, total_row), (0, total_row), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (1, total_row), (1, total_row), brand),
            ('ALIGN', (0, 0), (-1, -1), 'RIGHT'),
            ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('LINEABOVE', (0, total_row), (-1, total_row), 1, colors.HexColor('#e5e7eb')),
            ('TOPPADDING', (0, total_row), (-1, total_row), 9),
        ]))
        story.append(Spacer(1, 0.1 * inch))
        story.append(totals_table)

        # ── Contact + terms (trust block, like the web footer)
        story.append(Spacer(1, 0.35 * inch))
        contact = " or call ".join(b for b in (f"email {self.company_email}" if self.company_email else None,
                                               self.company_phone) if b)
        if contact:
            contact_style = ParagraphStyle('contact', parent=styles['Normal'], fontSize=9,
                                           textColor=colors.HexColor('#6b7280'), alignment=TA_CENTER)
            story.append(Paragraph(f"Questions? {_esc(contact)}", contact_style))
        if self.terms:
            story.append(Spacer(1, 0.15 * inch))
            terms_label = ParagraphStyle('termsLabel', parent=label_style, fontSize=8)
            terms_style = ParagraphStyle('Terms', parent=styles['Normal'], fontSize=8,
                                         textColor=colors.HexColor('#9ca3af'), leading=12)
            story.append(Paragraph('TERMS &amp; CONDITIONS', terms_label))
            story.append(Spacer(1, 3))
            story.append(Paragraph(_esc_ml(self.terms), terms_style))

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
