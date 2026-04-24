"""Test Visit ORM model can be created with all VisitCreate fields."""
import pytest
from datetime import date, time
from database.models import Visit, Job
from database.db import SessionLocal


def test_visit_can_be_created_with_all_fields():
    """Verify Visit ORM model has all columns needed by VisitCreate schema.

    This test catches schema drift between Pydantic models and SQLAlchemy ORM.
    If this fails, backfill and other Visit creation will fail with:
    'field_name is an invalid keyword argument for Visit'
    """
    db = SessionLocal()
    try:
        # Create a test job first (required foreign key)
        job = Job(
            client_id=1,
            title="Test Job",
            scheduled_date=date.today(),
            start_time=time(9, 0),
            end_time=time(12, 0),
            status="scheduled"
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        # Now create a Visit with all supported fields (sequence and checklist_template_id removed)
        visit = Visit(
            job_id=job.id,
            scheduled_date=date.today(),
            start_time=time(9, 0),
            end_time=time(12, 0),
            status="scheduled",
            cleaner_ids=[],
            gcal_event_id=None,
            ical_source=None,
            ical_uid=None,
            notes=None
        )
        db.add(visit)
        db.commit()
        db.refresh(visit)

        # Verify it was created
        assert visit.id is not None
        assert visit.job_id == job.id
        assert visit.scheduled_date == date.today()
        assert visit.status == "scheduled"

    finally:
        db.close()


if __name__ == "__main__":
    test_visit_can_be_created_with_all_fields()
    print("✓ Visit model test passed")
