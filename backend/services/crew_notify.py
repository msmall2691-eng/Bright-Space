"""Telling the crew — "a job landed on your list", and "a job landed on the board."

Called from the canonical assignment write sites (scheduling's create_job /
update_job / auto-assign) AFTER the Job write commits, never from a background
tick (scheduling-invariants R1: event-driven, no polling). Delivery rides
services.push_service.notify_user, which is best-effort, opens its own
short-lived DB session, and is a silent no-op when VAPID keys aren't
configured — so a push hiccup can never fail or roll back the schedule write.

AN OFFER GOES OUT ON TWO CHANNELS. Push first; SMS to whoever push could not
reach, and only to them. Web push requires the app installed to the home
screen and notifications allowed — on an iPhone both, in that order — which is
a chain a busy independent cleaner has no reason to have completed. Before
this, posting a job to somebody who had not done it announced the work to
nobody, silently, and the job sat there. Nobody gets both messages; a person
who has muted open jobs gets neither.

SECURITY: the payload carries only the day, time window, and property/job
name. Door codes, access notes, and addresses NEVER ride a push — lock-screen
notifications are world-readable and get mirrored to watches/other devices.
The cleaner opens My Day (the url target) for the real details.

An OFFER is stricter still, and for a different reason. The open-board listing
in modules/crew/router.py strips the customer's name, the property name and the
address, leaving town plus size: "whose house it is stops being the bidder's
business until they have actually won the job". A push that named the property
would hand back on a lock screen exactly what that listing withholds, to a
wider audience — so `_offer_line` is built from town, day and rate, and never
from `property.name`.
"""
from __future__ import annotations

import logging

from sqlalchemy import or_
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _fmt_time_12h(t) -> str:
    if not t:
        return ""
    h12 = t.hour % 12 or 12
    ampm = "AM" if t.hour < 12 else "PM"
    return f"{h12}:{t.minute:02d} {ampm}" if t.minute else f"{h12} {ampm}"


def _job_line(job) -> str:
    """"Tue, Aug 18 · 9 AM–12 PM · Maple Cottage" — no access details, ever."""
    parts = []
    if getattr(job, "scheduled_date", None):
        parts.append(job.scheduled_date.strftime("%a, %b %-d")
                     if hasattr(job.scheduled_date, "strftime") else str(job.scheduled_date))
    start = _fmt_time_12h(getattr(job, "start_time", None))
    end = _fmt_time_12h(getattr(job, "end_time", None))
    if start:
        parts.append(f"{start}–{end}" if end else start)
    prop = getattr(job, "property", None)
    where = (getattr(prop, "name", None) if prop is not None else None) or job.title or "New job"
    parts.append(where)
    return " · ".join(p for p in parts if p)


def notify_user_or_sms(user_id, title: str, body: str, *, category: str,
                       url: str = "/", tag=None, sms_body: str = None) -> int:
    """Reach ONE person: push first, then SMS to them only if push could not.

    BB-CREW-02: the marketplace's own messages — you won the job, someone else
    got it, a job you'd agreed changed hands, the job you asked for came off the
    board — went out on push ONLY. Web push needs the app installed to the home
    screen and notifications allowed (on an iPhone both, in that order), a chain
    a busy independent cleaner has little reason to have finished, so the person
    a decision most affects was often the one who never heard it. This is the
    single-recipient twin of `notify_jobs_posted`'s two-channel offer.

    SMS is a FALLBACK, never a second copy: it goes only when push delivered to
    nobody. And it honours the SAME mute push does — `notify_user` returns 0
    both when it reached no device AND when the category is opted out, so we
    re-check the category before texting, or we'd SMS exactly the people who
    asked not to hear this. Best-effort, event-driven (no tick,
    scheduling-invariants R1); the message carries no access details, same as
    the push. Returns how many channels delivered.
    """
    from services.push_service import notify_user
    sent = notify_user(user_id, title, body, url=url, tag=tag, category=category)
    if sent:
        return sent
    try:
        from integrations.twilio_client import configured as sms_configured, send_sms
        if not sms_configured():
            return 0
        from database.db import SessionLocal
        from database.models import User
        from services.push_service import category_enabled
        from utils.phone import normalize_e164
        s = SessionLocal()
        try:
            row = (s.query(User.notification_prefs, User.phone)
                   .filter(User.id == user_id).first())
        finally:
            s.close()
        if row is None:
            return 0
        prefs, phone = row
        if not category_enabled(prefs, category):
            return 0            # muted — the fallback must not defeat the opt-out
        e164 = normalize_e164(phone)
        if not e164:
            return 0
        send_sms(to=e164, body=(sms_body or f"{title} {body}").strip())
        return 1
    except Exception:  # pragma: no cover - a text must never break the caller
        logger.warning("SMS fallback failed for user %s", user_id, exc_info=True)
        return 0


