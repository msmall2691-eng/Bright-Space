# Backend type checking

We use [mypy](https://mypy-lang.org/) for static type checking on the
modules where we've churned the most — `modules/scheduling/` and
`modules/recurring/`. The goal is to catch real bugs (the first run
already surfaced a never-imported `pytz.UTC` reference that would
NameError at runtime) without forcing every FastAPI route handler to be
fully annotated in one PR.

## Run it

```bash
cd backend
pip install -r requirements-dev.txt    # one-time
mypy --config-file mypy.ini
```

Expected: `Success: no issues found in 5 source files`. CI doesn't
gate on this yet — running locally before opening a PR is the
recommended workflow.

## Configuration

See `backend/mypy.ini`. Key choices:

- `files = modules/scheduling, modules/recurring` — limits the typed
  surface to the two modules we've actively worked on.
- `ignore_missing_imports = True` — third-party packages without
  bundled stubs (icalendar, pytz, twilio, etc.) don't fail the run.
- `[mypy-database.*] follow_imports = skip` — same for first-party
  modules outside the typed surface, so imports don't drag in errors
  from un-typed code.
- `disable_error_code = ...` lists six categories that aren't
  blockers today (FastAPI's untyped decorators, missing return
  annotations on route handlers, etc.).
- The error codes we **do** check catch real bugs:
  `name-defined`, `arg-type`, `return-value`, `assignment`,
  `operator`, `index`, `no-any-return`.

## Tightening over time

When you have a quiet hour, remove entries from `disable_error_code`
in this order — each step reveals the next layer of issues:

1. **`no-untyped-call`** — first type the public helpers
   (`require_role`, `get_current_user`) so callers can be checked.
2. **`no-untyped-def`** — annotate route handler return types
   (mostly `dict[str, Any]` or `list[JobResponse]`).
3. **`type-arg`** — replace bare `dict` / `list` with concrete
   generics. Ideally pair with `from __future__ import annotations`
   so annotations stay readable.
4. **`untyped-decorator`** — usually the last to drop. Requires
   either a Mypy plugin for FastAPI or accepting that route
   handler return types are erased through `@app.get(...)`.

Each PR that drops one entry should run `mypy --config-file mypy.ini`
and fix whatever surfaces. Errors per layer are typically 20-100;
spread across a session.

## Adding a new module to the typed surface

Append to the `files = ...` line in `mypy.ini`. Then run mypy and
triage. If the module imports a lot from outside the typed scope,
consider adding `[mypy-<module>.*] follow_imports = skip` for the
external dependencies until they're typed too.
