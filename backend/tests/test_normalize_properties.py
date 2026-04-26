"""Tests for the property normalization admin endpoint."""
import pytest
from datetime import datetime
from database.models import Property, Client, PropertyIcal
from database.db import SessionLocal


class TestNormalizePropertiesEndpoint:
    """Test the normalize-properties admin endpoint."""

    def test_infer_str_from_ical_url(self):
        """CRITICAL: Should infer property_type='str' from ical_url."""
        db = SessionLocal()
        try:
            # Create a client
            client = Client(
                name="Test Client",
                email="test@example.com"
            )
            db.add(client)
            db.commit()
            db.refresh(client)

            # Create property with ical_url but property_type='residential'
            prop = Property(
                client_id=client.id,
                name="Monthly Residential Turnover",
                address="123 Main St",
                property_type="residential",
                ical_url="https://www.airbnb.com/calendar/ical/12345.ics",
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            # Call normalize in dry-run
            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            # Should detect type change needed
            assert len(result["would_change_type"]) >= 1
            change = next((c for c in result["would_change_type"] if c["id"] == prop.id), None)
            assert change is not None
            assert change["old"] == "residential"
            assert change["new"] == "str"

        finally:
            db.close()

    def test_infer_str_from_property_ical(self):
        """Should infer property_type='str' from PropertyIcal entries."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Residential Property",
                address="456 Oak Ave",
                property_type="residential",
                ical_url=None
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            # Add PropertyIcal entry
            prop_ical = PropertyIcal(
                property_id=prop.id,
                url="https://calendar.google.com/calendar/ical/abc123.ics",
                source="airbnb"
            )
            db.add(prop_ical)
            db.commit()

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            change = next((c for c in result["would_change_type"] if c["id"] == prop.id), None)
            assert change is not None
            assert change["new"] == "str"

        finally:
            db.close()

    def test_infer_str_from_check_in_time(self):
        """Should infer property_type='str' from check_in_time."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Property",
                address="789 Pine Rd",
                property_type="residential",
                check_in_time="14:00"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            change = next((c for c in result["would_change_type"] if c["id"] == prop.id), None)
            assert change is not None
            assert change["new"] == "str"

        finally:
            db.close()

    def test_normalize_property_name(self):
        """Should remove service description keywords from name."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            # Property with service description name
            prop = Property(
                client_id=client.id,
                name="Monthly Residential Cleaning",
                address="999 Elm St",
                property_type="residential"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            rename = next((r for r in result["would_rename"] if r["id"] == prop.id), None)
            assert rename is not None
            assert rename["old_name"] == "Monthly Residential Cleaning"
            assert rename["new_name"] == "999 Elm St"

        finally:
            db.close()

    def test_normalize_city_state(self):
        """Should normalize city to Title Case and state to uppercase."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Property",
                address="123 Main St",
                city="scarborough",
                state="me",
                property_type="residential"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            fix = next((f for f in result["would_fix_city_state"] if f["id"] == prop.id), None)
            assert fix is not None
            assert fix["after"]["city"] == "Scarborough"
            assert fix["after"]["state"] == "ME"

        finally:
            db.close()

    def test_null_out_str_fields_on_non_str(self):
        """Should NULL-OUT STR-only fields on non-STR properties."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            # Non-STR property with STR fields set
            prop = Property(
                client_id=client.id,
                name="Residential Home",
                address="555 Oak St",
                property_type="residential",
                check_in_time="14:00",
                check_out_time="10:00",
                house_code="1234"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            null_out = next((n for n in result["would_null_str_fields"] if n["id"] == prop.id), None)
            assert null_out is not None
            assert "check_in_time" in null_out["fields"]
            assert "check_out_time" in null_out["fields"]
            assert "house_code" in null_out["fields"]

        finally:
            db.close()

    def test_apply_changes_when_not_dry_run(self):
        """Should apply changes when dry_run=False."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Weekly Residential Cleaning",
                address="666 Maple Ave",
                city="south  portland",
                state="maine",
                property_type="residential",
                check_in_time="14:00"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)
            prop_id = prop.id

            # Run normalize with dry_run=False
            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=False, db=db)

            # Verify changes were applied
            db.refresh(prop)
            assert prop.property_type == "str"  # Inferred from check_in_time
            assert prop.name == "666 Maple Ave"  # Renamed
            assert prop.city == "South Portland"  # Title cased
            assert prop.state == "ME"  # Uppercased

        finally:
            db.close()

    def test_idempotency(self):
        """Running normalize twice should return 0 changes the second time."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            prop = Property(
                client_id=client.id,
                name="Weekly Cleaning",
                address="777 Birch Ln",
                property_type="residential",
                ical_url="https://airbnb.com/ical/123.ics"
            )
            db.add(prop)
            db.commit()

            from modules.properties.router import normalize_properties

            # First run
            result1 = normalize_properties(dry_run=False, db=db)
            assert len(result1["would_change_type"]) >= 1

            # Second run
            result2 = normalize_properties(dry_run=False, db=db)
            assert len(result2["would_change_type"]) == 0
            assert len(result2["would_rename"]) == 0
            assert len(result2["would_fix_city_state"]) == 0
            assert len(result2["would_null_str_fields"]) == 0

        finally:
            db.close()

    def test_flag_properties_without_client(self):
        """Should flag properties with missing client_id."""
        db = SessionLocal()
        try:
            # Create property with non-existent client_id
            prop = Property(
                client_id=99999,  # Non-existent
                name="Orphaned Property",
                address="888 Ash St",
                property_type="residential"
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            flag = next((f for f in result["flagged_for_review"] if f["id"] == prop.id), None)
            assert flag is not None
            assert "missing client_id" in flag["reason"]

        finally:
            db.close()

    def test_never_auto_change_commercial(self):
        """CRITICAL: Commercial properties should NEVER be auto-changed by type inference."""
        db = SessionLocal()
        try:
            client = Client(name="Test Client", email="test@example.com")
            db.add(client)
            db.commit()
            db.refresh(client)

            # Create a commercial property with ordinary notes (no commercial keywords)
            # and NO STR signals — infer_property_type would default to 'residential'
            prop = Property(
                client_id=client.id,
                name="Office Building",
                address="999 Corporate Blvd",
                property_type="commercial",
                notes="Standard cleaning supplies in stock"  # No "commercial" keyword
            )
            db.add(prop)
            db.commit()
            db.refresh(prop)

            from modules.properties.router import normalize_properties
            result = normalize_properties(dry_run=True, db=db)

            # Verify NO type change was proposed for this commercial property
            change = next((c for c in result["would_change_type"] if c["id"] == prop.id), None)
            assert change is None, "Commercial property should never have auto type-change proposed"

            # Verify the property is still commercial after dry_run
            db.refresh(prop)
            assert prop.property_type == "commercial"

            # Also verify with dry_run=False that commercial stays commercial
            result2 = normalize_properties(dry_run=False, db=db)
            db.refresh(prop)
            assert prop.property_type == "commercial", "Commercial property should remain unchanged after apply"

        finally:
            db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
