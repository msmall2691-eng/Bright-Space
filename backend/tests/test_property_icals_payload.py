"""BB-SEC-13 — the feed-management payload carries no access details.

`GET /api/properties/{id}/icals` exists so `PropertyIcalsBulk` stops reading
`GET /api/properties/{id}`, which that endpoint's own BB-SEC-11 comment
describes as "the full property dict — house_code, access_notes, wifi_password
included". The page renders seven fields and displayed none of that, and the
per-feed dicts on the old route carry `house_code` / `access_links` /
`instructions` too, so every load of a feed screen put a property's door code
and wifi password on the wire for nothing.

Both routes are office-only, so this was never a BB-SEC-08..12 violation — a
manager may read access details. The point is narrower and worth stating
plainly, because it is the reason this test exists rather than a comment: the
fewer screens a door code reaches, the fewer places it can be logged,
screenshotted, or left open on a laptop in a client's kitchen.

So this asserts the SHAPE, not the values. A field added to the new route
either appears in the allow-list below with a reason or fails here, which is
the only way a "just add the whole dict, it is easier" change gets noticed.
The denial list is independent of the allow-list on purpose: a rename that
slipped a secret through under a new spelling would pass an allow-list check
alone, so the sensitive names are also banned by substring.
"""
import uuid

import pytest

from database.db import SessionLocal
from database.models import Client, Property, PropertyIcal
from modules.properties.router import list_property_icals


class _Owner:
    id = None
    email = "owner@example.com"
    role = "admin"


# Exactly what the page reads, plus `active` — a feed's state, which the sync
# logic keys off and which is not a secret.
ALLOWED_PROPERTY_KEYS = {
    "id", "name", "address", "city", "state", "property_type",
    "default_duration_hours", "icals",
}
ALLOWED_ICAL_KEYS = {
    "id", "url", "source", "active",
    "last_synced_at", "last_sync_status", "last_sync_error",
}

# Substrings that must never appear in a key at either level, so a rename
# cannot smuggle one past the allow-lists above.
BANNED_SUBSTRINGS = (
    "code", "wifi", "password", "access", "lockbox", "instruction",
    "note", "alarm", "key",
)


@pytest.fixture
def made():
    ids = {"properties": [], "clients": []}
    yield ids
    db = SessionLocal()
    if ids["properties"]:
        db.query(PropertyIcal).filter(
            PropertyIcal.property_id.in_(ids["properties"])
        ).delete(synchronize_session=False)
        db.query(Property).filter(
            Property.id.in_(ids["properties"])
        ).delete(synchronize_session=False)
    if ids["clients"]:
        db.query(Client).filter(
            Client.id.in_(ids["clients"])
        ).delete(synchronize_session=False)
    db.commit()
    db.close()


def _property_with_secrets(db, made):
    """A property carrying every access detail the model has room for, plus a
    feed carrying the per-feed ones. If any of it reaches the payload, the
    assertions below have something real to catch."""
    tag = uuid.uuid4().hex[:6]
    # properties.client_id is NOT NULL, so the owner comes first.
    client = Client(name=f"Ical{tag} Owner", first_name=f"Ical{tag}", last_name="Owner")
    db.add(client)
    db.commit()
    made["clients"].append(client.id)

    prop = Property(
        client_id=client.id,
        name=f"Harbor {tag}",
        address="12 Harbor Rd",
        city="Portland",
        state="ME",
        property_type="str",
        default_duration_hours=3.0,
        house_code="8891",
        wifi_password="seaglass-2026",
        access_notes="Lockbox on the left post, code 4417.",
        parking_notes="Driveway only.",
    )
    db.add(prop)
    db.commit()
    made["properties"].append(prop.id)

    db.add(PropertyIcal(
        property_id=prop.id,
        org_id=prop.org_id,
        url="https://example.invalid/feed.ics",
        source="airbnb",
        active=True,
        house_code="8891",
        instructions="Side door sticks.",
    ))
    db.commit()
    return prop


def test_payload_holds_no_access_detail(made):
    db = SessionLocal()
    try:
        prop = _property_with_secrets(db, made)
        out = list_property_icals(prop.id, db=db, org_id=prop.org_id)

        offenders = [k for k in out if any(b in k.lower() for b in BANNED_SUBSTRINGS)]
        assert not offenders, f"property keys look sensitive: {offenders}"

        assert out["icals"], "the fixture's feed is missing from the payload"
        for feed in out["icals"]:
            bad = [k for k in feed if any(b in k.lower() for b in BANNED_SUBSTRINGS)]
            assert not bad, f"feed keys look sensitive: {bad}"

        # The values, not just the names — a key called `source` holding the
        # wifi password would pass the check above.
        blob = repr(out)
        for secret in ("8891", "seaglass-2026", "Lockbox on the left post", "Side door sticks"):
            assert secret not in blob, f"{secret!r} reached the feed payload"
    finally:
        db.close()


def test_payload_is_exactly_what_the_screen_reads(made):
    # An allow-list rather than a minimum: a field that creeps in without a
    # reader is how the old route grew into the full dict in the first place.
    db = SessionLocal()
    try:
        prop = _property_with_secrets(db, made)
        out = list_property_icals(prop.id, db=db, org_id=prop.org_id)

        assert set(out) == ALLOWED_PROPERTY_KEYS, (
            "property keys drifted from what PropertyIcalsBulk reads: "
            f"extra={set(out) - ALLOWED_PROPERTY_KEYS} "
            f"missing={ALLOWED_PROPERTY_KEYS - set(out)}"
        )
        for feed in out["icals"]:
            assert set(feed) == ALLOWED_ICAL_KEYS, (
                "feed keys drifted: "
                f"extra={set(feed) - ALLOWED_ICAL_KEYS} "
                f"missing={ALLOWED_ICAL_KEYS - set(feed)}"
            )
    finally:
        db.close()


def test_a_property_in_another_org_is_not_readable(made):
    # MT-2: the explicit tenant scope, not just the RLS backstop. The sibling
    # DELETE on this router filters by ical id and property id only and leans
    # entirely on RLS; this route should not.
    #
    # The property has to be OWNED by an org for this to mean anything. The
    # filter reads `org_id == :org OR org_id IS NULL`, so a pre-tenancy row
    # with a null org is readable from everywhere by design — which is what
    # the first version of this test accidentally asserted against, and why it
    # passed a route with no scope at all.
    from fastapi import HTTPException
    from database.models import Org

    db = SessionLocal()
    try:
        prop = _property_with_secrets(db, made)
        if not db.query(Org).filter(Org.id == 1).first():
            db.add(Org(id=1, name="Maine Cleaning Co", slug="maine-cleaning-co"))
            db.commit()
        prop.org_id = 1
        db.commit()

        assert list_property_icals(prop.id, db=db, org_id=1)["id"] == prop.id

        with pytest.raises(HTTPException) as caught:
            list_property_icals(prop.id, db=db, org_id=2)
        assert caught.value.status_code == 404
    finally:
        db.close()
