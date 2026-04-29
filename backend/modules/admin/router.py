import csv
import io
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database.db import get_db
from database.models import Client
from utils.phone import normalize_e164, phone_tail

router = APIRouter()


class ClientImportPreview(BaseModel):
    """Preview of clients to be imported."""
    total_rows: int
    valid_clients: int
    duplicates: List[dict]
    invalid_rows: List[dict]
    clients_to_create: List[dict]


class ClientImportResult(BaseModel):
    """Result of client import."""
    created: int
    updated: int
    skipped: int
    errors: List[str]


def _normalize_phone(phone_str: str) -> Optional[str]:
    """Normalize phone to E.164, handling various input formats."""
    return normalize_e164(phone_str)


@router.post("/import/clients", response_model=dict)
async def import_clients(
    file: UploadFile = File(...),
    dry_run: bool = True,
    db: Session = Depends(get_db)
):
    """
    Import clients from Jobber CSV export.

    Expected CSV columns:
    - Client Name
    - Status
    - Phone
    - Email
    - Created date
    - Tags
    - (other columns are ignored)

    dry_run=true: Return preview without applying changes
    dry_run=false: Apply changes to database
    """
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="File must be CSV format")

    try:
        contents = await file.read()
        csv_text = contents.decode('utf-8')
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {str(e)}")

    # Parse CSV
    csv_file = io.StringIO(csv_text)
    reader = csv.DictReader(csv_file)

    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    clients_data = []
    invalid_rows = []
    duplicates = []
    seen_phones = {}

    for row_num, row in enumerate(reader, start=2):  # start=2 because row 1 is header
        try:
            name = row.get('Client Name', '').strip()
            email = row.get('Email', '').strip() or None
            phone = row.get('Phone', '').strip()
            status = row.get('Status', 'Active').strip().lower()

            # Validate required fields
            if not name:
                invalid_rows.append({'row': row_num, 'error': 'Missing Client Name'})
                continue

            # Normalize phone
            normalized_phone = _normalize_phone(phone) if phone else None

            # Skip internal entries
            if any(skip_word in name for skip_word in ['Unit inventory', 'Team Resources', 'maintenance']):
                invalid_rows.append({'row': row_num, 'error': f'Skipped internal entry: {name}'})
                continue

            # Detect duplicates (by name or phone)
            if normalized_phone:
                if normalized_phone in seen_phones:
                    duplicates.append({
                        'row': row_num,
                        'name': name,
                        'phone': phone,
                        'normalized': normalized_phone,
                        'first_occurrence': seen_phones[normalized_phone]['row']
                    })
                    continue
                seen_phones[normalized_phone] = {'row': row_num, 'name': name}

            clients_data.append({
                'row': row_num,
                'name': name,
                'email': email,
                'phone': normalized_phone,
                'phone_display': phone,
                'status': 'active' if status == 'active' else 'lead',
            })

        except Exception as e:
            invalid_rows.append({'row': row_num, 'error': str(e)})

    # Check for existing clients (by phone or email)
    existing_clients = []
    for client_data in clients_data:
        existing = None

        if client_data['phone']:
            tail = phone_tail(client_data['phone'])
            existing = db.query(Client).filter(Client.phone_tail == tail).first()

        if not existing and client_data['email']:
            existing = db.query(Client).filter(Client.email == client_data['email']).first()

        if existing:
            existing_clients.append({
                'name': client_data['name'],
                # Store normalized phone for matching in apply mode (display version is separate)
                'phone': client_data['phone'],
                'phone_display': client_data['phone_display'],
                'email': client_data['email'],
                'existing_id': existing.id,
                'existing_name': existing.name,
                'existing_phone': existing.phone,
                'existing_email': existing.email,
            })

    # Prepare preview response
    preview = {
        'total_rows': row_num if 'row_num' in locals() else 0,
        'valid_clients': len(clients_data),
        'duplicates_in_csv': len(duplicates),
        'existing_in_db': len(existing_clients),
        # Renamed to avoid duplicate key collision with the detailed list below
        'invalid_count': len(invalid_rows),
        'clients_to_create': len(clients_data) - len(existing_clients),
        'duplicates': duplicates,
        'existing_clients': existing_clients,
        'invalid_rows': invalid_rows,
        'sample_clients': clients_data[:5],  # First 5 for preview
    }

    if dry_run:
        return {'mode': 'dry_run', 'preview': preview}

    # Apply changes: create new clients
    created_count = 0
    skipped_count = len(existing_clients)
    errors = []

    for client_data in clients_data:
        # Skip if already exists in DB (compare normalized phone, not display value)
        if any(ec['phone'] == client_data['phone'] and client_data['phone'] for ec in existing_clients):
            continue
        if any(ec['email'] == client_data['email'] and client_data['email'] for ec in existing_clients):
            continue

        try:
            new_client = Client(
                name=client_data['name'],
                email=client_data['email'],
                phone=client_data['phone'],
                phone_tail=phone_tail(client_data['phone']) if client_data['phone'] else None,
                status=client_data['status'],
            )
            db.add(new_client)
            created_count += 1
        except Exception as e:
            errors.append(f"Failed to create {client_data['name']}: {str(e)}")

    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database commit failed: {str(e)}")

    return {
        'mode': 'apply',
        'result': {
            'created': created_count,
            'skipped': skipped_count,
            'invalid': len(invalid_rows),
            'duplicates_in_csv': len(duplicates),
        },
        'errors': errors,
        'summary': f"Created {created_count} clients, skipped {skipped_count} existing, {len(invalid_rows)} invalid rows",
    }