def notify_job_assigned(db: Session, job, cleaner_ids) -> int:
    """Push "New job for you" to each cleaner in `cleaner_ids` who has a linked
    login. Callers pass only the NEWLY-assigned IDs (create: all; update: the
    added set) so an unrelated edit never re-pings the whole crew. Best-effort:
    returns the number of successful sends, swallows everything."""
    ids = [str(c) for c in (cleaner_ids or []) if str(c).strip()]
    if not ids:
        return 0
    try:
        from database.models import User
        from services.push_service import notify_user, push_enabled

        if not push_enabled():
            return 0
        oid = getattr(job, "org_id", None)
        q = db.query(User).filter(User.cleaner_id.in_(ids), User.role == "cleaner")
        if oid is not None:
            # Same tenant guard as payroll's user map: cleaner_id isn't unique
            # across orgs, so never resolve another org's same-ID login.
            q = q.filter(or_(User.org_id == oid, User.org_id.is_(None)))
        sent = 0
        for u in q.all():
            sent += notify_user(
                u.id,
                "New job for you",
                _job_line(job),
                url="/my-day",
                tag=f"job-assign-{job.id}",
                category="job_assignments",
            )
        return sent
    except Exception:  # pragma: no cover - defensive: push must never break scheduling
        logger.exception("crew assignment push failed (job %s)", getattr(job, "id", "?"))
        return 0


def _reach_assigned(db: Session, job, cleaner_ids, *, title: str, tag: str) -> int:
    """Reach the cleaner(s) already on `job` on their own login — push, then
    SMS to whoever push could not (notify_user_or_sms). Resolves cleaner_ids to
    logins the same org-scoped way as notify_job_assigned. Best-effort; returns
    channels delivered.

    NOT gated on push_enabled(): SMS is a second channel, and a deploy with no
    VAPID keys must still be able to reach a rescheduled/cancelled sub by text —
    same reasoning notify_jobs_posted dropped that gate. The body is `_job_line`
    (day · time · property): the recipient is already ON this job, so the
    property name is theirs to see — the offer-board withholding does not apply.
    """
    ids = [str(c) for c in (cleaner_ids or []) if str(c).strip()]
    if not ids:
        return 0
    try:
        from database.models import User

        oid = getattr(job, "org_id", None)
        q = db.query(User).filter(User.cleaner_id.in_(ids), User.role == "cleaner")
        if oid is not None:
            q = q.filter(or_(User.org_id == oid, User.org_id.is_(None)))
        sent = 0
        for u in q.all():
            sent += notify_user_or_sms(u.id, title, _job_line(job), url="/my-day",
                                       tag=tag, category="job_assignments")
        return sent
    except Exception:  # pragma: no cover - defensive: notify must never break scheduling
        logger.exception("crew %s notify failed (job %s)", tag, getattr(job, "id", "?"))
        return 0


def notify_job_rescheduled(db: Session, job, cleaner_ids) -> int:
    """The office moved an assigned job to a new day/time — tell whoever is on it
    (BB-CREW-03). Event-driven at the reschedule write, push+SMS.

    Callers pass only cleaners who were ALREADY on the job: a newly-added cleaner
    got "New job for you" at the same write, and telling them the same job
    "moved" in the same breath is noise.
    """
    return _reach_assigned(db, job, cleaner_ids,
                           title="A job of yours moved", tag=f"job-moved-{job.id}")


