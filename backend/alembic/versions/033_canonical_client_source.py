"""
Alembic migration: canonicalize clients.source
Alembic version: 033

`source` had drifted into free text (`website` vs `Website`, plus internal
markers like `gcal_instance`, `xlsx_import`, `parsed_from_id`, `merge`,
`completed/cancelled visit`). This backfills every row onto the canonical set
  website | sms | email | referral | manual | ical | phone | unknown
matching utils.source.normalize_source() and the new model validator that keeps
future writes canonical. Anything unrecognized (and NULL/blank) becomes 'unknown'.

Data migration — downgrade can't restore the original free text, so it's a no-op.
"""
from alembic import op
import sqlalchemy as sa


revision = "033_canonical_client_source"
down_revision = "032_perf_indexes"
branch_labels = None
depends_on = None

_CANONICAL = ("website", "sms", "email", "referral", "manual", "ical", "phone", "unknown")

# canonical -> the lowercased/trimmed variants that map onto it
_MAP = {
    "website": ("website", "web"),
    "email": ("email", "gmail"),
    "sms": ("sms", "twilio", "text"),
    "phone": ("phone", "call", "phone_call"),
    "referral": ("referral",),
    "manual": ("manual", "xlsx", "xlsx_import", "import", "merge"),
    "ical": ("ical", "gcal", "google", "gcal_instance", "gcal_all_day", "calendar"),
}


def upgrade() -> None:
    conn = op.get_bind()
    for canonical, variants in _MAP.items():
        conn.execute(
            sa.text(
                "UPDATE clients SET source = :c "
                "WHERE lower(trim(source)) IN :variants"
            ).bindparams(sa.bindparam("variants", expanding=True)),
            {"c": canonical, "variants": list(variants)},
        )
    # Everything left that isn't already canonical (incl. NULL / blank) → unknown.
    conn.execute(
        sa.text(
            "UPDATE clients SET source = 'unknown' "
            "WHERE source IS NULL OR trim(source) = '' OR source NOT IN :canon"
        ).bindparams(sa.bindparam("canon", expanding=True)),
        {"canon": list(_CANONICAL)},
    )


def downgrade() -> None:
    # Irreversible data normalization.
    pass
