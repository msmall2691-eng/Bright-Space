"""
iCal (.ics) file generator for client calendar invites.
Generates a standards-compliant iCal file that works with
Google Calendar, Apple Calendar, Outlook — anything.
"""

from icalendar import Calendar, Event, vText
from datetime import datetime, date
import uuid
import os


def generate_job_ics(job: dict, client: dict, organizer_email: str = None) -> bytes:
    """
    Generate an .ics file for a job that clients can add to any calendar.
    Returns the raw .ics bytes.
    """
    cal = Calendar()
    cal.add("prodid", "-//The Maine Cleaning Co.//BrightBase//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("method", "REQUEST")  # REQUEST = invite, PUBLISH = informational

    event = Event()

    # Unique ID — use job id so re-generating is idempotent
    event.add("uid", f"brightbase-job-{job['id']}@mainecleaningco.com")

    # Title
    event.add("summary", job["title"])

    # Location
    if job.get("address"):
        event.add("location", job["address"])

    # Description
    lines = [
        f"Cleaning appointment with The Maine Cleaning Co.",
    ]
    if job.get("notes"):
        lines.append(f"\nNotes: {job['notes']}")
    lines.append("\nQuestions? Call or text us anytime.")
    event.add("description", "\n".join(lines))

    # Start / end times (America/New_York)
    from icalendar import vDatetime
    date_str = job["scheduled_date"]  # YYYY-MM-DD
    start_str = job["start_time"]      # HH:MM
    end_str   = job["end_time"]        # HH:MM

    sy, sm, sd = map(int, date_str.split("-"))
    sh, smin = map(int, start_str.split(":"))
    eh, emin = map(int, end_str.split(":"))

    start_dt = datetime(sy, sm, sd, sh, smin, 0)
    end_dt   = datetime(sy, sm, sd, eh, emin, 0)

    event.add("dtstart", start_dt)
    event.add("dtend",   end_dt)
    event.add("dtstamp", datetime.utcnow())

    # Organizer (the cleaning company)
    org_email = organizer_email or os.getenv("SMTP_USER") or "office@mainecleaningco.com"
    event["organizer"] = vText(f"MAILTO:{org_email}")

    # Attendee (the client)
    if client.get("email"):
        event["attendee"] = vText(f"MAILTO:{client['email']}")

    # Reminder — 24hrs before via email, 1hr via popup
    from icalendar import Alarm
    from datetime import timedelta

    for method, delta in [("EMAIL", timedelta(hours=24)), ("DISPLAY", timedelta(hours=1))]:
        alarm = Alarm()
        alarm.add("action", method)
        alarm.add("trigger", -delta)
        if method == "EMAIL":
            alarm.add("summary", f"Reminder: {job['title']} tomorrow")
            alarm.add("description", f"Your cleaning appointment is tomorrow at {start_str}.")
        else:
            alarm.add("description", f"Cleaning in 1 hour: {job['title']}")
        event.add_component(alarm)

    cal.add_component(event)
    return cal.to_ical()
