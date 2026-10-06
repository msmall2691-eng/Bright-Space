/**
 * The crew surface carries no hand-written status dot.
 *
 * `__tests__/boardToneContrast.test.js` proves that `STATUS_DOT`'s steps clear
 * the 3:1 non-text floor. It cannot prove anyone USES them — a single
 * `bg-amber-500` written straight into a span is invisible to it, and that is
 * exactly how all 89 of these got here in the first place. So this is the
 * other half: the measured map is correct, and the crew surface goes through
 * it.
 *
 * Crew first because it is the worst case. A cleaner reads these on a phone,
 * outdoors, in direct sun. `bg-amber-500` — the step that meant "this needs
 * you" — measured 1.77:1 against the app's own grounds, well under half the
 * floor, and amber was the most common dot on the surface.
 *
 * ## What this does NOT flag, and why
 *
 * - **A state prefix.** `hover:bg-amber-500` / `active:` / `focus:` are
 *   transient feedback on an otherwise plain row, which the design language
 *   explicitly allows ("don't flatten hover states while chasing this rule").
 *   A resting fill is the vetoed thing; a hover tint is not.
 * - **`text-*` colours.** Different floor (4.5:1, not 3:1) and genuinely
 *   different judgement per site — a link blue, a money green and a decorative
 *   icon amber are three different questions. They are a separate slice, and
 *   lumping them in here would mean this test could not state one clear rule.
 * - **`bg-indigo-*`.** Indigo is remapped onto `--accent-*` in this repo
 *   (BB-A11Y-03), so it is the accent rather than a status colour, and
 *   `accentLinkContrast` already owns it.
 * - **`bg-ink-3`, `bg-ink-3/40`, `bg-white`.** Token-based or a deliberate
 *   on-selected inverse. How loud "inactive" should be is a design decision
 *   about quietness, not a contrast fix, and the owner has settled views on
 *   quietness.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CREW = join(here, '..')
const SRC = join(CREW, '..', '..')

/** Hues that carry status meaning. `indigo` is the accent; see the header. */
const STATUS_HUES = 'emerald|amber|red|rose|blue|green|yellow|orange|gray|slate|zinc'

/** A resting background on a failing step — the thing being banned. The
 *  negative lookbehind for `:` is what exempts `hover:` / `active:` / `dark:`
 *  and any other variant prefix. */
const RAW_DOT = new RegExp(String.raw`(?<![\w:-])bg-(?:${STATUS_HUES})-(?:400|500)\b`, 'g')

function files() {
  const out = []
  for (const name of readdirSync(CREW)) {
    if (name.endsWith('.jsx') || name.endsWith('.js')) out.push(join(CREW, name))
  }
  out.push(join(SRC, 'pages', 'MyDay.jsx'))
  return out
}

describe('BB-A11Y-02 — crew status dots go through the measured map', () => {
  it('reads the crew surface at all', () => {
    // Non-vacuity. A glob that quietly matched nothing would make every
    // assertion below pass forever, which is the failure mode of every
    // source-scanning test.
    const all = files()
    expect(all.length).toBeGreaterThan(10)
    expect(all.some(f => f.endsWith('MyDay.jsx'))).toBe(true)
    expect(readFileSync(all[0], 'utf8').length).toBeGreaterThan(0)
  })

  it('has no hand-written status dot left', () => {
    const offenders = []
    for (const f of files()) {
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(RAW_DOT)) {
          offenders.push(`${f.replace(SRC + '/', '')}:${i + 1}  ${m[0]}`)
        }
      })
    }
    expect(offenders,
      'These are resting status fills on a step that misses the 3:1 non-text ' +
      'floor (amber-500 is 1.77:1). Use STATUS_DOT from src/theme/statusDots.js:\n  '
      + offenders.join('\n  ')).toEqual([])
  })

  it('actually imports the map where it uses it', () => {
    // The other direction: a file could reference STATUS_DOT and never import
    // it, which renders `undefined` into the class string — a dot with no
    // colour at all, which looks "fine" in a passing contrast test.
    const missing = []
    for (const f of files()) {
      const src = readFileSync(f, 'utf8')
      if (src.includes('STATUS_DOT') && !src.includes('statusDots')) {
        missing.push(f.replace(SRC + '/', ''))
      }
    }
    expect(missing, `uses STATUS_DOT without importing it: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('the pattern it bans is the pattern that was there, and it spares hover', () => {
    // Proof the regex catches the real thing and exempts the allowed one —
    // without this, a regex that matched nothing would pass case 2 silently.
    const caught = s => [...s.matchAll(RAW_DOT)].map(m => m[0])
    expect(caught('<span className="w-1.5 h-1.5 rounded-full bg-amber-500" />'))
      .toEqual(['bg-amber-500'])
    expect(caught("dot: 'bg-emerald-500'")).toEqual(['bg-emerald-500'])
    expect(caught("on ? 'bg-emerald-500' : 'bg-gray-400'"))
      .toEqual(['bg-emerald-500', 'bg-gray-400'])

    // Allowed, and must stay allowed.
    expect(caught('hover:bg-amber-500 active:bg-red-500')).toEqual([])
    expect(caught('dark:bg-emerald-400')).toEqual([])
    expect(caught('group-hover:bg-blue-500')).toEqual([])
    // Not a status hue, and not a failing step.
    expect(caught('bg-indigo-500 bg-white bg-ink-3/40 bg-emerald-700')).toEqual([])
  })
})
