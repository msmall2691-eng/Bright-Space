/**
 * The Messages surface uses four corner radii, and one of them is an exception.
 *
 * Before this: EIGHT distinct steps across one page — `rounded-sm`, bare
 * `rounded`, `md`, `lg`, `xl`, `2xl`, `3xl`, `full`. The real problem was not
 * the extremes but the middle: `md` (26 uses), `lg` (21) and `xl` (24) were all
 * doing the same jobs, so an input, a button and a dropdown each had whichever
 * radius its author reached for that day. That inconsistency is a large part of
 * why the page read as dated — the owner could feel it without being able to
 * name it.
 *
 * The scale, taken from `brightbase-design-language` rather than invented:
 *
 *   rounded-full   dots, avatars, skeleton bars (semantic — it IS a circle)
 *   rounded-md     controls: inputs, textareas, buttons, chips, key caps
 *   rounded-lg     containers: panels, dropdowns, sheets, toasts, segmented
 *                  tracks (the thumbs inside them stay md)
 *   rounded-2xl    CHAT BUBBLES ONLY — see below
 *
 * ## Why the bubbles keep a radius nothing else has
 *
 * A message bubble with a container radius reads as a box, not as speech. The
 * large radius plus the one squared-off corner (`rounded-br-lg` outbound,
 * `rounded-bl-lg` inbound) is the messaging idiom every chat client uses, and
 * flattening it in the name of consistency would make the thread look like a
 * table of rows. So it is an exception, confined to the two components that
 * draw bubbles, and this file is where that is written down — otherwise the
 * next person tidying radii removes it and nobody remembers why it was there.
 *
 * ## Scope
 *
 * This surface only. A tree-wide radius sweep is a different, much larger
 * change, and claiming one here would be the "half-revamp called a
 * follow-up" that `brightbase-ui-revamp` warns about.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageBubble } from '../MessageBubble'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMS = join(HERE, '..')
const PAGE = join(HERE, '..', '..', '..', 'pages', 'Comms.jsx')

/** Allowed everywhere on this surface. */
const SCALE = new Set(['rounded-md', 'rounded-lg', 'rounded-full'])
/** Allowed only in the components that draw chat bubbles. */
const BUBBLE_ONLY = new Set(['rounded-2xl'])
const BUBBLE_FILES = new Set(['MessageBubble.jsx', 'CrewThreadPane.jsx'])
/** Corner-specific variants must agree with the bubble tail. */
const CORNERS = new Set(['rounded-t-lg', 'rounded-br-lg', 'rounded-bl-lg'])

/** Source with comments stripped.
 *
 *  A radius named in a comment is not a rendered radius. The rename guard in
 *  threePaneBand made exactly this mistake in its first draft — it failed on a
 *  docstring — so the lesson is applied here rather than relearned. */
const prose = (file) => readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')

const OWNED = [
  ['Comms.jsx', PAGE],
  ...readdirSync(COMMS)
    .filter(n => /\.jsx$/.test(n))
    .map(n => [n, join(COMMS, n)]),
]

/** Components from OUTSIDE comms/ that the Messages surface renders.
 *
 *  The first version of this guard scanned only the files above and claimed to
 *  check "the Messages surface". It did not: `ComposeModal` renders the shared
 *  `ui/Modal`, whose dialog panel was `rounded-2xl`, so opening New Message put
 *  a non-bubble container with the bubble radius on screen and the guard passed
 *  (codex P2 on #1159). A guard that measures the files you happened to list
 *  rather than the surface the operator sees is the same overclaim as the
 *  ContactPanel comment on #1156 — right about its own file, wrong about the
 *  thing it named.
 *
 *  Resolved from the import statements rather than hard-coded, so a NEW shared
 *  dependency with an off-scale radius is caught instead of quietly skipped.
 *  One level deep: these three are what Messages actually mounts, and chasing
 *  the full transitive graph would pull in half the app for no added truth. */
