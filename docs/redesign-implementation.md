# Implementing the redesign

The design canvas is the spec: <https://claude.ai/artifact/TYAiRfE19JZQSbDTBL9Z1t>
(27 artboards, every screen in both skins, built on the BrightBase design
system). This document replaces the plan that produced it. It says what it
costs to actually build, in the order it should land.

Everything here is grouped by **real cost**, not by how it looks on the canvas.
A board that is a repaint and a board that needs a migration look the same when
you are panning around.

## Already landed

| What | Where |
|---|---|
| Public surface pinned to Clean, and to 16px | PR #1089 |
| Guard for the inherited-property hole in `publicSurface.test.js` | PR #1089 |
| `tokens.json` `service-commercial` corrected to mirror `index.css` | design system |

## Tier 1 — close out the contrast work · 1 PR, small

The two gaps PR #1089 deliberately left, both token changes rather than
per-page ones.

1. **Add `--accent-strong` per theme** and use it for accent-coloured *text*
   (links, focus rings, accent labels). The clean accent is 5.05:1 on panel but
   **4.44:1 on `bg-2`** and **4.09:1 on `bg-3`** — so a link inside a hovered
   row or an inset well is under AA today. `tokens.json` already defines this
   token and the repo has none.
2. **Separate the service hues by lightness.** `--c-residential` and
   `--c-commercial` sit **1.03:1** apart, so in the light themes the two service
   types are told apart by hue alone; as tag *words* commercial is 4.12:1 and
   residential 4.25:1, both under the text floor while `DotTag` renders the word
   in the hue. Blue against orange is the safest such pair, so this is a
   darkening pass, not a re-hue.
3. Extend `__tests__/inkContrast.test.js` to cover accent-as-text on all four
   grounds and the residential/commercial separation, so neither can drift back.

Files: `frontend/src/index.css`, `frontend/src/components/board/tokens.js`,
`frontend/src/__tests__/inkContrast.test.js`, then regenerate the design
system's `tokens.json`.

## Tier 2 — the dashboard · 3 PRs, zero new requests

This is `modernization.md`'s own plan and it is already adversarially verified
(48 ideas, 16 survived). Do not re-litigate it; build it.

**2a — ship first, independently.** De-risks the rest, and has to exist *before*
a diff adds forty rows or the accessibility work spends its life chasing it.
- Shape-matched skeleton including the focus tier (today ~150–170px inserts at
  the moment the board resolves; 3×288px of pulse is taller than a phone
  viewport).
- One `.bb-focus` inset ring, the `min-h-0` pass, results through `pushToast`.
  No interactive element on this page defines a focus style and every card clips
  the UA ring with `overflow-hidden`; a negative outline offset is load-bearing.
- KPI strip: 2×3 wrap at phone width instead of an invisible scroller (two tiles
  sit permanently off-screen at 390px).
- Fix the light-theme status ramp (BB-A11Y-02) with a test.

**2b — the redesign, as ONE diff.** Mounts land in the same commit as the
deletions they replace. A mount without its deletion shows the number twice; a
deletion without its mount loses the signal — that is exactly how the
`OwnerDashboard` regression happened.
- `requests` as rows carrying the shipped `Draft quote` / `Book it`
  (`board_service.py:471/486`). Treat `Draft quote` as confirm-required client
  side: it is a metered Anthropic call shipping with no confirm string.
- Money gets per-invoice rows and `Mark paid` back (`:531`), plus the dropped
  sub-line so the outstanding figure has a denominator.
- Needs-a-cleaner as rows; delete its three restatements. `Open` only — the
  payload ships no assign action and inventing a mutation is forbidden.
- Mount `FeedHealth` and `RecurringHealth` **gated on `problem_total` /
  `stalled_total`**, not on the subject. Do **not** mount `MoneyToday`: it reads
  fields the payload stopped sending when the time clock was removed.
- Fold the identity bar into one command line (fixes the two-`h1` outline).
- Drop the calm verdict; keep the attention headline above the rail.
- **The week load rail.** Does not exist in the payload — derive it client-side
  from the `/api/schedule/week` fetch `HomeToday` already makes, so it costs
  zero new requests. Do not add a `week_load` field.

**2c — polish.** Surface "Needs a date" from `unscheduled`; key the grid
template on `canComms`; add the channel tag to client rows; trim the tail.

## Tier 3 — re-ordered by evidence · far fewer than 15 PRs

**The original plan ordered this tier by how much time she spends in each page.
That is not the same list as where the problem is, and the difference turned out
to be most of the tier.** Schedule was first on time-spent; reading it showed it
had already had the whole treatment (see below). So before building anything
else, all 13 office pages were surveyed against one countable rubric.

**Eight of the thirteen do not have the problem.** They are already dense,
already actionable, and in several cases their own comments record the revamp
that produced them. Revamping them would manufacture change on pages already
iterated with the owner.

### The rubric

Per page: full-width bands stacked above the first dense region · inline actions
from shipped endpoints · `lg:` hits (should be `shell:`) · mount-time fetches and
any duplicate · 500-step status colours · `.bb-focus` present · payload fields
fetched but never rendered · orphaned components · page-level test.