def notify_job_cancelled(db: Session, job, cleaner_ids) -> int:
    """The office called off an assigned job — tell whoever was on it
    (BB-CREW-03). Event-driven at the cancel write, push+SMS.

    This reaches the cleaner ASSIGNED to the job; it does not overlap
    claim_approval.close_offer, which answers the people still holding a PENDING
    request (they had not won it). Different people, different message.
    """
    return _reach_assigned(db, job, cleaner_ids,
                           title="A job of yours was cancelled",
                           tag=f"job-cancelled-{job.id}")


def _moved_batch_line(jobs) -> str:
    """"Sat, Sep 12 · Maple Cottage; Sun, Sep 13 · Oak House (+2 more)" — the
    new days for a batch of the cleaner's OWN moved jobs. Property names are
    fine here (unlike the offer board): the recipient is assigned to every one.
    """
    def one(j):
        parts = []
        d = getattr(j, "scheduled_date", None)
        if d is not None:
            parts.append(d.strftime("%a, %b %-d") if hasattr(d, "strftime") else str(d))
        prop = getattr(j, "property", None)
        where = (getattr(prop, "name", None) if prop is not None else None) or getattr(j, "title", None) or "a job"
        parts.append(where)
        return " · ".join(parts)
    shown = "; ".join(one(j) for j in jobs[:3])
    extra = len(jobs) - 3
    return shown + (f" (+{extra} more)" if extra > 0 else "")


def notify_jobs_rescheduled_bulk(db: Session, jobs, org_id=None) -> int:
    """ONE "your jobs moved" per cleaner when a batch of their jobs is shifted
    together (the weather-day / sick-day bulk reschedule). Shifting a twelve-
    house day one job at a time would fire twelve `notify_job_rescheduled`
    texts at the same person — the over-notification that trains someone to
    silence the channel (brightbase-economy) — so the bulk path suppresses
    update_job's per-job notice and calls this once. It also closes the gap
    where the recurring branch told the assigned crew nothing at all (audit #4).

    Best-effort, event-driven (no tick, R1); push then SMS fallback via
    notify_user_or_sms. The recipient is ON these jobs, so the body may name
    the property (same as _job_line / notify_job_rescheduled). Returns channels
    delivered.
    """
    jobs = [j for j in (jobs or []) if j is not None and (getattr(j, "cleaner_ids", None) or [])]
    if not jobs:
        return 0
    try:
        from database.models import User

        # cleaner_id -> [their moved jobs]. A job with two cleaners rolls up to
        # both; a cleaner with three moved jobs hears once, not three times.
        by_cleaner: dict = {}
        for j in jobs:
            for c in (j.cleaner_ids or []):
                cid = str(c).strip()
                if cid:
                    by_cleaner.setdefault(cid, []).append(j)
        if not by_cleaner:
            return 0

        oid = org_id if org_id is not None else getattr(jobs[0], "org_id", None)
        q = db.query(User).filter(User.cleaner_id.in_(list(by_cleaner.keys())),
                                  User.role == "cleaner")
        if oid is not None:
            # Same tenant guard as the other notify paths: cleaner_id isn't
            # unique across orgs, so never resolve another org's same-ID login.
            q = q.filter(or_(User.org_id == oid, User.org_id.is_(None)))

        sent = 0
        for u in q.all():
            mine = by_cleaner.get(u.cleaner_id) or []
            if not mine:
                continue
            if len(mine) == 1:
                title = "A job of yours moved"
                body = _job_line(mine[0])
                tag = f"job-moved-{mine[0].id}"
            else:
                title = f"{len(mine)} of your jobs moved"
                body = _moved_batch_line(mine)
                # One stable tag for the batch so a re-run replaces, not stacks.
                tag = f"jobs-moved-{min(j.id for j in mine)}-{len(mine)}"
            sent += notify_user_or_sms(u.id, title, body, url="/my-day",
                                       tag=tag, category="job_assignments")
        return sent
    except Exception:  # pragma: no cover - notify must never break scheduling
        logger.exception("bulk reschedule crew notify failed")
        return 0


