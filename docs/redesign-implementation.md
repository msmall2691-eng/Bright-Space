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

## Tier 3 — the per-page revamps · ~15 PRs, one page each

Mechanical but not quick: each page is its own diff, its own veto grep, its own
check at ~380px and ~940px. The `ui-reviser` agent exists for exactly this and
should drive them. Order by how much time she spends in each:

Schedule → Money → Clients (+ Tidy Up) → Flow → Leads and Quotes → Recurring and
Turnovers → Properties and feeds → Job / Quote / Client detail → Owner → Sync
Center → Settings → Marketplace and Roster → Payouts → Thresholds.

Per page: no new fetch, reuse the existing payload, bento instead of full-width
bands, ≥1 inline action from a shipped endpoint with confirm + toast, motion
150–350ms wrapped in `prefers-reduced-motion`, veto grep clean.

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
