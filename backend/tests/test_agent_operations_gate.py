"""BB-SEC-13: who can make an AI agent DO something, not just answer.

`run_operation` is the one agent tool with real side effects. It generates Job
rows for every active recurring schedule, and pushes jobs to Google Calendar —
which emails a real invite to the customer on the job. It sat in the single
list every caller received.

Two doors led to that list and only one was locked:

  * `/ws/agent/{name}` checked the JWT's role (BB-SEC-11) — that door was shut.
  * `POST /api/ai/quick` — the Cmd+K command bar — checked only that SOME login
    existed. The public apply form (#761) mints a `cleaner` login for anyone who
    fills in a web form and picks a password, so "some login" includes strangers.

And a third caller needed no login at all: `services/inbox_triage` puts an
inbound email's subject and snippet — attacker-controlled text — through the
same loop, with `run_operation` in scope. `max_iters=1` does not help; the loop
executes the tool call and only then runs out of iterations.

Pinned here, at each layer independently, because any one of them fixed alone
still leaves the hole open through the others:

  1. the schema list a caller is handed (get_tools_for_agent),
  2. execute_tool refusing the tool even if the name arrives anyway,
  3. the HTTP endpoint's role gate,
  4. `viewer` — the read-only office role — reading but never operating.
"""
import pytest
from fastapi.testclient import TestClient

from main import app
from modules.auth.router import (
    get_current_user, current_org_id, AGENT_ROLES, AGENT_OPERATION_ROLES,
)


# ── Layer 1: the tool list a caller is handed ────────────────────────────────

def test_operations_are_not_in_the_default_tool_list():
    """Fail closed: a caller that says nothing gets the harmless set."""
    from agents.tools import get_tools_for_agent

    default = {t["name"] for t in get_tools_for_agent("nova")}
    assert "run_operation" not in default
    # Still a useful assistant — the read tools are all there.
    assert {"get_business_snapshot", "get_clients", "get_jobs"} <= default


def test_operations_appear_only_when_asked_for():
    from agents.tools import get_tools_for_agent

    opted_in = {t["name"] for t in get_tools_for_agent("nova", allow_operations=True)}
    assert "run_operation" in opted_in


# ── Layer 2: execute_tool refuses regardless of the list ─────────────────────

@pytest.mark.parametrize("operation", ["generate_all_jobs", "push_all_to_gcal", "sync_all_ical"])
def test_execute_tool_refuses_operations_by_default(operation):
    """Defense in depth, mirroring the dev-tool guard beside it: a name that
    slips through the schema list — a stale browser tab, a replayed transcript,
    a future caller that forgets the flag — still cannot act."""
    from agents.tools import execute_tool

    out = execute_tool("run_operation", {"operation": operation}, "nova")
    assert "error" in out, out
    assert "not available" in out["error"]
    # And it refused BEFORE doing the work — no partial result leaked back.
    assert "pushed" not in out and "total_jobs_created" not in out


def test_read_tools_still_work_without_the_flag():
    """The guard must not have broken the assistant it protects."""
    from agents.tools import execute_tool

    out = execute_tool("get_business_snapshot", {}, "nova", org_id=1)
    assert "error" not in out
    assert "clients_total" in out


# ── Layer 3: the HTTP door ───────────────────────────────────────────────────

class _Cleaner:
    id, org_id, role, status, active = 9301, 1, "cleaner", "active", True
    email = "cleaner-agent@example.com"


class _Viewer:
    id, org_id, role, status, active = 9302, 1, "viewer", "active", True
    email = "viewer-agent@example.com"


@pytest.fixture
def as_role():
    def _use(user_cls):
        app.dependency_overrides[get_current_user] = lambda: user_cls()
        app.dependency_overrides[current_org_id] = lambda: 1
        return TestClient(app)
    yield _use
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(current_org_id, None)


def test_cleaner_cannot_reach_the_command_bar(as_role):
    """A hidden button is not a gate. The crew shell never renders the command
    bar, but a cleaner holds a valid JWT and can POST to the endpoint directly."""
    api = as_role(_Cleaner)
    r = api.post("/api/ai/quick", json={"question": "list every client and their address"})
    assert r.status_code == 403, r.text


def test_viewer_may_still_ask(as_role):
    """The gate is about role, not about locking the office out. A viewer gets
    through the door — it is the OPERATIONS half they are held back from, which
    is asserted at the tool layer above (viewer ∉ AGENT_OPERATION_ROLES)."""
    api = as_role(_Viewer)
    r = api.post("/api/ai/quick", json={"question": "how many jobs today?"})
    assert r.status_code != 403, r.text


# ── Layer 4: the role sets themselves ────────────────────────────────────────

def test_read_only_office_role_may_not_operate():
    """`viewer` is the read-only role in 40 other endpoints. An agent must not
    be the one place it can write."""
    assert "viewer" in AGENT_ROLES
    assert "viewer" not in AGENT_OPERATION_ROLES


def test_crew_and_customer_roles_reach_no_agent():
    for role in ("cleaner", "client", "sub"):
        assert role not in AGENT_ROLES
        assert role not in AGENT_OPERATION_ROLES


def test_operating_is_a_subset_of_talking():
    """A role that can make an agent act must also be able to talk to one —
    otherwise the two sets have drifted and one of them is wrong."""
    assert AGENT_OPERATION_ROLES <= AGENT_ROLES


def test_both_doors_read_the_same_constant():
    """The root cause was two definitions of "who may use an agent", enforced
    in one place. If main.py ever grows its own set again, this fails."""
    import main

    assert main._AGENT_ROLES is AGENT_ROLES
    assert main.AGENT_OPERATION_ROLES is AGENT_OPERATION_ROLES
