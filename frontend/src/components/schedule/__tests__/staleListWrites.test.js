/**
 * The four schedule-surface setters that used to write back a render-time
 * snapshot, pinned by reading the source.
 *
 * The bug class: `setX(x.filter(…))` inside an async handler. `x` was read when
 * the component rendered; by the time the line runs, a confirm dialog and a
 * request have gone by, so anything the per-row actions changed in the gap is
 * still in that array — and writing it back puts it on screen again. A row
 * already deleted on the server reappears, looking real, with nothing saying so.
 * It was first caught by hand on bulk archive (#1111), and these four are the
 * same shape found by sweeping for it.
 *
 * Why a source-level pin rather than a behaviour test: reproducing the race
 * needs two overlapping async handlers interleaved at a precise point, and
 * testing-library flushes effects inside `act()`, so the reverted code passes a
 * behaviour test comfortably. A test that passes against the bug pins nothing.
 * (`settings/__tests__/RulesPanel.test.jsx` carries the same note for the same
 * reason.)
 *
 * Why only these two files: an earlier version of this scanned all of src/ with
 * a TypeScript AST, inferring the state name from the setter name and asking
 * whether the function could have suspended first. Six review rounds found
 * three more false positives and two misses in that inference — the last being
 * `setItems(groups.flatMap(items => items))`, a wholesale replacement whose
 * callback parameter merely shares the state's spelling. A false positive in a
 * check that gates every push costs more than the bug it would catch, so the
 * inference was dropped. What is left is literal: these four call sites, in
 * these two files, keep the functional form.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEDULE = join(HERE, '..', '..', '..', 'pages', 'Schedule.jsx')
const TABS = join(HERE, '..', 'ScheduleTabs.jsx')

const read = (f) => readFileSync(f, 'utf8')

describe('the schedule list setters do not write back a render-time snapshot', () => {
  it('Schedule.jsx deletes and patches a visit functionally', () => {
    const src = read(SCHEDULE)
    // Delete: a confirm dialog plus a DELETE sit between render and this line.
    expect(src, 'the visit delete writes back `visits` captured at render')
      .not.toMatch(/setVisits\(\s*visits\b/)
    expect(src).toMatch(/setVisits\(prev => prev\.filter\(x => x\.id !== visitId\)\)/)
    // Patch: the PATCH is the gap.
    expect(src).toMatch(/setVisits\(prev => prev\.map\(x => x\.id === visitId/)
  })

  it('ScheduleTabs.jsx removes and re-statuses a time-off entry functionally', () => {
    const src = read(TABS)
    expect(src, 'the time-off handlers write back `entries` captured at render')
      .not.toMatch(/setEntries\(\s*entries\b/)
    expect(src).toMatch(/setEntries\(prev => prev\.filter\(e => e\.id !== id\)\)/)
    expect(src).toMatch(/setEntries\(prev => prev\.map\(e => \(e\.id === id \? updated : e\)\)\)/)
  })

  it('is reading the files it thinks it is', () => {
    // Without this, a renamed or moved file would make the pins above pass by
    // asserting over an empty string. The tree-wide version of this test
    // returned zero against four known instances once, for a comparable
    // reason — a guard that silently checks nothing looks exactly like clean
    // code.
    expect(read(SCHEDULE)).toContain('setVisits')
    expect(read(TABS)).toContain('setEntries')
  })
})