### Ranked

| Page | Bands | Inline actions | Verdict |
|---|---|---|---|
| **QuoteFunnel** | **6**, two gridded, no scroll region | **0** | **Worst. The problem in its purest form** — read-only, actionless, tall. No number on the page clicks through to the records behind it. |
| **Cleanup** (Tidy Up) | 3 + 3 stacked sections, no scroll region | 3 | **The tall-stack page.** 1-up cards in a 1100px column; keeps a permanent all-clear card where its own siblings self-suppress. |
| **Requests** | 1 band of 5 stacked rows, then 1-up cards of 6–9 lines | 7, five buried in a kebab | Sprawling and low-density with its actionability hidden. No inline status; Archive fires with no confirm. |
| **Clients** | **4 always, up to 6** | **12** (strongest) | The stack is in the *chrome*, not the list — the list is already a 2-up grid and says so. Bulk bar renders with nothing selected. Densify the header. |
| **Recurring** | 5 (list) / 6 (detail) | 0 on list rows; 21 elsewhere | Banded, and list rows are read-only. But the real problem is **4 screens + 3 modals in one 1795-line file**, all already props-only. |
| Schedule | 3, filter row hidden | many | **Already done.** `ScheduleCommandBar` merged two bands into a bento; `PageHeader` already dropped; power tools already behind one menu. |
| Flow | 2 | 5, 4 confirmed | **The reference shape.** Best-tested page in the app. |
| Quoting | 1 (deliberately pod-free) | 12, role-gated | Two-pane shell over a divided row list. Dense. |
| Deals | 2 | 6 incl. drag-and-drop | Already a sortable grid *and* a kanban. |
| Properties | 3 + transient panels | 11, 4 confirmed | Toolbar over a `flex-1 overflow-y-auto` list. |
| PropertyIcalsBulk | 1 | 7 | First interactive content appears immediately. |
| Invoicing | 3, two of them grids | 8 | Aging strip self-suppresses when nothing is outstanding. |
| InvoiceDetail | 1 | 6 | Already a responsive bento; a comment documents the move off the old 3-column layout. |

### Build order

