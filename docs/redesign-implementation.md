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

**The LIST half of that second pass is now done (#1161). The DETAIL half is
not**, and the split is deliberate rather than a half-revamp: list and detail
are two screens, and the list is the one the survey measured as read-only.

What the list got: the rows carry **Pause/Resume and Edit rule**, both driving
endpoints the detail page already drives (`PATCH /api/recurring/{id}` and
`EditSeriesModal` on the row's own payload — list and detail return the same
`sched_to_dict`, so there is no extra fetch, and
`__tests__/editPayloadParity.test.js` pins that against the backend
serializer). Pause takes a toast with Undo rather than a confirm, the Requests
Archive reasoning. **Cancel is deliberately not on the row** — irreversible,
and a mis-click on a list lands on the wrong series.

The five bands are three: the state counts moved ONTO the filter chips
(Properties/Clients idiom, so the "N of M" span went away rather than being a
second copy of the same number), the duplicate banner went from a three-line
block to a dot + word + Review, the auto-generate notice from four lines to
one, and **the toolbar is sticky** so the filters don't scroll away the moment
you go looking through them.

**That toolbar started as an internal scroll region, copied from
`pages/Properties.jsx`, and it did not work — nor does Properties'.** `App.jsx`
wraps every route in `.bb-page-in`, which is an animation class with no
height, so a percentage `h-full` beneath it resolves against `height: auto`
and the `flex-1 min-h-0` chain never binds. Measured at 940px with 40 series:
`<main>` scrolled 641px and the toolbar left the screen at -408px. Six series
could not have shown it, and six series is what the first screenshots had —
the only condition under which an internal scroll region differs from a page
that simply grows is overflow. `position: sticky` needs no height chain, so
that is what shipped. **A definite height on `.bb-page-in` would fix both
pages and is worth doing**, but it changes the layout of every route and wants
its own slice.

Not bento, and that is the point: on a list of N series a bento would be the
wrong shape. This is the Properties/Clients list treatment, which is what the
survey's own verdict on Clients ("the stack is in the chrome, not the list")
already pointed at.

**What the detail screen still wants**: six bands, and a header where the
status, the client and the rule summary could be one dense block instead of
three stacked ones. Its rows are NOT read-only — every upcoming visit has
Skip/Reschedule and every override has Undo — so it is a layout pass, not an
actionability one, which is why it ranks below the list.

**And one thing it was given and then had taken away, recorded so nobody
rebuilds it by accident.** Pause a row, walk into that series, hit the
still-visible Undo, and the detail keeps the copy it fetched on mount: Paused,
with a Resume button, for a series the server has active again. It
self-corrects on the next action or revisit.

#1161 built the fix and removed it in the same PR. Closing the gap meant a
`refreshToken` prop, a ref read at click time, a `silent` load that skips the
loading flag so the skeleton doesn't unmount an open modal, and a sequence
guard on every write. **Five consecutive review rounds found a real bug in
each of those in turn** — a reload that never fired (a closure captured before
the navigation), a remount that discarded unsaved rule edits, a failed refresh
that blanked the page, and finally a refresh whose `.catch(() => [])`
subrequests silently emptied the overrides list behind an intact screen.

Every fix was correct and every one opened the next hole, because the thing
being fixed is **two components owning one piece of server state with a toast
outliving the navigation between them**. That wants a shared cache with
invalidation, not a prop; the machinery had grown past the cost of the
transient wrong label it prevented. A stopping rule was written on the PR
before the last round and honoured when that round found more.

Two findings from the attempt are worth keeping even though the code went:
`SeriesDetail`'s auxiliary requests both `.catch(() => [])`, so a transient
failure of the exceptions or jobs endpoint replaces real data with empty data
rather than reporting anything — latent on `main`, not introduced here. And
`load()` has no concurrency guard at all, which the `onDone` handlers can
already race.

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
  status. ~~The Invoicing one is still open, and is a true hard delete, so it
  does want a confirm.~~ **That sentence was already stale when it was
  written** — it survived the edit that resolved the entry above it. Both
  invoice delete call sites (`hooks/useInvoicingMutations.js` and
  `pages/InvoiceDetail.jsx`) go through `confirmAndDeleteInvoice`, and
  `utils/invoiceDelete.js` holds the only `del` on `/api/invoices/{id}` in the
  tree.
- ~~**A field built for a page the page never read.**~~ **Fixed in #1136.**
  `invoice_to_dict`'s `public_token` carried a comment saying it exists so
  "InvoiceDetail can show/copy the customer's pay-page link", and InvoiceDetail
  never read it. `POST /api/invoices/{id}/generate-token` now mints on demand —
  necessary rather than tidy, because the token was only ever minted by the
  SEND handler, so a draft nobody had sent had none and a link built from
  what is on screen would read `/pay/null`. The page copies the link the
  SERVER builds from `app_base_url()`; `QuoteDetail` assembles its own from
  `window.location.origin`, which hands the customer a URL only the office can
  reach whenever the office is on a preview or LAN host.
- ~~**A 1000-row fetch for a field already in the payload.**~~ **Fixed in
  `Quoting`** — no bare `?limit=1000` remains there. The "eight such fetches
  survive elsewhere" this used to point at are now four, and all four are
  cached; see "No cached hook for the client book" below.
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
- ~~**Codes and passwords fetched to render six fields.**~~ **Fixed — and the
  previous note here was wrong.** It said "no longer reads `house_code` /
  `wifi_password` / `access_notes`", which answered a question nobody asked:
  the page never *displayed* them. The entry was about them being **fetched**,
  and they were — `PropertyIcalsBulk` loaded `GET /api/properties/{id}`, which
  BB-SEC-11's own comment calls "the full property dict — house_code,
  access_notes, wifi_password included", and whose per-feed dicts carry
  `house_code` / `access_links` / `instructions` as well. Seven fields
  rendered, a door code and a wifi password on the wire every time.
  Now fixed for real: `GET /api/properties/{id}/icals` (BB-SEC-13) serves
  exactly what the screen reads, held by
  `backend/tests/test_property_icals_payload.py`, which fails on a sensitive
  key name AND on a secret VALUE smuggled under an innocent one.
- ~~**Filter-independent aggregates refetched per keystroke.**~~ **Fixed, and
  half of it was already gone.** `/api/invoices/summary` is no longer called
  from the frontend at all. `/api/clients/counts` was real: it is a whole-DB
  per-status aggregate that rode along with the list fetch, so every tab click
  and every settled search bought four identical COUNTs. It now reads once on
  mount, and again only via `load()` — the mutation path, which is the one case
  where the counts can actually have moved, and not refreshing there is the
  "All frozen after a create" bug the hook's own comment records. Note
  "per keystroke" overstated it: the list fetch is debounced at 250ms, so a
  search burst cost one, not one per character.
- ~~**No cached hook for the client book.** Four pages each fetch `?limit=1000`
  raw. `getCached` exists; nothing wraps this.~~ **Stale — the "raw" half was
  fixed by #1132.** All four client-book reads go through `getCached`
  (`useQuotingData`, `useProperties`, `useInvoicing`, `pages/Recurring`), so the
  in-flight dedupe and 5s memo apply. What is literally still true is the
  narrow part: there is no shared `useClientBook` hook, so the endpoint string
  is written out four times. That is a DRY nit, not the request-storm defect
  this entry was logged as, and it is not worth a PR on its own.
- ~~**A hand-written mirror of backend logic — and it has drifted, measured.**~~
  **The four divergences are fixed and the mirror is now checked against the
  backend.** `computeUpcoming` still reimplements `generate_dates` in the
  browser, so the entry stays open in principle — but the reason it was a
  standing risk is closed.

  What made it a risk was not the duplication; it was that
  `__tests__/helpers.test.js` pinned the mirror against ITSELF. Every
  expectation there is a date a human decided was right, so where the two
  implementations differed, the human's reading got pinned. Two of its cases
  turned out to be asserting divergences AS the rule — the monthly one
  reasoned its way there in a comment — and they stood until both sides were
  run over the same rules:

  | rule | backend `generate_dates` | browser, before |
  |---|---|---|
  | `day_of_month` > the month's length | clamps to the last day (`_occurs_on`, whose comment records fixing exactly this) | **skipped the month entirely** — a monthly-on-the-31st series showed nothing in Feb/Apr/Jun/Sep/Nov while the backend generated a visit |
  | `series_end_date` | an EXCLUSIVE boundary; `end` clamped to the day before | **never read** — an "ends after N visits" or ended-by-split series projected visits forever |
  | `series_start_date` in the future | an INCLUSIVE floor; `today` raised to it | a phase-anchor fallback only, so occurrences **before the split point** were shown |
  | the lookahead window | taken raw: `generate_dates(sched, sched.generate_weeks_ahead)` | **floored at 4 weeks**, so every series with a shorter window was inflated — and `EditSeriesModal`'s input allows `min="1"` with no server validation |

  A fifth candidate is NOT a divergence, recorded so nobody "fixes" it: the
  browser's `interval_weeks || (frequency === 'biweekly' ? 2 : 1)` has no
  backend counterpart (`max(1, interval_weeks or 1)`), but the column is
  `nullable=False, default=1`, so the fallback can only fire on an unsaved
  series.

  **The guard, which is the durable part.**
  `backend/scripts/recurring_projection_cases.py` holds 19 shared rule cases;
  `scripts/gen_recurring_projection_fixture.py` writes the BACKEND's answers to
  `__tests__/projection.fixture.json`;
  `__tests__/projectionParity.test.js` asserts the mirror reproduces them; and
  `backend/tests/test_recurring_projection_fixture.py` fails if the fixture
  stops matching `generate_dates`. So a cadence change on either side now fails
  loudly on the other. Neither half works alone — a fixture with no backend
  check is a snapshot that rots, and a backend check with no comparison proves
  nothing about the mirror.

  **One divergence is left and cannot be closed from the browser:**
  `generate_dates` reads `business_today()` (America/New_York) and the mirror
  reads the viewer's local midnight. They agree for an office in Maine and can
  differ by a day elsewhere. That is the remaining argument for the structural
  fix — have the backend return the projection and delete the mirror — which is
  zero new requests on the detail page but a payload change on both
  `GET /api/recurring` and `GET /api/recurring/{id}`, and so its own slice.
- **The same fact counted four ways.** "Quoted" is computed on Requests, Deals,
  Quoting and QuoteFunnel from four different sources. `Quoting` already deleted
  its own hero pods so a count isn't shown twice; the other three still do it.
  Lead rows render on both Requests and Deals; the lead→quote→job hand-off is
  implemented three times.
- ~~**Six pages have no test at all.**~~ **Closed — and it was five, not six.**
  `Clients` was miscounted from the start (`Clients.chrome.test.jsx` existed),
  and `Recurring`'s only real risk had already moved out of the page and been
  covered (see the hand-written-mirror entry above). The other four now have
  one each, and in every case the thing pinned is a decision that was holding
  in prose only:

  | page | what the test is actually about |
  |---|---|
  | `InvoiceDetail` | `/send` answers 200 with a per-channel result, so a bounced email is a SUCCESSFUL request — reporting it as sent leaves the owner chasing a payment for an invoice nobody got |
  | `Invoicing` | the `?status=` the dashboard's money links point at, including the strip that stops a tab click snapping back |
  | `PropertyIcalsBulk` | which endpoint it reads (BB-SEC-13), plus the case-insensitive paste dedupe — without it one feed added twice makes every turnover twice |
  | `Properties` | `?edit=<id>` waits for the rows rather than stripping the param while they load. "Tidy up the URL" is the obvious refactor and it breaks the deep link on any slow connection, silently |
- ~~**`.bb-focus` exists only on OpsBoard.**~~ **Done, and it was two defects.**
  The reach was the smaller one: the ring is now a base-layer
  `:where(…):focus-visible` default covering the ~1140 focusable elements that
  had no focus styling at all, rather than the 14 that had opted in. The larger
  one only showed up on measuring — the ring was `--accent-500`, which bottoms
  out at **1.69:1** on light grounds against a 3:1 floor, so on five of the
  seven selectable accents it could not be seen. No single step clears both
  ends, so it now uses a per-theme `--accent-focus` (700 light / 500 dark),
  held by `__tests__/focusRing.test.js`.

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