def _offer_line(job) -> str:
    """"Sat, Sep 12 · 9 AM · Rockport, ME · $180" — town, never the house.

    Deliberately NOT `_job_line`. That one names the property, which is correct
    for somebody already assigned and wrong for an open offer: it is the one
    thing the board withholds until a job is won.
    """
    parts = []
    if getattr(job, "scheduled_date", None):
        parts.append(job.scheduled_date.strftime("%a, %b %-d")
                     if hasattr(job.scheduled_date, "strftime") else str(job.scheduled_date))
    start = _fmt_time_12h(getattr(job, "start_time", None))
    if start:
        parts.append(start)
    prop = getattr(job, "property", None)
    town = " ".join(x for x in [getattr(prop, "city", None),
                                getattr(prop, "state", None)] if x)
    if town:
        parts.append(town)
    rate = getattr(job, "posted_rate", None)
    if rate:
        parts.append(f"${rate:,.0f}" if float(rate).is_integer() else f"${rate:,.2f}")
    return " · ".join(parts) or "New work on the board"


def _cleared_recipients(db: Session, org_id) -> list:
    """Everyone whose file lets them actually take the work.

    Same answer the board and the claim endpoint use, via roster() — THREE
    queries for the whole bench rather than two per person, and one definition
    of "cleared" rather than a third one that could disagree with the other
    two. Pushing an offer to somebody who would be refused at claim time is a
    notification whose only possible outcome is a 403.
    """
    from services.sub_vetting import roster

    return [p for p in roster(db, org_id)["crew"]
            if p.get("can_work") and p.get("user_id")]


def notify_jobs_posted(db: Session, jobs, org_id=None) -> int:
    """Push "on the board" to every cleared sub. Best-effort, swallows all.

    CALLERS PASS ONLY NEWLY-POSTED JOBS. `turnover_windows.open_window` is
    idempotent and re-run by the daily tick, so a caller that passed everything
    currently open would text the whole bench the same Saturday every morning
    until somebody took it.

    A batch is ONE notification, not one per job: a twelve-house changeover day
    posting twelve times is how a person turns notifications off, and then they
    are off for the assignment that matters too.
    """
    jobs = [j for j in (jobs or []) if j is not None]
    if not jobs:
        return 0
    try:
        from services.push_service import notify_user

        # NOT gated on push_enabled() any more. This used to return 0 before it
        # had even looked at the bench, which meant a deploy with no VAPID keys
        # posted work that announced itself to nobody at all — and nothing said
        # so. Push is now one channel of two; the function's job is to reach
        # people, not to send a push.
        oid = org_id if org_id is not None else getattr(jobs[0], "org_id", None)
        people = _cleared_recipients(db, oid)
        if not people:
            return 0

        if len(jobs) == 1:
            job = jobs[0]
            title = "New job on the board"
            body = _offer_line(job)
            tag = f"job-open-{job.id}"
            # Somebody already on the job is not a bidder for it — the board
            # skips these rows for the same reason.
            on_it = {str(c) for c in (getattr(job, "cleaner_ids", None) or [])}
            people = [p for p in people if p.get("cleaner_id") not in on_it]
        else:
            title = f"{len(jobs)} jobs on the board"
            body = _batch_line(jobs)
            # One tag for the batch, so a re-post replaces rather than stacks.
            tag = f"jobs-open-{min(j.id for j in jobs)}-{len(jobs)}"

        # Who has muted open jobs, and who can be texted — ONE query for the
        # whole bench (brightbase-economy: no per-person round trip).
        #
        # The mute has to be read HERE rather than inferred from the push
        # result. notify_user returns 0 both when it could not reach anybody
        # and when the person opted out, so falling back on a zero would text
        # exactly the people who asked not to hear about this.
        contact = _contactable(db, [p["user_id"] for p in people])
        people = [p for p in people if p["user_id"] in contact]

        sent, unreached = 0, []
        for p in people:
            n = notify_user(p["user_id"], title, body, url="/my-day",
                            tag=tag, category="open_jobs")
            sent += n
            if not n:
                unreached.append(p["user_id"])

        # SMS is the FALLBACK, never a second copy: only the people push could
        # not reach. Web push needs the app installed to the home screen and
        # notifications allowed — on an iPhone both, in that order — so on a
        # bench of independent cleaners the set of people it silently fails to
        # reach is large, and they are the ones who never hear about work.
        sent += _sms_offer(unreached, contact, title, body)
        return sent
    except Exception:  # pragma: no cover - notify must never break scheduling
        logger.warning("posted-job announcement failed", exc_info=True)
        return 0


