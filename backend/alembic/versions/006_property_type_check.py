"""Add a CHECK constraint on properties.property_type.

Today the column is a free `String` with a Python-side default of
'residential'. Three values are intended: 'residential', 'commercial',
'str'. A typo writes silently. This migration:

1. Defensively normalizes any pre-existing out-of-range value to
   'residential' so the constraint can apply cleanly.
2. Adds a CHECK constraint enforcing the three known values.

The constraint is named `ck_properties_property_type` so a downgrade
can drop it by name. Postgres-only; SQLite tolerates the constraint
but doesn't enforce it the same way (acceptable — the production DB
is Postgres on Railway).
"""
from alembic import op
from sqlalchemy import text

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()

    # 1. Normalize any unexpected values so the CHECK can be added without
    #    a violation. Logs each row so we know if any showed up.
    bad = bind.execute(text("""
        SELECT id, name, property_type
        FROM properties
        WHERE property_type IS NULL
           OR property_type NOT IN ('residential', 'commercial', 'str')
    """)).fetchall()
    for row in bad:
        print(f"[006] Normalizing property id={row[0]} name={row[1]!r} "
              f"property_type={row[2]!r} -> 'residential'")
    if bad:
        bind.execute(text("""
            UPDATE properties
            SET property_type = 'residential'
            WHERE property_type IS NULL
               OR property_type NOT IN ('residential', 'commercial', 'str')
        """))

    # 2. Add the CHECK constraint.
    op.create_check_constraint(
        "ck_properties_property_type",
        "properties",
        "property_type IN ('residential', 'commercial', 'str')",
    )


def downgrade():
    op.drop_constraint(
        "ck_properties_property_type",
        "properties",
        type_="check",
    )
