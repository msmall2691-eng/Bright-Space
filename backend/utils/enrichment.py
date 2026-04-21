"""Contact enrichment utilities - extract info from email, name, phone, etc."""
import re
from typing import Optional, Dict, Any


def extract_company_from_email(email: Optional[str]) -> Optional[str]:
    """Extract company name from email domain. e.g., john@acme.com -> 'Acme'"""
    if not email or '@' not in email:
        return None

    domain = email.split('@')[1].lower()

    # Remove common TLDs and subdomains
    domain = re.sub(r'\.(com|co|org|net|io|gov|edu|uk)$', '', domain)
    domain = re.sub(r'^(mail|smtp|pop|imap|www|mail\.|app\.)', '', domain)

    # Split by dots and take first part (usually company)
    parts = domain.split('.')
    company = parts[0] if parts else None

    # Capitalize nicely
    if company:
        company = company.replace('-', ' ').title()

    return company if company and len(company) > 1 else None


def suggest_name_from_email(email: Optional[str], current_name: Optional[str]) -> Optional[Dict[str, str]]:
    """Suggest first/last name from email if name is missing. e.g., john.smith@... -> 'John Smith'"""
    if current_name and current_name.strip():
        return None

    if not email or '@' not in email:
        return None

    local_part = email.split('@')[0].lower()

    # Remove common prefixes
    local_part = re.sub(r'^(john|admin|support|contact|info)', '', local_part)

    # Split by dots, dashes, underscores
    parts = re.split(r'[._\-]', local_part)
    parts = [p for p in parts if p and len(p) > 1]

    if len(parts) == 0:
        return None

    if len(parts) >= 2:
        return {
            'first_name': parts[0].capitalize(),
            'last_name': ' '.join(p.capitalize() for p in parts[1:])
        }

    return None


def validate_phone_format(phone: Optional[str]) -> bool:
    """Check if phone looks like valid format (at least 7 digits)"""
    if not phone:
        return False
    digits = re.sub(r'\D', '', phone)
    return len(digits) >= 7


def enrich_client_data(client_dict: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enrich client data with extracted information.
    Returns updated client dict with enriched fields.
    """
    enriched = dict(client_dict)

    email = enriched.get('email')

    # Suggest name from email if name is missing
    if email and not enriched.get('name'):
        name_suggestion = suggest_name_from_email(email, enriched.get('name'))
        if name_suggestion:
            enriched.update(name_suggestion)
            # Derive full name
            first = enriched.get('first_name', '')
            last = enriched.get('last_name', '')
            if first or last:
                enriched['name'] = f"{first} {last}".strip()

    # Store company in source_detail if extracted from email
    if email and enriched.get('source_detail') is None:
        company = extract_company_from_email(email)
        if company:
            enriched['source_detail'] = f"email domain: {company}"

    return enriched
