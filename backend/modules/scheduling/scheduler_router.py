"""
Scheduler status & control API endpoints.
Admins can view status, trigger manual runs, and see task history.
"""

from fastapi import APIRouter

from scheduler import get_status, run_task_now

router = APIRouter()


@router.get("/status")
def scheduler_status():
    """Get the current scheduler status and last-run info for each automated task."""
    return get_status()


@router.post("/run/{task_name}")
def trigger_task(task_name: str):
    """Manually trigger a scheduler task. Valid names: ical_sync, recurring_generation, daily_reminders, gcal_push."""
    result = run_task_now(task_name)
    return result
