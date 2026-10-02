"""Exactly one Alembic head, and a message that says what to do about it.

WHY THIS EXISTS AS ITS OWN TEST. The revision graph forked twice in one
afternoon: #1002 was written as 122 off 121, #1001 landed its own 122 off the
same 121, and after that was linearized to 124, #1006 landed ITS own 124 off
123. Both times git merged without a murmur — the files have different names,
so there is no textual conflict — and both times each branch was a clean linear
chain on its own, so CI was green on both sides right up to the merge.

It WAS caught, indirectly, by `test_schema_drift.py` and
`test_migrations_from_scratch.py`: the first fails because the drift check
cannot resolve a head, the second because `alembic upgrade head` refuses to
run. Both report it as a confusing secondary symptom ("head revision should
resolve", `assert 'error' == 'behind'`) rather than the thing that is actually
wrong, and the second needs a Postgres service to even run.

So this is the same bug with a name on it: fast, dialect-free, no database, and
it fails saying which revisions forked and how to fix it.

WHAT IT CANNOT DO, and this is worth being precise about because the obvious
"fix" does not work. Switching to Alembic's generated hash revision ids would
stop two FILES claiming the same number, but it would not stop this: a fork is
two revisions sharing a `down_revision`, and two branches that each add a
migration off the current head produce exactly that whatever the ids look like.
There is no way to make parallel migration branches not fork. The fork is a
merge-time reconciliation task, and the only real defences are a guard that
names it immediately (this test) and rechaining promptly when it fires.
"""
import os
import re

VERSIONS_DIR = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")


def _graph():
    """{revision: (filename, [parent revisions])} read from the files.

    Parsed rather than loaded through Alembic's ScriptDirectory on purpose:
    this test must work with no DATABASE_URL, no engine and no config, so it
    stays runnable in the one situation you most want it — a merge you have
    not deployed yet.

    `down_revision` is captured as a whole expression because a merge revision
    carries a TUPLE of parents. Matching only a quoted string would miss those
    parents entirely and invent phantom heads (the repo has three real merge
    revisions in its history, so this is not hypothetical).
    """
    graph = {}
    for name in sorted(os.listdir(VERSIONS_DIR)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(VERSIONS_DIR, name), encoding="utf-8") as fh:
            src = fh.read()
        rev = re.search(r'^revision\s*=\s*["\']([^"\']+)', src, re.M)
        if not rev:
            continue
        down = re.search(r"^down_revision\s*=\s*(.+)$", src, re.M)
        parents = re.findall(r'["\']([^"\']+)["\']', down.group(1)) if down else []
        graph[rev.group(1)] = (name, parents)
    return graph


def test_exactly_one_alembic_head():
    graph = _graph()
    assert graph, "no Alembic revisions found — is the versions directory right?"

    all_parents = {p for _f, ps in graph.values() for p in ps}
    heads = sorted(r for r in graph if r not in all_parents)

    if len(heads) != 1:
        # Children by parent, so a split is visible.
        children = {}
        for rev, (fname, parents) in graph.items():
            for p in parents:
                children.setdefault(p, []).append(rev)

        # ONLY THE UNRESOLVED SPLITS. This repo's history contains three real
        # merge revisions (055->056 and 056->057 both split and were merged by
        # 057_merge_056_heads), so a naive "any parent with two children" list
        # reports long-settled history alongside the actual problem and buries
        # the one line that matters. A split is resolved when its children all
        # funnel back to the same head; it is the fork you have to fix only
        # when they reach different ones.
        memo = {}

        def reachable_heads(rev):
            if rev in memo:
                return memo[rev]
            memo[rev] = frozenset()          # cycle guard
            kids = children.get(rev, [])
            out = frozenset([rev]) if not kids else frozenset().union(
                *(reachable_heads(k) for k in kids))
            memo[rev] = out
            return out

        splits = {}
        for parent, kids in children.items():
            if len(kids) < 2:
                continue
            if len({reachable_heads(k) for k in kids}) > 1:
                splits[parent] = [f"{k} ({graph[k][0]})" for k in kids]

        raise AssertionError(
            "The Alembic revision graph has %d heads, not 1: %s\n\n"
            "This breaks `alembic upgrade head` and, left alone, breaks the "
            "Railway deploy rather than anybody's laptop.\n\n"
            "Revisions sharing a parent (the fork):\n%s\n\n"
            "FIX: pick the order deliberately — whatever is already on main "
            "goes first — then rewire the later migration's `down_revision` to "
            "chain behind it and renumber its file to match. Do NOT run "
            "`alembic merge`: it works, but it makes the history a graph "
            "instead of a list permanently, and a graph is harder to reason "
            "about at 11pm. Re-run this test, then replay from an empty "
            "database before deploying."
            % (
                len(heads),
                ", ".join(f"{h} ({graph[h][0]})" for h in heads),
                "\n".join(f"  {p} -> {', '.join(kids)}" for p, kids in splits.items())
                or "  (no unresolved split found — a revision may name a "
                   "down_revision that does not exist; see the dangling-parent "
                   "test below)",
            )
        )


def test_every_down_revision_points_at_a_real_revision():
    """A typo'd or deleted parent is the other way the chain breaks, and it
    fails at a completely different place (Alembic cannot walk the graph) with
    a message that does not mention the typo."""
    graph = _graph()
    known = set(graph)
    dangling = {
        f"{rev} ({fname})": [p for p in parents if p not in known]
        for rev, (fname, parents) in graph.items()
        if any(p not in known for p in parents)
    }
    assert not dangling, (
        "These revisions name a `down_revision` that does not exist: %s\n"
        "Usually a hand-edited id or a deleted migration." % dangling
    )
