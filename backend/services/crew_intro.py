"""Who is coming — the customer-facing view of a job's crew.

THE ONE RULE THIS SURFACE EXISTS UNDER. A customer sees who won their job.
They never choose, never rank, never request a person. Choosing is assigning,
and the office does not assign (`.claude/skills/brightbase-marketplace`,
Rule 0) — so anything here that grows into a preference, a rating, a "book
Amanda again" link, or an ordering the customer can influence is the same
violation wearing a nicer coat. This module returns a list of names. Keep it
that way.

WHAT A CUSTOMER GETS, and what they deliberately do not:

  * a first name and a last initial. Enough to recognize the person at the
    door and to say their name; not enough to be a directory entry.
  * whether a photo exists. The bytes come from a separate endpoint that
    re-derives access from the caller's own token, so nothing here can leak
    an image by being serialized into the wrong payload.
  * NOT a phone number, NOT an email, NOT a crew ID, NOT a rate, NOT how many
    other jobs they have. A customer needs to know who is walking in. The rest
    is the subcontractor's business, and some of it is their livelihood.

Helpers (`job_helpers`) are included as names only. A helper has no account
and no photo by design — see the model — but they are a person in somebody's
house, which is the whole reason the customer is being told anything at all.

BATCHED ON PURPOSE. `for_jobs` takes the whole list a screen is about to
render and answers in three queries regardless of length (brightbase-economy:
one fetch per screen per need). The portal's visit list would otherwise be
N+1 across a customer's whole history.
"""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database.models import CrewPhoto, JobHelper, User


def display_name(full_name: Optional[str]) -> Optional[str]:
    """"Amanda Smith" -> "Amanda S." — the customer-facing form of a name.

    A single-word name is returned as-is (plenty of people go by one), and a
    blank one returns None rather than falling back to an email or a crew ID:
    a person with no name on file is left out of the list entirely, because
    every fallback we could reach for is more identifying than the thing we
    are deliberately trimming.
    """
    name = (full_name or "").strip()
    if not name:
        return None
    parts = name.split()
    if len(parts) == 1:
        return parts[0]
    last = parts[-1].strip(".")
    if not last:
        return parts[0]
    return f"{parts[0]} {last[0].upper()}."


def _roster(db: Session, jobs: Iterable, *, org_id: Optional[int]) -> dict:
    """{job_id: [entry]} where an entry carries `user_id` — the INTERNAL shape.

    This is the single definition of who is on a job and in what order. The
    wire shape (`for_jobs`) and the photo lookup (`photo_user_id_at`) both
    read it rather than each walking `cleaner_ids` themselves, because two
    implementations of that ordering would drift and the symptom would be one
    person's face served under another person's name.

    A cancelled job returns nobody — there is no visit, so there is no one
    coming, and a name left on a cancelled card reads as "they're still
    coming". A job with no crew returns nobody too, which is the "before
    approval" state: the customer is told once somebody has actually won the
    job, and not one moment earlier.

    Crew come back in the job's own `cleaner_ids` order, each followed by
    their own helpers. Three queries total, however many jobs are passed in.
    """
    jobs = [j for j in jobs if j is not None]
    if not jobs:
        return {}

    live = [j for j in jobs if j.status != "cancelled"]
    crew_ids: set = set()
    for j in live:
        for cid in (j.cleaner_ids or []):
            if str(cid).strip():
                crew_ids.add(str(cid))
    if not crew_ids:
        return {j.id: [] for j in jobs}

    # `org_id is None` means the JOB carries no org — legacy rows predating
    # MT-3. Filtering on it would render as `org_id IS NULL` and match only
    # other org-less rows, so a customer looking at an old visit would be told
    # nobody is coming while a cleaner is on their way. Fall back to no filter
    # there: the job's own `cleaner_ids` is the scope, and the caller reached
    # this job by holding its secret token.
    q = db.query(User.id, User.cleaner_id, User.full_name).filter(
        User.cleaner_id.in_(crew_ids))
    if org_id is not None:
        q = q.filter(or_(User.org_id == org_id, User.org_id.is_(None)))
    users = q.all()
    by_crew_id = {str(u.cleaner_id): u for u in users}

    # Existence only — never the bytes. Loading `data` here would pull every
    # headshot on the screen into memory to answer a boolean.
    photo_user_ids = {
        r[0] for r in db.query(CrewPhoto.user_id)
        .filter(CrewPhoto.user_id.in_([u.id for u in users])).all()
    } if users else set()

    helpers_by_job: dict = {}
    if live:
        hq = db.query(JobHelper).filter(JobHelper.job_id.in_([j.id for j in live]))
        if org_id is not None:
            hq = hq.filter(or_(JobHelper.org_id == org_id, JobHelper.org_id.is_(None)))
        for h in hq.order_by(JobHelper.id).all():
            (helpers_by_job.setdefault(h.job_id, {})
                           .setdefault(str(h.sub_cleaner_id), []).append(h))

    out: dict = {}
    for j in jobs:
        people: list = []
        if j.status != "cancelled":
            for cid in (j.cleaner_ids or []):
                cid = str(cid)
                u = by_crew_id.get(cid)
                if not u:
                    continue
                name = display_name(u.full_name)
                if not name:
                    continue
                people.append({"user_id": u.id, "name": name,
                               "has_photo": u.id in photo_user_ids,
                               "is_helper": False})
                for h in helpers_by_job.get(j.id, {}).get(cid, []):
                    hname = display_name(h.name)
                    if hname:
                        people.append({"user_id": None, "name": hname,
                                       "has_photo": False, "is_helper": True})
        out[j.id] = people
    return out


def _public(entry: dict) -> dict:
    """One roster entry, minus the internal id. `user_id` never crosses the
    wire to a customer: a stable per-person integer is a handle, and a handle
    is the first half of picking somebody."""
    return {"name": entry["name"], "has_photo": entry["has_photo"],
            "is_helper": entry["is_helper"]}


def for_jobs(db: Session, jobs: Iterable, *, org_id: Optional[int]) -> dict:
    """{job_id: [{"name", "has_photo", "is_helper"}]} — the customer-facing
    shape, for a whole screen's worth of jobs in three queries."""
    return {jid: [_public(e) for e in people]
            for jid, people in _roster(db, jobs, org_id=org_id).items()}


def for_job(db: Session, job, *, org_id: Optional[int]) -> list:
    """`for_jobs` for a single job — the public confirm page's shape."""
    return for_jobs(db, [job], org_id=org_id).get(job.id, [])


def photo_user_id_at(db: Session, job, index: int, *, org_id: Optional[int]) -> Optional[int]:
    """Whose photo sits at `index` in this job's crew list, or None.

    The public photo endpoint addresses a face by its POSITION in the list the
    customer was just handed, never by user id or crew id: a position cannot
    be walked to enumerate the bench, and it means nothing outside the one job
    token that produced it. Helpers occupy positions and have no photo, so
    asking for one is a clean None rather than an off-by-one into somebody
    else's face.
    """
    if job is None or index < 0:
        return None
    people = _roster(db, [job], org_id=org_id).get(job.id, [])
    if index >= len(people):
        return None
    entry = people[index]
    return entry["user_id"] if entry["has_photo"] else None