function sharedDeps() {
  const out = new Map()
  for (const [, file] of OWNED) {
    const dir = dirname(file)
    for (const m of prose(file).matchAll(/^import\s+[^'"]*from\s+'(\.[^']+)'/gm)) {
      const spec = m[1]
      if (/\/comms\/|^\.\/|\/api$|\/utils\/|\/theme\/|\/hooks\//.test(spec)) continue
      for (const ext of ['.jsx', '/index.jsx']) {
        const resolved = join(dir, spec + ext)
        try {
          readFileSync(resolved)
          out.set(spec.split('/').pop() + '.jsx', resolved)
          break
        } catch { /* not a jsx module — a .js helper or a package */ }
      }
    }
  }
  return [...out.entries()]
}

const SURFACE = [...OWNED, ...sharedDeps()]

/** Every `rounded*` class token in a file, with comments removed. */
const radiiOf = (file) => prose(file).match(/\brounded(?:-[a-z0-9]+)*\b/g) || []

describe('the Messages surface holds one radius scale', () => {
  it.each(SURFACE)('%s uses only the scale', (name, file) => {
    const offenders = [...new Set(radiiOf(file))].filter((t) => {
      if (SCALE.has(t) || CORNERS.has(t)) return false
      if (BUBBLE_ONLY.has(t)) return !BUBBLE_FILES.has(name)
      return true
    })
    expect(offenders, [
      `${name} steps outside the Messages radius scale.`,
      'Controls (inputs, buttons, chips) are rounded-md; containers (panels,',
      'dropdowns, sheets, toasts) are rounded-lg; dots, avatars and skeleton',
      'bars are rounded-full. rounded-2xl is for chat bubbles only, in',
      `${[...BUBBLE_FILES].join(' and ')}.`,
    ].join('\n')).toEqual([])
  })

  // ── the flip side: the exception has to still be in use ──────────────────
  //
  // These RENDER rather than grep, and that is the point. The first version
  // asserted `radiiOf(file)` contained 'rounded-2xl' — but MessageBubble has
  // three occurrences (the note card and both bubble variants), so flattening
  // ONE of them left the others and the assertion passed. A mutation check
  // caught it: "the bubble radius is flattened away" survived. Rendering asks
  // the question that matters — does the bubble element carry it — instead of
  // asking whether the string appears anywhere in the file.
  afterEach(cleanup)

  /** The class list of the rendered bubble, found by the radius it must have. */
  const bubbleClass = (over) => {
    const { container } = render(
      <MessageBubble isFirst contactName="Sam Rivera"
        m={{ id: 1, channel: 'sms', body: 'hello', created_at: '2026-10-01T12:00:00Z', ...over }} />,
    )
    const el = [...container.querySelectorAll('div')]
      .find(d => /\brounded-2xl\b/.test(d.className))
    return el ? el.className : ''
  }

  it('an outbound bubble keeps the radius and the right-hand tail', () => {
    const cls = bubbleClass({ direction: 'outbound', author: 'Meg', status: 'delivered' })
    expect(cls, 'no element carries the bubble radius any more').toMatch(/\brounded-2xl\b/)
    expect(cls, 'outbound bubbles square off at the bottom-RIGHT').toMatch(/\brounded-br-lg\b/)
  })

  it('an inbound bubble keeps the radius and the left-hand tail', () => {
    const cls = bubbleClass({ direction: 'inbound' })
    expect(cls).toMatch(/\brounded-2xl\b/)
    expect(cls, 'inbound bubbles square off at the bottom-LEFT').toMatch(/\brounded-bl-lg\b/)
  })

  it('the crew pane draws the same shape', () => {
    // Source-pinned rather than rendered: in CrewThreadPane the radius is on
    // the outer div and the tails are in conditional branches, so there is no
    // single class list to read — and rendering it would mean standing up its
    // whole fetch. Three literals, each mutation-checked.
    const src = prose(join(COMMS, 'CrewThreadPane.jsx'))
    expect(src, 'the crew bubble lost its radius').toMatch(/\brounded-2xl\b/)
    expect(src).toMatch(/\brounded-br-lg\b/)
    expect(src).toMatch(/\brounded-bl-lg\b/)
  })

  it('gives every bubble the same squared-off tail', () => {
    // `rounded-br-lg` / `rounded-bl-lg`. The crew pane used -md while the
    // client thread used -lg, so the two chat views had visibly different
    // bubbles for no reason.
    const bubbles = [...BUBBLE_FILES].flatMap(n => radiiOf(join(COMMS, n)))
    const tails = bubbles.filter(t => /^rounded-(br|bl)-/.test(t))
    expect(tails.length, 'no bubble tails found — the idiom is gone').toBeGreaterThan(0)
    expect([...new Set(tails)].sort()).toEqual(['rounded-bl-lg', 'rounded-br-lg'])
  })

  it('is actually looking at the surface', () => {
    // Vacuity check. A walker that found no files, or files with no radii,
    // would make every assertion above pass for the wrong reason.
    expect(SURFACE.length).toBeGreaterThan(15)
    const total = SURFACE.reduce((n, [, f]) => n + radiiOf(f).length, 0)
    expect(total).toBeGreaterThan(80)
  })

  it('reaches past comms/ into the components Messages mounts', () => {
    // The specific gap codex found. If the import resolution silently stops
    // working — a renamed path, a changed import style — the scale assertions
    // above go back to covering only comms-owned files while still claiming
    // the surface, which is the failure this whole block exists to prevent.
    const names = sharedDeps().map(([n]) => n)
    expect(names, 'shared dependency resolution found nothing').not.toEqual([])
    expect(names, 'ui/Modal is the one that was actually violating; it must stay covered')
      .toContain('Modal.jsx')
    expect(names).toContain('AiInsight.jsx')
  })
})
