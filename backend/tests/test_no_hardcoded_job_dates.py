"""A test that schedules a job must not hardcode the date.

`create_job` → `_validate_job_timing(..., is_new=True)` rejects a date before
`business_today()`: "Cannot schedule a job in the past". A literal date in a
create-path test therefore passes right up until the calendar reaches it, and
then fails forever, on a commit that changed nothing.

That is not hypothetical. On 2026-10-06 the curated suite went red on `main`
with no code change, because `test_audit_gaps_quote_to_schedule.py` had
scheduled a job on `"2026-10-05"`. Two more were queued behind it:
`test_quick_schedule_property.py` ("2026-12-15") and `test_freebusy_guard.py`
("2026-12-16") would have gone red on 2026-12-16 and 2026-12-17.

Three sites, three separate future outages, one shape. So the shape is what
this file tests. The fix at each was the same and is the required idiom:

    scheduled_date=(business_today() + timedelta(days=7)).isoformat()

## What this deliberately does NOT flag

Only the **create** path guards. `update_job` passes `is_new=False`, because
editing an old job (marking it completed, correcting last month's record) has
to stay possible — so a literal date in an update test is fine and several are
load-bearing. Likewise a literal handed straight to a helper that does no date
validation (`free_busy_conflicts`, the iCal parsers) is an *input*, not a time
bomb. Flagging those would make this test a nuisance that the next person
turns off.

So the rule is narrow on purpose: a literal `scheduled_date` reaching
`JobCreate(...)` or `POST /api/jobs`.
"""
import ast
import re
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_TESTS = [TESTS_DIR, TESTS_DIR.parent]

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _is_literal_date(node) -> bool:
    """A `'2026-12-15'` string, or a `date(2026, 12, 15)` of plain integers."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return bool(DATE_RE.match(node.value))
    if isinstance(node, ast.Call):
        fn = node.func
        name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
        if name in ("date", "datetime"):
            return all(isinstance(a, ast.Constant) and isinstance(a.value, int)
                       for a in node.args) and len(node.args) >= 3
    return False


def _call_name(node: ast.Call) -> str | None:
    fn = node.func
    if isinstance(fn, ast.Attribute):
        return fn.attr
    return getattr(fn, "id", None)


def _offenders_and_sites(path: Path):
    """Return (offending (line, source) pairs, number of create sites seen).

    The second value is the non-vacuity guard: if the AST walk stops finding
    JobCreate calls — renamed class, moved tests, a bug in this scanner — the
    test must fail loudly rather than pass because it inspected nothing.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return [], 0

    offenders, sites = [], 0

    def check_keyword(kw, line):
        if kw.arg == "scheduled_date" and _is_literal_date(kw.value):
            offenders.append((line, ast.unparse(kw)))

    def check_dict(d: ast.Dict, line):
        for k, v in zip(d.keys, d.values):
            if (isinstance(k, ast.Constant) and k.value == "scheduled_date"
                    and _is_literal_date(v)):
                offenders.append((line, f"scheduled_date={ast.unparse(v)}"))

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)

        # JobCreate(..., scheduled_date=...) — the direct create path.
        if name == "JobCreate":
            sites += 1
            for kw in node.keywords:
                check_keyword(kw, node.lineno)

        # client.post("/api/jobs", json={"scheduled_date": ...}) — same guard,
        # reached over HTTP. No call site uses this shape today; it is covered
        # so that adding one does not quietly reopen the hole.
        elif name == "post" and node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and first.value == "/api/jobs":
                sites += 1
                for kw in node.keywords:
                    if kw.arg == "json" and isinstance(kw.value, ast.Dict):
                        check_dict(kw.value, node.lineno)

    return offenders, sites


def _test_files():
    seen = set()
    for root in REPO_TESTS:
        for p in sorted(root.glob("test_*.py")):
            if p.resolve() not in seen:
                seen.add(p.resolve())
                yield p


def test_no_create_path_test_hardcodes_a_scheduled_date():
    found, sites = [], 0
    for path in _test_files():
        offenders, n = _offenders_and_sites(path)
        sites += n
        for line, src in offenders:
            found.append(f"{path.name}:{line}  {src}")

    assert sites > 0, (
        "scanned every test_*.py and found no JobCreate / POST /api/jobs call "
        "at all — this guard is inspecting nothing, so fix the scanner before "
        "trusting it"
    )

    assert not found, (
        "These tests schedule a job on a hardcoded date. create_job rejects a "
        "past date, so each one goes red the day the calendar passes it:\n  "
        + "\n  ".join(found)
        + "\n\nUse a relative date instead:\n"
          "    scheduled_date=(business_today() + timedelta(days=7)).isoformat()"
    )


def test_the_scanner_actually_recognises_the_bug_it_is_looking_for(tmp_path):
    """Non-vacuity, the other way round: feed it the exact code that broke.

    Without this, a scanner that silently matched nothing would make the test
    above pass forever. Each case below is a real shape from the outage.
    """
    sample = tmp_path / "test_sample.py"
    sample.write_text(
        "from modules.scheduling.router import create_job, JobCreate\n"
        "def test_a():\n"
        "    create_job(JobCreate(client_id=1, scheduled_date='2026-10-05'))\n"
        "def test_b():\n"
        "    create_job(JobCreate(client_id=1, scheduled_date=date(2026, 12, 15)))\n"
        "def test_c():\n"
        "    client.post('/api/jobs', json={'scheduled_date': '2026-12-16'})\n",
        encoding="utf-8",
    )
    offenders, sites = _offenders_and_sites(sample)
    assert sites == 3
    assert len(offenders) == 3, offenders

    # And it leaves the legitimate forms alone: a relative date, an update, and
    # a literal passed to a helper that does no date validation.
    ok = tmp_path / "test_ok.py"
    ok.write_text(
        "def test_relative():\n"
        "    create_job(JobCreate(client_id=1,\n"
        "        scheduled_date=(business_today() + timedelta(days=7)).isoformat()))\n"
        "def test_update_may_use_a_past_date():\n"
        "    update_job(1, JobUpdate(scheduled_date='2026-09-08'))\n"
        "def test_helper_input_is_not_a_time_bomb():\n"
        "    assert gcal.free_busy_conflicts('residential', '2026-12-15', '09:00', '12:00') == []\n",
        encoding="utf-8",
    )
    offenders, sites = _offenders_and_sites(ok)
    assert offenders == [], offenders
    assert sites == 1          # the one JobCreate, correctly written


@pytest.mark.parametrize("src,expected", [
    ("'2026-12-15'", True),
    ("'2026-12-15T09:00:00'", True),
    ("date(2026, 12, 15)", True),
    ("dt.date(2026, 12, 15)", True),
    ("'tomorrow'", False),
    ("''", False),
    ("soon", False),
    ("(business_today() + timedelta(days=7)).isoformat()", False),
    ("date.today() + timedelta(days=7)", False),
    ("business_today()", False),
])
def test_literal_date_detection(src, expected):
    assert _is_literal_date(ast.parse(src, mode="eval").body) is expected
