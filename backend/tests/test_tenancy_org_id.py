"""Multi-tenancy MT-1: org_id is present on every domain table.

This is the safe foundation (additive, nullable, backfilled to org 1) — no query
scoping yet. The guard ensures the tenant column can't silently drop off a model
before MT-2 (scoping) and MT-3 (NOT NULL + RLS) build on it.
"""
from database import models as m

_DOMAIN_MODELS = [
    m.Client, m.Property, m.Job, m.Visit, m.LeadIntake, m.Invoice,
    m.Conversation, m.Message, m.Opportunity, m.ContactEmail, m.ContactPhone,
    m.Activity, m.Quote, m.QuoteRequest, m.RecurringSchedule,
]


def test_domain_models_have_org_id():
    missing = [model.__name__ for model in _DOMAIN_MODELS
               if "org_id" not in model.__table__.columns]
    assert not missing, f"org_id missing on: {missing}"


def test_org_id_is_nullable_for_now():
    # MT-1 keeps it nullable + backfilled; MT-3 flips to NOT NULL after scoping.
    assert m.Client.__table__.columns["org_id"].nullable is True
