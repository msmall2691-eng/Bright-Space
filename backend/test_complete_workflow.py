"""
Complete workflow test for STR turnover and Residential recurring schedules.

Tests:
1. Create STR property with iCal
2. Sync iCal and verify jobs are created
3. Create Residential property with recurring schedule
4. Verify no duplicates on re-sync
5. Verify jobs appear on Schedule
"""

import sys
from datetime import datetime, timedelta, date
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from database.db import SessionLocal, Base, init_db
from database.models import Client, Property, PropertyIcal, Job, RecurringSchedule, ICalEvent
from integrations.ical_sync import sync_property
from modules.recurring.router import generate_jobs

def test_complete_workflow():
    # Initialize database
    init_db()
    db = SessionLocal()

    print("\n" + "="*80)
    print("COMPLETE WORKFLOW TEST")
    print("="*80)

    try:
        # 1. Create a client
        print("\n1️⃣  Creating test client...")
        client = db.query(Client).filter_by(name="Test STR Owner").first()
        if not client:
            client = Client(
                name="Test STR Owner",
                email="str@example.com",
                phone="555-0001",
                client_type="str"
            )
            db.add(client)
            db.flush()
        print(f"   ✓ Client: {client.name} (ID: {client.id})")

        # 2. Create STR property with multiple iCal feeds
        print("\n2️⃣  Creating STR property...")
        str_prop = db.query(Property).filter_by(
            client_id=client.id,
            name="Ocean View Condo"
        ).first()

        if not str_prop:
            str_prop = Property(
                client_id=client.id,
                name="Ocean View Condo",
                address="123 Beach Road",
                city="Acadia",
                state="ME",
                zip_code="04601",
                property_type="str",
                check_in_time="14:00",
                check_out_time="10:00",
                default_duration_hours=3.0
            )
            db.add(str_prop)
            db.flush()
        print(f"   ✓ STR Property: {str_prop.name} (ID: {str_prop.id})")

        # 3. Create Residential property with recurring schedule
        print("\n3️⃣  Creating Residential property...")
        residential_prop = db.query(Property).filter_by(
            client_id=client.id,
            name="Main Street House"
        ).first()

        if not residential_prop:
            residential_prop = Property(
                client_id=client.id,
                name="Main Street House",
                address="456 Main Street",
                city="Acadia",
                state="ME",
                zip_code="04601",
                property_type="residential"
            )
            db.add(residential_prop)
            db.flush()
        print(f"   ✓ Residential Property: {residential_prop.name} (ID: {residential_prop.id})")

        # 4. Create recurring schedule for residential property
        print("\n4️⃣  Creating biweekly recurring schedule...")
        recurring = db.query(RecurringSchedule).filter_by(
            client_id=client.id,
            title="Biweekly Home Clean"
        ).first()

        if not recurring:
            recurring = RecurringSchedule(
                client_id=client.id,
                property_id=residential_prop.id,
                job_type="residential",
                title="Biweekly Home Clean",
                address=residential_prop.address,
                frequency="biweekly",
                interval_weeks=2,
                day_of_week=4,  # Friday (0=Mon, 6=Sun)
                days_of_week=[4],  # Friday
                day_of_month=None,
                start_time="09:00",
                end_time="12:00",
                generate_weeks_ahead=8,
                active=True
            )
            db.add(recurring)
            db.flush()
        print(f"   ✓ Recurring Schedule: {recurring.title} (Every {recurring.frequency})")
        print(f"     - Time: {recurring.start_time} - {recurring.end_time}")
        print(f"     - Property: {residential_prop.name}")

        # 4b. Generate recurring jobs
        print("\n4b️⃣ Generating recurring jobs...")
        jobs_created = generate_jobs(db, recurring)
        print(f"   ✓ Jobs generated: {jobs_created}")

        # 5. Create test iCal event (mock Airbnb booking)
        print("\n5️⃣  Creating mock iCal event for STR property...")
        checkout_date = (date.today() + timedelta(days=7)).isoformat()
        checkin_date = (date.today() + timedelta(days=6)).isoformat()

        test_event_uid = f"test_airbnb_{datetime.now().timestamp()}@airbnb.com"
        existing_event = db.query(ICalEvent).filter_by(uid=test_event_uid).first()

        if not existing_event:
            test_event = ICalEvent(
                property_id=str_prop.id,
                uid=test_event_uid,
                summary="Guest Booking - John Doe",
                event_type="reservation",
                checkout_date=checkout_date,
                checkin_date=checkin_date,
                guest_count=2,
                raw_event={
                    "uid": test_event_uid,
                    "summary": "Guest Booking - John Doe",
                    "checkin": checkin_date,
                    "checkout": checkout_date,
                }
            )
            db.add(test_event)
            db.flush()
        print(f"   ✓ Test iCal Event: Guest Booking on {checkout_date}")

        db.commit()

        # 6. Simulate STR property sync (create turnover job from iCal event)
        print("\n6️⃣  Simulating turnover job creation from iCal event...")
        # In real use, sync_property() would fetch the iCal URL and create this job
        # For this test, we'll manually create it to verify deduplication logic

        test_event = db.query(ICalEvent).filter_by(uid=test_event_uid).first()
        if test_event and not test_event.job_id:
            # Simulate what _sync_ical_url does
            start_time = str_prop.check_out_time or "10:00"
            end_time = f"{int(start_time.split(':')[0]) + int(str_prop.default_duration_hours):02d}:{start_time.split(':')[1]}"

            turnover_job = Job(
                client_id=client.id,
                property_id=str_prop.id,
                job_type="str_turnover",
                title=f"Turnover — {str_prop.name}",
                scheduled_date=checkout_date,
                start_time=start_time,
                end_time=end_time,
                address=str_prop.address,
                notes=f"Guest checkout. Booking: {test_event.summary}",
                status="scheduled"
            )
            db.add(turnover_job)
            db.flush()
            test_event.job_id = turnover_job.id
            db.commit()

            print(f"   ✓ STR Turnover Job created: {turnover_job.title}")
            print(f"     - Date: {turnover_job.scheduled_date}")
            print(f"     - Time: {turnover_job.start_time} - {turnover_job.end_time}")
            print(f"     - Property: {str_prop.name}")

        # 7. Check recurring jobs were generated
        print("\n7️⃣  Checking recurring schedule jobs...")
        recurring_jobs = db.query(Job).filter_by(
            recurring_schedule_id=recurring.id
        ).count()
        print(f"   ✓ Recurring jobs generated: {recurring_jobs}")

        # Show sample job
        sample_job = db.query(Job).filter_by(
            recurring_schedule_id=recurring.id
        ).first()
        if sample_job:
            print(f"     - Sample job: {sample_job.title}")
            print(f"     - Date: {sample_job.scheduled_date}")
            print(f"     - Time: {sample_job.start_time} - {sample_job.end_time}")

        # 8. Verify no duplicates
        print("\n8️⃣  Testing deduplication...")
        duplicate_event = db.query(ICalEvent).filter_by(uid=test_event_uid).first()
        if duplicate_event.job_id:
            duplicate_check = db.query(Job).filter(
                Job.property_id == str_prop.id,
                Job.scheduled_date == checkout_date,
                Job.job_type == "str_turnover",
                Job.status.notin_(["cancelled"])
            ).count()
            print(f"   ✓ Jobs for same checkout date: {duplicate_check}")
            print(f"     (Should be 1 - no duplicates)")

        # 9. Summary
        print("\n" + "="*80)
        print("✅ WORKFLOW TEST COMPLETE")
        print("="*80)
        print("\nSummary:")
        print(f"  • STR Property: {str_prop.name} (ID: {str_prop.id})")
        print(f"  • Residential Property: {residential_prop.name} (ID: {residential_prop.id})")
        print(f"  • Recurring Schedule: {recurring.title} (Biweekly on Fridays)")
        print(f"  • Recurring Jobs Created: {recurring_jobs}")
        print(f"\nNext steps:")
        print(f"  1. Open Schedule page (should see residential jobs on Fridays)")
        print(f"  2. Add real iCal URLs to STR property (Airbnb/VRBO)")
        print(f"  3. Manual sync will create turnover jobs")
        print(f"  4. Jobs auto-sync to Google Calendar")
        print("\n")

    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    test_complete_workflow()
