# Manual / parked test scripts

These files live outside the CI-run test suite (`backend/tests/`). Each is a
standalone script that either:

- assumes a specific DB bootstrap it does itself at import time (so it can't
  share a pytest process cleanly with the tests/ package),
- exercises an end-to-end workflow that hits real HTTP endpoints and needs the
  server running, or
- was written pre-`tests/conftest.py` and predates the API-key-required auth
  middleware.

They are pytest-collectable and still useful for hand-verification during a
migration or a workflow rewrite — hence "manual tests" rather than "delete."

## How to run one

From `backend/`, with the app's DB env vars set:

```bash
DATABASE_URL=... python -m pytest scripts/manual_tests/test_ical_auto_sync.py -v
```

If a script relies on the running app (test_pipeline, test_maineclean_workflow,
test_public_quote_flow), start `uvicorn main:app` in another shell first and
set `BRIGHTBASE_API_KEY` for the client-side calls.

## What's here

- **test_ical_auto_sync.py** — iCal auto-sync scheduler unit tests (pre-mocks
  `integrations.google_calendar` at module load, which conflicts with the
  shared-fixture setup in `tests/conftest.py`).
- **test_pipeline.py** — website booking → intake → quote → job pipeline test.
  Hits the running server via HTTP.
- **test_maineclean_workflow.py** — full E2E: booking form → intake →
  operator-created quote → email + SMS delivery.
- **test_contact_phone_backwards.py** — retroactive linking of SMS
  conversations to clients when a matching phone is added after the messages
  arrived.
- **test_public_quote_flow.py** — public quote accept flow (Item A).

## Adding to the CI suite

If you refactor one of these to work under `tests/conftest.py`'s shared
fixtures (schema-per-session + auto API-key injection), move it into
`backend/tests/` and add it to `pytest.ini`'s `testpaths` list.
