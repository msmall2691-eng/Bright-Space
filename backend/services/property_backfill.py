"""Decide which property a property-less job/series should be attached to.

The require-a-property guardrail stops NEW property-less records; this is the
"auto-fix where safe" side for the ones already on the books (prod drifted to
allow a NULL Job.property_id / RecurringSchedule.property_id despite the models).
Migration 124 calls this per orphaned row.

"Where safe" is the whole point — we only act when the answer is unambiguous:
  - the client has exactly ONE property      → attach it,
  - the client has NONE but has an address   → create one from it and attach,
  - the client has MULTIPLE properties, or none and no address → return None,
    and the row is left for a human to resolve (don't guess which house).
"""
from database.models import Client, Property


def resolve_backfill_property_id(db, client_id, org_id=None):
    """Return the property id to attach to a property-less row for this client,
    creating a property from the client's address when they have none. Returns
    None when it can't be decided safely (multiple properties, or none + no
    address) — the caller leaves that row untouched for review."""
    if not client_id:
        return None
    props = (db.query(Property)
             .filter(Property.client_id == client_id)
             .order_by(Property.id.asc()).all())
    if len(props) == 1:
        return props[0].id
    if len(props) > 1:
        return None  # ambiguous — which house? leave for review

    client = db.query(Client).filter(Client.id == client_id).first()
    addr = ((getattr(client, "address", None) if client else "") or "").strip()
    if not addr:
        return None  # nothing to build a property from

    new_prop = Property(
        client_id=client_id,
        name=f"{client.name} — Main" if client and client.name else "Main location",
        address=addr,
        property_type="residential",
    )
    if hasattr(new_prop, "org_id"):
        new_prop.org_id = org_id if org_id is not None else getattr(client, "org_id", None)
    db.add(new_prop)
    db.flush()
    return new_prop.id
