import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from database.db import get_db
from database.models import Message, Client
from integrations.twilio_client import send_sms

router = APIRouter()


class SMSRequest(BaseModel):
    to: str
    body: str
    client_id: Optional[int] = None


class EmailRequest(BaseModel):
    to: str
    subject: str
    body: str
    client_id: Optional[int] = None


def msg_to_dict(m: Message) -> dict:
    return {
        "id": m.id,
        "client_id": m.client_id,
        "channel": m.channel,
        "direction": m.direction,
        "from_addr": m.from_addr,
        "to_addr": m.to_addr,
        "subject": m.subject,
        "body": m.body,
        "status": m.status,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("/messages")
def get_messages(
    client_id: Optional[int] = None,
    channel: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Message)
    if client_id:
        q = q.filter(Message.client_id == client_id)
    if channel:
        q = q.filter(Message.channel == channel)
    return [msg_to_dict(m) for m in q.order_by(Message.created_at.desc()).limit(200).all()]


@router.post("/sms")
def send_sms_message(data: SMSRequest, db: Session = Depends(get_db)):
    """Send an SMS via Twilio and log it."""
    try:
        result = send_sms(to=data.to, body=data.body)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Twilio error: {str(e)}")

    import os
    msg = Message(
        client_id=data.client_id,
        channel="sms",
        direction="outbound",
        from_addr=os.getenv("TWILIO_PHONE_NUMBER", ""),
        to_addr=data.to,
        body=data.body,
        status=result.get("status", "sent"),
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg_to_dict(msg)


@router.post("/twilio/webhook")
async def twilio_inbound(request: Request, db: Session = Depends(get_db)):
    """Receive inbound SMS from Twilio webhook."""
    form = await request.form()
    from_number = form.get("From", "")
    to_number = form.get("To", "")
    body = form.get("Body", "")

    logger.info("Inbound SMS from=%s to=%s body=%s", from_number, to_number, body[:80])

    # Try to match to a client by phone number
    client = db.query(Client).filter(Client.phone == from_number).first()
    if not client:
        logger.warning("No client matched for phone number: %s", from_number)

    msg = Message(
        client_id=client.id if client else None,
        channel="sms",
        direction="inbound",
        from_addr=from_number,
        to_addr=to_number,
        body=body,
        status="received",
    )
    db.add(msg)
    db.commit()

    # Return valid TwiML empty response so Twilio knows we handled it
    return Response(
        content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        media_type="application/xml",
    )
