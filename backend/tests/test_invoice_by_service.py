"""Revenue-by-service summary groups paid invoices by their job's service type."""
from datetime import datetime, date, time

from database.db import SessionLocal
from database.models import Client, Property, Job, Invoice
from modules.invoicing.router import invoice_summary_by_service


def test_by_service_groups_paid_invoices():
    db = SessionLocal()
    try:
        c = Client(name="Svc Rev", email="svc@example.com", status="active")
        db.add(c); db.commit(); db.refresh(c)
        p = Property(client_id=c.id, name="P", address="1 St", property_type="residential", active=True)
        db.add(p); db.commit(); db.refresh(p)
        job = Job(client_id=c.id, property_id=p.id, job_type="residential", title="Clean",
                  scheduled_date=date.today(), start_time=time(9, 0), end_time=time(12, 0),
                  status="completed")
        db.add(job); db.commit(); db.refresh(job)
        inv = Invoice(client_id=c.id, job_id=job.id, invoice_number="INV-SVC-1",
                      status="paid", total=150.0, paid_at=datetime.now())
        db.add(inv); db.commit()

        out = invoice_summary_by_service(period="mtd", db=db)
        res = {r["service"]: r for r in out["by_service"]}
        assert "residential" in res
        assert res["residential"]["total"] >= 150.0
        assert res["residential"]["count"] >= 1
    finally:
        db.rollback()
        db.query(Invoice).filter(Invoice.client_id == c.id).delete(synchronize_session=False)
        db.query(Job).filter(Job.client_id == c.id).delete(synchronize_session=False)
        db.query(Property).filter(Property.client_id == c.id).delete(synchronize_session=False)
        db.query(Client).filter(Client.id == c.id).delete(synchronize_session=False)
        db.commit(); db.close()