def _contactable(db: Session, user_ids: list) -> dict:
    """{user_id: e164 phone or None} for everyone who has NOT muted open jobs.

    Absent from the map = muted. Present with None = wants to hear, but there
    is no number on file, so push is their only channel.
    """
    from database.models import User
    from services.push_service import category_enabled
    from utils.phone import normalize_e164

    if not user_ids:
        return {}
    rows = (db.query(User.id, User.notification_prefs, User.phone)
            .filter(User.id.in_(user_ids)).all())
    return {uid: normalize_e164(phone)
            for uid, prefs, phone in rows
            if category_enabled(prefs, "open_jobs")}


def _sms_offer(user_ids: list, phones: dict, title: str, body: str) -> int:
    """Text the offer to people push could not reach. Best-effort, per person.

    The BODY IS THE PUSH BODY, deliberately — `_offer_line` / `_batch_line`,
    which carry day, time, town and rate and never the property name or the
    address. That withholding is the board's rule (whose house it is is not a
    bidder's business until they have won it), and a text is if anything more
    exposed than a push: it sits in a message thread forever and is readable
    on a lock screen by anyone holding the phone.
    """
    if not user_ids:
        return 0
    from integrations.twilio_client import configured as sms_configured, send_sms

    if not sms_configured():
        # Same posture as push with no VAPID keys: quietly do nothing rather
        # than raise into a schedule write. Logged so a deploy that has neither
        # channel configured is findable rather than merely silent.
        logger.info("[crew] %d cleared sub(s) unreachable by push and SMS is "
                    "not configured — the board announced itself to nobody",
                    len(user_ids))
        return 0

    from config import app_base_url

    # One segment where it fits. A long link is what pushes this over 160
    # characters, and a two-segment text costs double for the same sentence —
    # worth knowing, not worth dropping the link for: without somewhere to tap,
    # the message is a notification the person cannot act on.
    text = f"{title}: {body}. Ask for it here: {app_base_url()}/my-day"

    sent = 0
    for uid in user_ids:
        phone = phones.get(uid)
        if not phone:
            continue
        try:
            send_sms(to=phone, body=text)
            sent += 1
        except (ValueError, RuntimeError) as e:
            # One bad number or a Twilio outage must not cost the rest of the
            # bench their message. Matches the reminder service's posture.
            logger.warning("[crew] open-job SMS to user %s failed: %s", uid, e)
    return sent


def _batch_line(jobs) -> str:
    """"Sat, Sep 12 · Rockport, Camden · from $180"."""
    parts = []
    days = {j.scheduled_date for j in jobs if getattr(j, "scheduled_date", None)}
    if len(days) == 1:
        d = days.pop()
        parts.append(d.strftime("%a, %b %-d") if hasattr(d, "strftime") else str(d))
    towns = []
    for j in jobs:
        prop = getattr(j, "property", None)
        town = getattr(prop, "city", None) if prop is not None else None
        if town and town not in towns:
            towns.append(town)
    if towns:
        parts.append(", ".join(towns[:3]) + (" and more" if len(towns) > 3 else ""))
    rates = [float(j.posted_rate) for j in jobs if getattr(j, "posted_rate", None)]
    if rates:
        low = min(rates)
        money = f"${low:,.0f}" if low.is_integer() else f"${low:,.2f}"
        parts.append(money if len(set(rates)) == 1 else f"from {money}")
    return " · ".join(parts) or "New work on the board"
