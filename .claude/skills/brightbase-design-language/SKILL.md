---
name: brightbase-design-language
description: The BrightBase visual vocabulary — quiet dot+word labels, no SaaS bubbles, tokens, breakpoints, and per-role layout rules. Load before styling or building any UI, office or crew.
---

# BrightBase design language

The owner has repeatedly vetoed "typical SaaS" chrome, in these words: "I hate
the bubble labels", "hate these big bubbles", "hate all the button badges too".
Two full de-bubbling sweeps have already shipped. Do not reintroduce the
patterns below — reviewers grep for them.

## Never (owner-vetoed)

- Filled colored pill/chip labels (`rounded-full` + `bg-amber-100`-style tints)
- Solid tinted banners (yellow/blue warning bars)
- Colored count bubbles on buttons, tabs, or nav items
- Tinted icon chips on stat tiles; gradient cards
- Giant full-width colored action bars that cover content

## Always

- **Tags/status = dot + word**: 6px colored dot + plain sentence-case word in
  `text-ink-2`/`text-ink-3` (11–13px). Shared component:
  `frontend/src/components/ui/StatusBadge.jsx`. Color meanings: amber =
  needs attention, red = overdue/error, emerald = ok/done, gray = neutral/ok-
  and-quiet (e.g. synced), violet = open to crew, indigo = informational.
- **Attention = hairline card**: `bg-panel border border-hairline rounded-lg`
  with an amber dot and a small secondary action button — see
  `components/schedule/OpsAlerts.jsx`.
- **Stats = quiet data-forward**: large plain ink numbers, 11px sentence-case
  `text-ink-3` labels, hairline separation, dots only where semantic — see
  `components/schedule/OpsSummary.jsx`. Tiny inline-SVG sparklines/bars in
  ink-3/indigo are fine when a trend genuinely helps.
- **Counts on tabs/nav**: plain `text-ink-3` numbers next to the label;
  unread = small dot + bold number, never a red bubble.
- **Buttons**: ONE primary per view. Secondary =
  `bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md
  text-xs font-medium`. Tertiary = underlined text link.
- **Record links**: `text-ink hover:text-indigo-600 no-underline`. Every
  number or name that identifies a client/property/job/invoice links to it.
- **Mobile primary action**: compact FAB bottom-right, phones only
  (`md:hidden`), stacked ABOVE the assistant button (see
  `components/schedule/StickyActionBar.jsx` for z-order/offsets).

## Tokens & layout

- CSS vars (index.css, per theme): `--frame --bg --bg-2 --panel --ink --ink-2
  --ink-3 --hairline --hairline-2`. Use `bg-panel/bg-bg-2/text-ink*` Tailwind
  mappings — never hardcode grays.
- Shell breakpoint is custom **`shell:` = 900px** (the owner's window is
  ~940px — a plain `lg:` (1024px) hid an entire redesign from her once).
  Check layouts at ~380px and ~940px.
- Tables: `.bb-table/.bb-th/.bb-td/.bb-row/.bb-table-foot/.bb-check`.
- Page headers: `components/ui/PageTitle.jsx` (PageHeader/PageHero wrap it).

## Per-role rules

- **Office (admin/manager/viewer)**: density is fine, calm is mandatory.
  Schedule and communication are the #1 surfaces.
- **Crew (cleaner)**: My Day is the center of gravity; thumb-friendly targets,
  the full job card everywhere a job is tappable, WiFi/access details always
  above the fold on assigned jobs. Keep payloads light (documented my-day perf
  rule) — rural cell data is expensive; photos lazy-load behind a tap.
- **Customer-facing pages** (PublicQuote/PublicPayment/CustomerPortal): out of
  scope for these rules; do not restyle casually.

## Security constraints that shape UI

Access details (door codes, `access_notes`, wifi passwords, lockboxes) are
served ONLY to the assigned cleaner via `/api/crew/*` and to office roles —
never in AI prompts, URLs, logs, push payloads, or page titles (BB-SEC-08…12).
A UI that needs them elsewhere is a design bug, not a data-plumbing task.
