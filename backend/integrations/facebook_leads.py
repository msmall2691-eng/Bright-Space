"""Facebook / Instagram Lead Ads — inbound leads from Meta's lead forms.

## Why this exists

A Lead Ad on Facebook or Instagram collects a name and a phone number inside
the app, and then the lead sits in Meta's Leads Center until somebody logs in
and goes looking for it. That is the whole problem: the lead is real, it is
paid for, and it is *somewhere else*. By the time it is copied into the
business the customer has called three other cleaners.

This module turns one of those form submissions into a BrightBase lead on the
Requests page, in the same second it is submitted, through the same canonical
intake path as the website form (``build_intake`` / ``upsert_lead`` in
``modules.intake.normalize``) — so dedup, the estimate engine, the push alert
and the source filter all work without a single special case downstream.

## The shape of Meta's flow (the part that surprises people)

The webhook delivery contains **no customer data**. It is a notification that
a lead exists::

    {"object": "page", "entry": [{"id": "<page id>", "time": 1234,
      "changes": [{"field": "leadgen", "value": {
         "leadgen_id": "...", "page_id": "...", "form_id": "...",
         "created_time": 1234}}]}]}

The answers have to be fetched back out of the Graph API with the leadgen id
and a Page access token. So a working integration needs three secrets, and
missing any one of them means a lead is lost rather than delayed — which is
why the handler refuses (503) rather than 200-ing a delivery it cannot turn
into a lead. Meta retries a non-2xx for hours; that retry window is the only
thing that makes a missing token recoverable instead of fatal.

## Configuration

``FACEBOOK_APP_SECRET``    — signs every delivery (``X-Hub-Signature-256``).
``FACEBOOK_VERIFY_TOKEN``  — your own string, echoed in the subscribe handshake.
``FACEBOOK_PAGE_TOKEN``    — long-lived Page token with ``leads_retrieval``.
``FACEBOOK_GRAPH_VERSION`` — optional; defaults below.

All four are read at call time, not import time, so setting them in Railway
takes effect on the next request rather than needing a redeploy.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Meta pins every call to an API version and retires each one about two years
# after release. v25.0 is what Meta's own Lead Ads retrieval docs use in their
# examples, so it is certainly live; the env var is here because the right
# answer changes on Meta's schedule, not ours, and bumping it must not need a
# code change. If a fetch starts failing with "Unsupported get request" or a
# version error, raise this first.
_DEFAULT_GRAPH_VERSION = "v25.0"

# A hung Graph call would hold a uvicorn worker open while Meta retries the
# same delivery, so it is bounded hard. Lead retrieval is a single small GET.
_HTTP_TIMEOUT_SECONDS = int(os.getenv("FACEBOOK_HTTP_TIMEOUT_SECONDS", "10"))


def app_secret() -> str:
    return (os.getenv("FACEBOOK_APP_SECRET") or "").strip()


def verify_token() -> str:
    return (os.getenv("FACEBOOK_VERIFY_TOKEN") or "").strip()


def page_token() -> str:
    return (os.getenv("FACEBOOK_PAGE_TOKEN") or "").strip()


def graph_version() -> str:
    return (os.getenv("FACEBOOK_GRAPH_VERSION") or "").strip() or _DEFAULT_GRAPH_VERSION


def verify_signature(raw_body: bytes, header: Optional[str]) -> bool:
    """Check Meta's ``X-Hub-Signature-256`` over the RAW request body.

    The endpoint is public — Meta cannot send our API key — so this signature
    is the only thing between a stranger and an unlimited supply of fake leads
    in the owner's inbox. Same posture as the Twilio and Stripe webhooks
    (BB-SEC-06): **no secret configured means reject, not accept.**

    The digest is computed over the exact bytes received. Re-serializing the
    parsed JSON would change key order and whitespace and fail every time.
    """
    secret = app_secret()
    if not secret or not header:
        return False
    algo, _, sent = header.partition("=")
    if algo.strip().lower() != "sha256" or not sent:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sent.strip())


def verify_subscription(mode: Optional[str], token: Optional[str]) -> bool:
    """The one-time handshake Meta performs when the webhook URL is saved.

    Constant-time, and false when nothing is configured, for the same reason
    the signature check is: an attacker who can complete this handshake can
    point their own app's deliveries at us.
    """
    want = verify_token()
    if not want or mode != "subscribe" or not token:
        return False
    return hmac.compare_digest(want, token)


def iter_leadgen_ids(payload: dict) -> list:
    """Pull every ``leadgen`` change out of a delivery, newest shape only.

    Meta batches: one POST can carry several entries, each with several
    changes, and changes for fields we never subscribed to. Anything that is
    not a ``leadgen`` change is ignored rather than guessed at.

    Returns a list of ``(leadgen_id, form_id)``.
    """
    found = []
    for entry in (payload.get("entry") or []):
        if not isinstance(entry, dict):
            continue
        for change in (entry.get("changes") or []):
            if not isinstance(change, dict) or change.get("field") != "leadgen":
                continue
            value = change.get("value") or {}
            leadgen_id = str(value.get("leadgen_id") or "").strip()
            if leadgen_id:
                found.append((leadgen_id, str(value.get("form_id") or "").strip()))
    return found


def fetch_lead(leadgen_id: str) -> Optional[dict]:
    """Fetch one lead's answers from the Graph API.

    Returns the parsed lead node (``{"id", "created_time", "field_data"}``) or
    None when the call fails. Never logs the response body — ``field_data`` is
    the customer's name, phone and email.
    """
    token = page_token()
    if not token:
        logger.error("[facebook] no FACEBOOK_PAGE_TOKEN — cannot fetch lead %s", leadgen_id)
        return None
    url = f"https://graph.facebook.com/{graph_version()}/{leadgen_id}"
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_SECONDS) as client:
            resp = client.get(url, params={
                "access_token": token,
                "fields": "id,created_time,field_data,form_id",
            })
        if resp.status_code != 200:
            # Meta puts the reason in the body; it is an error description, not
            # customer data, so it is safe and genuinely useful to log.
            logger.error("[facebook] lead %s fetch failed: HTTP %s %s",
                         leadgen_id, resp.status_code, resp.text[:300])
            return None
        data = resp.json()
        if not isinstance(data, dict) or "field_data" not in data:
            logger.error("[facebook] lead %s returned no field_data", leadgen_id)
            return None
        return data
    except Exception as e:  # network, JSON, anything
        logger.error("[facebook] lead %s fetch error: %s", leadgen_id, e)
        return None


# Meta's standard lead-form question names -> our intake kwargs. A form can
# also carry custom questions with arbitrary names; those are kept verbatim
# (see map_lead_fields) rather than dropped, because for a cleaning business
# the custom question is usually the useful one ("how many bedrooms?").
_FIELD_ALIASES = {
    "email": "email",
    "work_email": "email",
    "phone_number": "phone",
    "work_phone_number": "phone",
    "full_name": "name",
    "street_address": "address",
    "city": "city",
    "state": "state",
    "province": "state",
    "zip_code": "zip_code",
    "post_code": "zip_code",
    "postal_code": "zip_code",
}

# Question names whose ANSWER is a service/property hint. Passed to
# build_intake as the raw service_key so the existing keyword sniff can rescue
# a "commercial" or "vacation rental" answer into the right canonical type.
_SERVICE_HINT_NAMES = ("service", "property_type", "property", "type_of_clean",
                       "cleaning_type", "what_type")


def _first(values) -> str:
    if isinstance(values, (list, tuple)):
        return str(values[0]).strip() if values else ""
    return str(values or "").strip()


def map_lead_fields(field_data) -> dict:
    """Turn Meta's ``field_data`` into kwargs for ``build_intake``.

    Returns a dict with the mapped contact/address fields, plus:
      ``service_key``  — a service hint if the form asked for one
      ``message``      — the unmapped questions rendered Q: A, one per line
      ``custom_fields``— ``{"facebook_answers": {name: value}}``, nothing lost

    Both halves on purpose: the operator reads the message on the Requests
    card without opening anything, and the structured copy survives for
    anybody who later wants to parse it.
    """
    out: dict = {}
    first_name = last_name = ""
    extras: dict = {}
    for item in (field_data or []):
        if not isinstance(item, dict):
            continue
        raw_name = str(item.get("name") or "").strip()
        key = raw_name.lower()
        value = _first(item.get("values"))
        if not key or not value:
            continue
        if key == "first_name":
            first_name = value
            continue
        if key == "last_name":
            last_name = value
            continue
        mapped = _FIELD_ALIASES.get(key)
        if mapped:
            # First answer wins: a form with both `email` and `work_email`
            # should not have the second quietly overwrite the first.
            out.setdefault(mapped, value)
            continue
        if any(hint in key for hint in _SERVICE_HINT_NAMES) and "service_key" not in out:
            out["service_key"] = value
            # Still an answer the operator should read, so it is kept below.
        extras[raw_name] = value

    if "name" not in out:
        joined = " ".join(p for p in (first_name, last_name) if p).strip()
        if joined:
            out["name"] = joined

    if extras:
        # Underscored field names are Meta's machine names; a human reads
        # "How many bedrooms" far better than "how_many_bedrooms".
        out["message"] = "\n".join(
            f"{k.replace('_', ' ').strip().capitalize()}: {v}" for k, v in extras.items()
        )
        out["custom_fields"] = {"facebook_answers": extras}
    return out
