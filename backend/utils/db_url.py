"""Canonical DATABASE_URL normalization — one place, on purpose.

BB-DEPS-03. Five call sites used to each do their own
``url.replace("postgres://", "postgresql://", 1)``: database/db.py,
alembic/env.py, scripts/reconcile_prod_schema.py and two Postgres test
modules. That is the same shape as the bug ``utils/dates.py`` documents (the
scheduling and recurring routers each had their own time parser and they
drifted), and it got worse with psycopg 3: a driver change has to land in
every one of those sites or the ones left behind fail at ``create_engine``.
So there is one function now, and new Postgres entry points call it.

WHY THE DRIVER IS EXPLICIT. We run psycopg 3 (``psycopg[binary]``), and a bare
``postgresql://`` does NOT pin a driver — SQLAlchemy picks a default, and that
default is version-dependent:

  * SQLAlchemy 2.0.x resolves ``postgresql://`` to **psycopg2**, which we no
    longer install -> ``ModuleNotFoundError: No module named 'psycopg2'``;
  * SQLAlchemy 2.1.x resolves it to **psycopg** (3).

Either way the app's own URL would depend on which SQLAlchemy happens to be
pinned. That is not a theoretical risk: it is exactly how dependabot #1034
would have broken the Railway deploy — SQLAlchemy 2.1 flipped the default to
psycopg 3 while only psycopg2-binary was installed, and the engine could not
be constructed at all. Spelling the driver out makes the URL mean one thing on
every SQLAlchemy version.

Railway supplies ``postgres://`` (the historic libpq alias, which SQLAlchemy
has never accepted), so that is folded in here too rather than at each caller.
"""

import re

# postgres:// (Railway's alias), or postgresql:// with no +driver.
_BARE_PG = re.compile(r"^postgres(?:ql)?://")
# An explicit psycopg2 driver, which is no longer installed.
_PSYCOPG2 = re.compile(r"^postgresql\+psycopg2://")

DRIVER = "postgresql+psycopg"


def normalize_db_url(raw: str) -> str:
    """Return `raw` with the Postgres driver spelled out explicitly.

    Leaves anything that is not Postgres alone — sqlite:// URLs (local dev and
    the test suite) pass through untouched, as does an explicit non-psycopg
    driver such as postgresql+asyncpg://, which is a deliberate choice rather
    than an unset default.
    """
    url = (raw or "").strip()
    if not url:
        return url
    # An explicit +psycopg2 is rewritten rather than respected: psycopg2 is not
    # installed, so honoring it would just fail at create_engine with a less
    # obvious error than this rewrite would ever cause.
    if _PSYCOPG2.match(url):
        return _PSYCOPG2.sub(f"{DRIVER}://", url, count=1)
    if _BARE_PG.match(url):
        return _BARE_PG.sub(f"{DRIVER}://", url, count=1)
    return url
