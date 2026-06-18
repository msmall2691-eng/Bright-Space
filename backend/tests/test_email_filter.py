"""The inbound-email lead filter: real cleaning prospects become leads; vendors,
newsletters, bulk mail and cold B2B pitches stay inbox-only. evaluate_inbound_email
returns (create, reason) so every decision is auditable.
"""
from integrations.email_filter import evaluate_inbound_email, is_bulk_mail


def _email(**kw):
    base = {"from_email": "someone@example.com", "subject": "", "body": ""}
    base.update(kw)
    return base


def test_blocked_vendor_domains_are_rejected():
    for domain in ("pinterest.com", "figma.com", "turno.com", "textmagic.com",
                   "n8n.io", "maidsos.com", "courts.maine.gov"):
        create, reason = evaluate_inbound_email(_email(from_email=f"news@{domain}",
                                                       subject="Update", body="hi"))
        assert create is False
        assert reason == "blocked_sender", domain


def test_bulk_mail_headers_rejected_even_on_unknown_domain():
    # A newsletter from a domain not on the block list is still caught by headers.
    create, reason = evaluate_inbound_email(_email(
        from_email="digest@somenewsletter.example",
        subject="Your weekly digest",
        body="Lots of pins for you",
        list_unsubscribe="<https://x/unsub>",
    ))
    assert create is False
    assert reason == "bulk_mail"


def test_precedence_bulk_is_bulk():
    assert is_bulk_mail({"precedence": "bulk"}) is True
    assert is_bulk_mail({"feedback_id": "12:345:abc"}) is True
    assert is_bulk_mail({"auto_submitted": "auto-generated"}) is True
    assert is_bulk_mail({"auto_submitted": "no"}) is False
    assert is_bulk_mail({}) is False


def test_cold_outreach_rejected():
    create, reason = evaluate_inbound_email(_email(
        from_email="rep@growthco.example",
        subject="Quick partnership opportunity",
        body="We help businesses like yours book a demo and increase your leads.",
    ))
    assert create is False
    assert reason == "cold_outreach"


def test_genuine_cleaning_inquiry_creates_lead():
    create, reason = evaluate_inbound_email(_email(
        from_email="jane@gmail.com",
        subject="House cleaning quote",
        body="Hi, I'd like a quote for a deep cleaning of my home in Portland.",
    ))
    assert create is True
    assert reason == "cleaning_inquiry"


def test_reply_to_our_thread_creates_lead():
    # Subject heuristic.
    create, reason = evaluate_inbound_email(_email(
        from_email="existing@gmail.com", subject="Re: your appointment", body="thanks!"))
    assert create is True
    assert reason == "reply_to_thread"
    # to_email on our domain (header now extracted by gmail_inbox).
    create2, reason2 = evaluate_inbound_email(_email(
        from_email="existing@gmail.com", subject="thanks", body="ok",
        to_email="hello@maineclean.co"))
    assert create2 is True
    assert reason2 == "reply_to_thread"


def test_unknown_sender_without_intent_is_inbox_only():
    create, reason = evaluate_inbound_email(_email(
        from_email="random@gmail.com", subject="hello", body="just saying hi"))
    assert create is False
    assert reason == "no_cleaning_intent"


def test_no_sender_rejected():
    create, reason = evaluate_inbound_email(_email(from_email=""))
    assert create is False
    assert reason == "no_sender"


def test_reply_beats_bulk_headers():
    # A genuine reply from an existing relationship wins even if a footer added
    # an unsubscribe header — we never drop a real conversation.
    create, reason = evaluate_inbound_email(_email(
        from_email="client@gmail.com", subject="Re: your quote", body="looks good",
        list_unsubscribe="<https://x/unsub>"))
    assert create is True
    assert reason == "reply_to_thread"
