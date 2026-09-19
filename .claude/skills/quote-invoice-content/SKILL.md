---
name: quote-invoice-content
description: The standard for customer-facing content on quotes and invoices — the "what's included" scope, the "A few things before we clean" prep policies, and the estimate/terms language — and the rule that all of it is SERVICE-TYPE-AWARE. Load before adding or editing a service, changing what a quote or invoice says to the customer, or when a quote shows the wrong notes for its service type (e.g. a short-term-rental turnover showing residential "pick up your clutter / secure pets" notes).
---

# Quote & invoice content

Every customer-facing quote surface — the **public accept page**, the **quote
email**, and the **PDF** (both the emailed attachment and the downloadable
copy) — carries three blocks of content. This skill is the contract for what
goes in them and, above all, that **the content is chosen by the quote's
service type.** A short-term-rental turnover is not a house clean; it must not
read like one.

## The three content blocks and where they live

All three resolve in `backend/modules/settings/router.py`, and every render
path pulls from these — never hard-code customer copy in a template.

| Block | Heading the customer sees | Resolver | Per service type? |
|---|---|---|---|
| **Scope** ("what's included") | *Scope & details* | `service_scopes_list(db)` / `DEFAULT_SERVICE_SCOPES` | **Yes** — one entry per service (`residential`, `deep`, `move_in_out`, `str`, `commercial`), editable in Settings → Service Descriptions |
| **Prep policies** ("what we need from you") | *A few things before we clean* | `quote_policies_text(db, service_type)` / `DEFAULT_QUOTE_POLICIES` · `_STR` · `_COMMERCIAL` | **Yes** — resolved by service type |
| **Terms** (estimate / non-binding) | *(footer)* | `quote_terms_text(db)` / `DEFAULT_QUOTE_TERMS` | No — one estimate/terms block for all |

## The rule: content is service-type-aware

`quote_policies_text(db, service_type)` resolves in this order:

1. a **per-service override** the operator saved (`quote_policies_<type>`),
2. the **legacy global override** (`quote_policies`) — **home cleans only**,
   because its wording is residential; applying it to STR/commercial is the
   bug below,
3. the **service-appropriate default** (`_DEFAULT_POLICIES_BY_TYPE`, falling
   back to the residential `DEFAULT_QUOTE_POLICIES` for home-clean variants).

Home-clean variants (`residential`, `deep`, `move_in_out`, unknown/`None`)
share the residential block. `str` and `commercial` each have their own.

### Why STR is different (don't undo this)

On an Airbnb/VRBO turnover the **guest is not the customer**, so residential
prep lines read wrong and were the reported bug:

- ❌ "Please pick up and put away personal items and clutter" — the guest left; clearing up *is* the job.
- ❌ "For everyone's safety, please secure pets during the visit."
- ❌ "Please have running water, power, and heat/AC available."

STR notes instead cover: lockbox/PIN + checkout/check-in window, where
linens/supplies/restock live, on-site pets & owner-locked areas, turnover-date
change notice, and that laundry isn't in the base price.

## Every render path must pass `service_type`

If a new surface renders policies, it **must** pass the quote's service type,
or it silently falls back to residential:

- Public page → `_public_quote_dict` → `_company_info(db, quote.service_type)`
- Emailed PDF → send path → `_company_info(db, quote.service_type)`, `policies=company["quote_policies"]`
- Downloadable PDF → `public_quote_pdf` → `_company_info(db, quote.service_type)`
- Quote email HTML → `QuoteEmailService._policies_setting(service_type)`

`_company_info(db, service_type=None)` defaults to the residential block, which
is correct for non-quote callers (job-confirmation page, etc.) that don't show
policies.

## Adding or auditing a service

1. Add/adjust its **scope** in `DEFAULT_SERVICE_SCOPES` (or Settings).
2. If its prep needs differ from a home clean, add a `DEFAULT_QUOTE_POLICIES_<TYPE>`
   default and wire it into `_POLICY_KEYS` + `_DEFAULT_POLICIES_BY_TYPE`.
   Otherwise it inherits the residential block — fine for home-clean variants.
3. Confirm every render path above passes `service_type`.
4. Read the copy as the customer: does any line assume the customer lives
   there? If so it doesn't belong on an STR/commercial quote.
5. Add/extend `tests/test_quote_policies_by_service.py`.

## Invariants

- Customer copy lives in the settings resolvers, never inline in a template.
- STR and commercial never inherit residential prep notes.
- A saved global `quote_policies` override applies to home cleans only.
- Terms/estimate language is always present (a quote must never read as a fixed
  contract price).

## The trap that shipped

`quote_policies` was a single global block applied to every quote regardless of
service type, so a real STR turnover quote went to a customer carrying
residential "pick up your clutter / secure pets" notes. The fix made the
policies resolve by service type; the same shape (per-service default +
override) already existed for scope and is the model to follow.
