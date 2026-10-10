/**
 * `EditSeriesModal` can be opened from the list row, and that is only safe
 * because the list payload is the same dict as the detail payload.
 *
 * ## The failure this guards is silent
 *
 * The modal seeds its form from the `schedule` object it is handed, with a
 * fallback on nearly every field:
 *
 *     start_time: (schedule.start_time || '09:00').slice(0, 5)
 *     generate_weeks_ahead: schedule.generate_weeks_ahead || 8
 *     ends_mode: schedule.ends_mode || 'never'
 *
 * Those fallbacks exist for a brand-new series. Hand the same form a payload
 * that is merely INCOMPLETE and nothing errors — the field quietly reads as
 * the default, and submitting PATCHes that default over the real value. A
 * series generating 2 weeks ahead becomes 8; a series that ends on a date
 * becomes one that never ends. No exception, no console warning, and the row
 * still looks right until someone reads the rule.
 *
 * Today both endpoints return `sched_to_dict`, so every field is present.
 * This pins that, from the one direction that can rot: the modal gaining a
 * `schedule.<field>` the serializer does not emit.
 *
 * ## Why it reads the backend source
 *
 * Because the claim is about the backend. A frontend-only check could only
 * compare the modal against a fixture written from the same assumption. The
 * sibling pattern in `projectionParity.test.js` goes through a generated
 * fixture plus a backend test that re-checks it, which is the right shape for
 * nineteen cases of date math; for one key list, reading the serializer is
 * both exact and cheaper. If the file cannot be found this FAILS rather than
 * skipping — a parity test that silently stops comparing is the thing it is
 * supposed to prevent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODAL = join(HERE, '..', 'EditSeriesModal.jsx')
const ROUTER = join(HERE, '..', '..', '..', '..', '..', 'backend', 'modules', 'recurring', 'router.py')

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(
      `could not read ${p} — this test compares the edit form against the `
      + `backend serializer, and cannot do that from a frontend-only checkout. `
      + `Fix the path rather than skipping: ${e.message}`,
    )
  }
}

/** The body of `def sched_to_dict(...)`, up to the next top-level `def`. */
function schedToDict(src) {
  const start = src.indexOf('def sched_to_dict')
  expect(start, 'sched_to_dict is gone from modules/recurring/router.py').toBeGreaterThan(-1)
  const rest = src.slice(start + 1)
  const end = rest.search(/\ndef /)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Keys the serializer emits, from its `"name":` literals. */
const emittedKeys = (body) =>
  new Set([...body.matchAll(/^\s*"([a-z_]+)":/gm)].map(m => m[1]))

/** Fields the edit form reads off the schedule it is given. */
const fieldsRead = (src) =>
  new Set([...src.matchAll(/\bschedule\.([a-z_]+)/g)].map(m => m[1]))

describe('the edit form only reads fields the API actually sends', () => {
  const body = schedToDict(read(ROUTER))
  const emitted = emittedKeys(body)
  const read_ = fieldsRead(read(MODAL))

  it('finds every schedule.<field> the modal reads in sched_to_dict', () => {
    const missing = [...read_].filter(f => !emitted.has(f))
    expect(missing, [
      'EditSeriesModal pre-fills from fields the recurring serializer does not send.',
      'Each one silently falls back to a default and PATCHes that default over',
      'the real value on save. Either add the key to sched_to_dict in',
      'backend/modules/recurring/router.py, or stop reading it here.',
      `  missing: ${missing.join(', ')}`,
    ].join('\n')).toEqual([])
  })

  it('is comparing two real, non-empty sets', () => {
    // Vacuity. A regex that stopped matching — a reformat of the dict, a
    // rename of the prop — would make the assertion above pass by comparing
    // nothing, which is exactly how a parity check rots into decoration.
    expect(emitted.size, 'parsed no keys out of sched_to_dict').toBeGreaterThan(20)
    expect(read_.size, 'parsed no schedule.<field> reads out of the modal').toBeGreaterThan(10)
    // Spot-check the three with the most damaging fallbacks, so a regex that
    // matched only the easy names still fails.
    for (const f of ['start_time', 'generate_weeks_ahead', 'ends_mode']) {
      expect(read_, `the modal no longer reads ${f} — update this check`).toContain(f)
      expect(emitted, `sched_to_dict no longer sends ${f}`).toContain(f)
    }
  })
})