**QuoteFunnel → Cleanup → Requests → Clients (chrome only) → Recurring (split
the file).** All five shipped: QuoteFunnel (#1096), Cleanup/Tidy Up (#1097),
Requests (#1101), Clients chrome (#1102), Recurring (#1103).

**What Recurring did NOT get, stated plainly so "Tier 3 done" doesn't imply
more than was delivered.** Its PR did the file split (1795 → 356 lines, nine
modules, every block verbatim) and the sweep that split exposed — nineteen
500-step dots and six boxed dot-pills, since this surface had never had the
de-bubbling or contrast pass the rest of the app did. It did **not** touch the
five list bands, the six detail bands, or the fact that **list rows carry no
inline actions** (the survey counted 0 on the rows, 21 elsewhere). Those are a
real second pass on this page, and they are now much cheaper than they were:
the screens are separate files, so `SeriesRow` and `SeriesDetail` can each be
reworked without reading 1795 lines. Worth doing; not done.

Then stop: the remaining eight are not revamp candidates, and
Payouts / Owner / Sync Center / Settings / Marketplace / Roster / Thresholds /
detail pages were not surveyed and get their own pass before anyone assumes.

Per page, unchanged: no new fetch, reuse the existing payload, bento instead of
bands, ≥1 inline action from a shipped endpoint with confirm + toast, motion
150–350ms under `prefers-reduced-motion`, veto grep clean, ~380px and ~940px,
and **the mount-time request count asserted** — the Tier 2c lesson.

### What the survey found that is not layout

Each of these is a real defect, logged here so none is lost to a tier that no
longer visits its page:

- ~~**Two hard deletes with no confirm.**~~ **Both resolved.** `Invoicing`'s
  list panel called `DELETE /api/invoices/{id}` with no confirmation while
  `InvoiceDetail` gated the *same* endpoint behind a danger dialog — and the
  list panel's `catch {}` also threw away the API's message, so the backend's
  "cannot delete a paid invoice" 409 arrived as a generic failure. Fixed by
  giving both one shared path (`utils/invoiceDelete.js`) rather than copying
  the dialog, since two copies drifting apart is how it happened; a test reads
  both call sites' source and fails if either reaches for `del` directly
  again. ~~`Requests`' "Archive" PATCH has none
  either.~~ — **resolved in #1101, but not with a confirm.** Archive is
  reversible, and a confirm on every one would tax the main triage loop to
  guard something undoable; the real defect was that it reported nothing at
  all, and that a FAILED archive dropped the row too (the error went only to
  the console). It raises a toast with Undo now, restoring the exact prior
  status. The Invoicing one is still open, and is a true hard delete, so it
  does want a confirm.
- **A field built for a page the page never read.** `invoice_to_dict`'s
  `public_token` carries a backend comment saying it exists so "InvoiceDetail
  can show/copy the customer's pay-page link". `InvoiceDetail` never reads it.
- ~~**A 1000-row fetch for a field already in the payload.**~~ **Fixed in
  `Quoting`** — no `?limit=1000` remains there. Eight such fetches survive
  elsewhere; see "No cached hook for the client book" below, which is the same
  problem and still open.
- ~~**A raw `fetch()` outside `api.js`.**~~ **Half of this was never a defect,
  and the other half is fixed.** The raw `fetch` and the localStorage read are
  deliberate and carry their reason in the file: `PropertyPhoto` renders inside
  the crew `JobCard` and office `PropertyDetail`, so importing a named `api`
  export would break every test that partially mocks `../api`. `lazy` already
  stops a list fetching photos nobody scrolled to. What WAS real is the last
  clause — the drawer buying a second copy of a photo already on screen
  (`Requests.jsx:364` and `:965` on one address). Fixed by caching the blob per
  endpoint, not the object URL: an object URL is owned by whoever revokes it,
  and sharing one would blank the list row when the drawer closed.
- ~~**A search that silently matches nothing.**~~ **Fixed.** `prop_to_dict`
  ships `client_name` and carries a comment naming this bug.
- ~~**Codes and passwords fetched to render six fields.**~~ **Fixed.**
  `PropertyIcalsBulk` no longer reads `house_code` / `wifi_password` /
  `access_notes`.
- **Filter-independent aggregates refetched per keystroke.**
  `/api/invoices/summary` and `/api/clients/counts` re-fire with every tab click
  and debounced keystroke.
- **No cached hook for the client book.** Four pages each fetch
  `?limit=1000` raw. `getCached` exists; nothing wraps this.
- **A hand-written mirror of backend logic.** `Recurring`'s `computeUpcoming`
  reimplements `generate_dates` in the browser — the highest-risk duplicate in
  the file.
- **The same fact counted four ways.** "Quoted" is computed on Requests, Deals,
  Quoting and QuoteFunnel from four different sources. `Quoting` already deleted
  its own hero pods so a count isn't shown twice; the other three still do it.
  Lead rows render on both Requests and Deals; the lead→quote→job hand-off is
  implemented three times.
- **Six pages have no test at all**: Invoicing, InvoiceDetail, Clients,
  Properties, PropertyIcalsBulk, Recurring. `PropertyIcalsBulk` is fully
  instrumented with testids that nothing references.
- **`.bb-focus` exists only on OpsBoard.** Tier 2a's focus ring never reached any
  other page, so keyboard focus is still invisible app-wide under
  `overflow-hidden`. That is one app-wide PR, not thirteen page PRs.

## Tier 4 — the two real builds · weeks each, own design pass

Neither is a redesign. Both want their own plan and their own approval.

**4a — omni-channel (canvas board 15).** The change is a data shape: *channel
becomes a property of each message rather than of the thread*. That means a
migration (channel on the message, thread keyed to a person not a channel), a
`modules/comms` refactor, the unified transcript, the reply-channel switcher,
canned replies, SLA fields and the cross-channel timeline. `schema-guardian`
governs the migration; `brightbase-economy` governs the reply path. Everything
visible on that board is downstream of the migration — building the UI first
would mean building it twice.

**4b — website chat widget + operator console (canvas board 27).** The app has
no chat surface at all: no public endpoint, no session that survives a reload,
no operator presence, no push to a phone. The transport is already paid for —
it rides the agent WebSocket rather than adding a polling loop — and a chat that
becomes a lead must go through `build_intake()` / `upsert_lead()` so chatting
*and* filling the form is one lead, not two.

Hard constraints the board already encodes: it never knows an access detail,
never commits to a price, never books a visit by itself, and never answers as a
bot in Meg's name. It stays off `/quote` and `/pay` — those are capability
links. And the real risk is staffing, not code: a box nobody answers is worse
than no box, which is why the out-on-jobs state is drawn beside the live one.

## Branch and deploy policy

`main` is production. Railway builds from it and its `preDeployCommand` runs
`scripts/db_bootstrap.py`, which applies migrations and RLS. CI (`ci.yml`) runs
on pushes to `main` but *after* the push, so it gates nothing there; on a pull
request it gates everything. `CLAUDE.md` says feature work happens on branches.

So: **one PR per slice above**, each green before merge. The slices are
deliberately small enough to merge the same day. The cost of the PR is minutes;
the cost of a red `main` is a deploy to a business that is using the app to get
paid this week.

Tier 4 must not land on `main` without a migration review — `db_bootstrap.py`
runs on deploy, so a bad revision is a production incident, not a failed build.

## Verification, every tier

- `cd frontend && npx vitest run` — currently 927 passing across 136 files
- `cd frontend && npm run build`
- `cd backend && python -m pytest` for anything touching the backend
- Veto grep on each diff:
  `rounded-full.*bg-(amber|red|blue|green|emerald|indigo|violet)-(50|100|200)`,
  tinted `bg-*-50 border-*-200` resting banners, count bubbles
- Both widths that matter: ~380px and ~940px (`shell:`, never `lg:`)
- `npm run gen:types` whenever a backend shape changes
