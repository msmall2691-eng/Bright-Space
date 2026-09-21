# BrightBase UI revamp

The positive, generative counterpart to `brightbase-design-language`. That skill
is the **veto list** — what the owner has banned (bubbles, tinted banners, count
badges). This one is the **target**: how to make a BrightBase page feel modern,
dense, useful, and alive *without* tripping a single veto. Load it before
redesigning a whole page, dashboard, or list — not for a one-widget tweak.

**It does not override `brightbase-design-language`, `brightbase-economy`, or
`scheduling-invariants` — it sits on top of them.** Where any of those conflict
with a "make it cooler" impulse, they win. This skill exists precisely so
"modern" never becomes an excuse to reintroduce the vetoed chrome.

## The one sentence the owner keeps saying

> "I wish this was cooler and futuristic and modern and less wasted space —
> useful boxes, more actions, more movement."

And, three separate times:

> "I hate the bubble labels / hate the big bubbles / hate the button badges."

Both are true at once. The whole job of this skill is holding both: **futuristic
via information design and motion, never via decoration.** The north star is
**Linear / Raycast / Superhuman / Vercel** — calm dark surfaces, ruthless
density, one accent, purposeful micro-motion, a command bar. It is **not**
Stripe-dashboard confetti, gradient hero cards, or colorful pills. If a change
would look at home on a "top 10 SaaS dashboards" dribbble shot, it is probably
the wrong direction here.

---

## What "modern" means here (the four levers)

Every revamp pulls these four levers. Nothing else is "modernizing" — it's just
recoloring.

### 1. Density — kill the long scroll

The recurring failure mode is a page that is a **tall stack of full-width
bands**, each holding two lines of content, so the page is simultaneously
*sprawling* and *empty*. That is the "wasted space" and "worst layout" feeling.

- **Bento, not bands.** Group concerns into a grid of bounded boxes that pack
  side by side, so the eye takes in five things in the space one band used.
- **Above the fold is a budget.** Decide the 3–5 things that must be visible on
  first paint at ~940px and put them up top. Everything else earns its scroll.
- **Pack columns, don't height-lock rows.** A CSS grid ties every card in a row
  to the tallest one (a 4-number box beside a 6-row box leaves a card of dead
  space — the owner: *"too much empty spaces lol"*). Use per-column flex stacks
  (`flex flex-col gap-4`) so a short box sits directly on the next. This is
  already the pattern in `OpsBoard.jsx` — keep it.
- **Cap and defer.** A section that can hold a dozen rows shows ~5 then
  `+N more → full page`. The board is a triage surface, not a scroll-forever
  list.
- **Merge duplicate numbers.** If two boxes show the same count, delete one. The
  owner has flagged this by name (*"it's almost a little redundant"*).
- **No empty furniture, no box-in-box.** A box renders **nothing** when its
  subject doesn't exist for this business (no STR feeds, no recurring). A
  permanent all-clear box trains people to skip the spot the real thing appears
  in. A group label is a header + toggle, never a wrapping panel around cards
  that already have borders.

### 2. Useful boxes — every box earns its place

A box is worth its space only if it answers a question or offers an action. The
anatomy of a good one:

- A **header**: a 6px semantic dot + a quiet uppercase/`text-ink-3` label + a
  right-aligned link into the page that owns the full set (`Billing →`).
- **Content that is scannable in two seconds** — a big plain number, a short
  list of dot+word rows, a sparkline. Every name that identifies a record
  (client / property / job / invoice / cleaner) is a record link
  (`text-ink hover:text-indigo-600 no-underline`).
- **At least one thing you can do**, when a safe endpoint exists (see lever 3).

If you can't say what question a box answers, cut it.

### 3. Actions & movement — the app should feel operable, not read-only

"More actions, more movement" means: **do the thing from where you see it**, and
let the interface acknowledge it.

- **Inline actions.** Where an endpoint already exists, surface it on the row:
  *Reply*, *Open to crew*, *Send reminder*, *Book it*, *Approve claim*. Follow
  the existing `runAction` contract in `OpsBoard.jsx` — `link` navigates; `api`
  POSTs with a **confirm step**, a spinner, an optimistic clear on success, and
  a toast. Never invent a new mutation; only surface ones that ship.
  **Marketplace guardrail:** an action may let a sub *claim/accept* or let the
  office *approve* a claim — it may **never** assign a sub to a job or price by
  the hour (see `brightbase-marketplace` Rule 0).
- **Micro-motion, on a budget.** Count-up on a headline number, a sparkline that
  draws once, a row that slides out when cleared, a hover lift, a single "live"
  pulse dot. Keep it **150–350ms**, ease-out, and wrap the whole budget in
  `@media (prefers-reduced-motion: reduce)`. Motion confirms an action or draws
  the eye to what changed — it is never ambient decoration.
- **A command surface.** `/` or ⌘K opens search / quick actions. It is the most
  "futuristic" thing you can add and it is pure utility. `OpsBoard` already has
  `/`-to-search; extend that language.
- **Never block data behind a nicety.** A slow AI brief, a sparkline, a chart —
  each does its own thing and renders *nothing* on failure. The real numbers
  never sit behind, or visually blame, a flourish.

### 4. Surface & hierarchy — futuristic is a material, not a color

- **Dark command-center is the mood**, delivered through the existing
  `theme-console` tokens — it is not a new palette. Build **entirely** on the
  semantic CSS vars (`--bg --bg-2 --panel --ink --ink-2 --ink-3 --hairline
  --hairline-2` + the indigo accent) so the page re-skins with the active theme
  and works in light too. **Never hardcode a gray or a hex.**
