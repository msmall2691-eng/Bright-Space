"""The dead placeholder Job.assigned_cleaner_user_id column and its
User.jobs_assigned relationship were dropped by migration 040. Pin that
they stay dropped — the column had sat unread since migration 001 and
had a "Future: replace cleaner_ids JSON" comment that never materialized.
"""
from database.models import Job, User


def test_job_has_no_assigned_cleaner_user_id_column():
    assert "assigned_cleaner_user_id" not in Job.__table__.columns


def test_job_has_no_assigned_cleaner_relationship():
    assert not hasattr(Job, "assigned_cleaner")


def test_user_has_no_jobs_assigned_relationship():
    assert not hasattr(User, "jobs_assigned")
