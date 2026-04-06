"""
Conflict detection for cleaning job scheduling.

Checks for:
  1. Cleaner double-booking — same cleaner assigned to overlapping time slots
  2. Property double-booking — two jobs at the same property on the same day at overlapping times
"""

from sqlalchemy.orm import Session
from database.models import Job


def _time_to_minutes(t: str) -> int:
    """Convert HH:MM to minutes since midnight."""
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _times_overlap(start1: str, end1: str, start2: str, end2: str) -> bool:
    """Check if two time ranges overlap."""
    s1, e1 = _time_to_minutes(start1), _time_to_minutes(end1)
    s2, e2 = _time_to_minutes(start2), _time_to_minutes(end2)
    return s1 < e2 and s2 < e1


def check_conflicts(
    db: Session,
    scheduled_date: str,
    start_time: str,
    end_time: str,
    cleaner_ids: list[str] | None = None,
    property_id: int | None = None,
    exclude_job_id: int | None = None,
) -> list[dict]:
    """
    Check for scheduling conflicts. Returns a list of conflict descriptions.
    Empty list = no conflicts.
    """
    if not scheduled_date or not start_time or not end_time:
        return []

    conflicts = []

    # Get all jobs on the same date (excluding cancelled and the current job if editing)
    q = db.query(Job).filter(
        Job.scheduled_date == scheduled_date,
        Job.status != "cancelled",
    )
    if exclude_job_id:
        q = q.filter(Job.id != exclude_job_id)
    same_day_jobs = q.all()

    for existing in same_day_jobs:
        if not existing.start_time or not existing.end_time:
            continue
        if not _times_overlap(start_time, end_time, existing.start_time, existing.end_time):
            continue

        # Check cleaner overlap
        if cleaner_ids:
            existing_cleaners = set(existing.cleaner_ids or [])
            overlapping_cleaners = set(cleaner_ids) & existing_cleaners
            if overlapping_cleaners:
                conflicts.append({
                    "type": "cleaner_double_booking",
                    "severity": "error",
                    "message": f"Cleaner(s) {', '.join(overlapping_cleaners)} already assigned to \"{existing.title}\" at {existing.start_time}–{existing.end_time}",
                    "conflicting_job_id": existing.id,
                    "conflicting_job_title": existing.title,
                    "overlapping_cleaners": list(overlapping_cleaners),
                })

        # Check property overlap
        if property_id and existing.property_id == property_id:
            conflicts.append({
                "type": "property_double_booking",
                "severity": "warning",
                "message": f"Property already has \"{existing.title}\" scheduled at {existing.start_time}–{existing.end_time}",
                "conflicting_job_id": existing.id,
                "conflicting_job_title": existing.title,
            })

    return conflicts