- **One accent (indigo), color reserved for status.** A dot is amber/red/
  emerald/violet/indigo because it *means* something (see the design-language
  color table), never because a box needed brightening.
- **Hierarchy through weight, size, and hairlines** — not borders-on-everything.
  Lead with the one number that matters; let hairline dividers separate rows;
  spend a heavier border/shadow only on the thing being lifted.
- **Depth, quietly.** A hairline top-highlight, a soft long shadow, a blurred
  sticky top bar read as "crafted" without a single gradient card. Tasteful,
  not glossy.

---

## Hard constraints (inherited — do not relitigate)

- **The veto list stands.** No filled pill/chip labels, no tinted resting-state
  banners, no colored count bubbles, no gradient cards, no tinted icon chips.
  Reviewers grep for these. A *transient* `hover:bg-*` tint is fine — that's
  interactive feedback, not resting chrome. (`brightbase-design-language`.)
- **One fetch per screen per need.** A revamp reorganizes what's already
  fetched; it does not add requests. Reuse the existing payload (e.g.
  `/api/dashboard/board` already ships render-ready snapshot data). Metered/
  external data stays cached at the row. New polling is almost always wrong.
  (`brightbase-economy`.)
- **`shell:` = 900px is the desktop breakpoint** (the owner's window is ~940px;
  a plain `lg:`/1024 has hidden an entire redesign from her). Check every
  layout at **~380px and ~940px**. Bento collapses to one column on phones.
- **One primary button per view.** Secondary = hairline-bordered; tertiary =
  text link. (`brightbase-design-language`.)
- **Crew payloads stay light** (rural cell data); photos lazy-load behind a tap.
  (`brightbase-economy`.)
- **Never touch** customer-facing pages (PublicQuote / PublicPayment /
  CustomerPortal) casually, and never surface access details (door codes, wifi,
  `access_notes`) anywhere but the assigned cleaner's crew view (BB-SEC-08…12).
- **Scheduling authority is canonical.** A dashboard action may open/flag/cancel-
  pending, never silently delete a Job or write canonical state from a
  projection. (`scheduling-invariants` R7/R2.)

---

## The revamp procedure (one page at a time)

1. **Read the page and its data source together.** The `.jsx` page + the
   backend service that builds its payload (e.g. `board_service.py`,
   `board_snapshot.py`). You cannot redesign what you don't understand; the
   comments in these files record decisions already litigated — respect the
   `BB-*` tags and PR references.
2. **Inventory every section.** List them. For each, decide **keep / merge /
   cut**, and why. Cutting and merging is most of the win — the owner called the
   *grouping* the chaos, not the styling.
3. **Draw the bento.** Assign the survivors to boxes and a grid. Name the 3–5
   above-the-fold. Group by subject (money with money, work with work), not
   round-robin.
4. **Implement additively.** Edit the view; reuse existing widget components and
   the `runAction` machinery. Do **not** change the backend payload shape for a
   pure UI revamp — if you truly need a new field, that's a separate, discussed
   change (and then regenerate `frontend/src/api/types.ts` with
   `npm run gen:types`).
5. **Self-check against the veto** before declaring done — grep your diff:
   `rounded-full.*bg-(amber|red|blue|green|emerald|indigo|violet)-(50|100|200)`,
   tinted `bg-*-50 border-*-200` resting banners, count bubbles. Remove any hit.
6. **Prove it.** `cd frontend && npm run build` and the page's `npm run test`
   (vitest) both green. A styling change that breaks a test mock is still a
   break.
7. **One page, one PR, draft.** Scope the diff to the page and its own
   components so the owner can watch the look spread and pump the brakes.

---

## Definition of done (report this back)

```
[ ] Above-the-fold budget named (3–5 things visible at ~940px, no scroll)
[ ] Long stack of full-width bands → bento of packing boxes
[ ] Every box answers a question or offers an action; empty boxes render nothing
[ ] ≥1 inline action surfaced from a box (existing endpoint, confirm+toast)
[ ] Motion budget: 150–350ms, ease-out, wrapped in prefers-reduced-motion
[ ] Built only on semantic tokens; works in light + dark; no hardcoded gray/hex
[ ] Veto grep clean (no pills / tinted banners / count bubbles / gradient cards)
[ ] No new fetch; existing payload reused
[ ] Checked at ~380px and ~940px (shell:, not lg:)
[ ] npm run build + page vitest green
```

If a box is unchecked, say so plainly and stop — do not ship a half-revamp and
call the rest "follow-up." That is how the long-scroll dashboard accreted in the
first place.

---

## Reference points already in the repo

- `frontend/src/pages/OpsBoard.jsx` — the home board. The good bones to build
  on: one fetch, packing columns, `runAction`, `/`-search, cleared-state, empty
  sections that draw nothing. The thing to fix: it's still a long vertical stack
  of sections rather than an above-the-fold bento.
- `frontend/src/components/board/SnapshotBoxes.jsx` — the canonical quiet box
  (`Box`, `Stat`): hairline card, dot header, plain ink number, record links.
  Copy this chrome.
- `frontend/src/components/ui/StatusBadge.jsx` + `frontend/src/utils/statusTone.js`
  — dot+word status, the only way to show state.
- `frontend/src/components/client/ClientOverview.jsx` — the Customer 360 page
  the owner approved ("way better, roll it out"): the section rhythm and quiet
  links to match.
