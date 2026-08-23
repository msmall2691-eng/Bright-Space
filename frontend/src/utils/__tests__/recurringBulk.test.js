/**
 * Recurring Doctor bulk fixes.
 *
 * This writes to a live book of business in a loop, so what's pinned is the
 * judgement rather than the mechanics: which problems may be batched at all,
 * that the operator sees every series by name before anything is written, that
 * one failure doesn't swallow the rest, and that the writes go one at a time.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  BULK_FIXES, betterTitle, groupBulkable, applyBatch, describeBatch,
} from '../recurringBulk'

const issue = (id, code, extra = {}) => ({
  schedule_id: id,
  title: `Series ${id}`,
  client_name: 'Anna Sweet',
  cadence: 'Weekly on Wed',
  problems: [{ code, severity: 'warn', message: 'x', suggestion: 'y' }],
  ...extra,
})

describe('which fixes may be applied in bulk', () => {
  it('batches only the reversible, identical ones', () => {
    expect(Object.keys(BULK_FIXES).sort()).toEqual(['ended_but_active', 'junk_title'])
  })

  it('never batches the fix that creates visits', () => {
    // "Generate visits" puts real work on the calendar and on crew phones, and
    // undoing it means deleting jobs — which must never happen automatically.
    expect(BULK_FIXES.active_no_upcoming).toBeUndefined()
  })

  it('never batches the destructive one', () => {
    expect(BULK_FIXES.stale_paused).toBeUndefined()
  })

  it('never batches the ones with no single right answer', () => {
    // Which duplicate survives, and which property to relink to, differ per
    // series — there is no fix to repeat.
    for (const code of ['duplicate', 'property_missing', 'no_property']) {
      expect(BULK_FIXES[code]).toBeUndefined()
    }
  })
})

describe('groupBulkable', () => {
  it('groups a shared problem across series', () => {
    const groups = groupBulkable([
      issue(1, 'ended_but_active'),
      issue(2, 'ended_but_active'),
      issue(3, 'ended_but_active'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].code).toBe('ended_but_active')
    expect(groups[0].list.map(i => i.schedule_id)).toEqual([1, 2, 3])
  })

  it('offers nothing when only one series has the problem', () => {
    // A "fix all (1)" button beside the per-row link for that same series is
    // two buttons doing one thing.
    expect(groupBulkable([issue(1, 'ended_but_active')])).toEqual([])
  })

  it('ignores problems that are not bulk-able', () => {
    expect(groupBulkable([
      issue(1, 'active_no_upcoming'),
      issue(2, 'active_no_upcoming'),
      issue(3, 'stale_paused'),
      issue(4, 'stale_paused'),
    ])).toEqual([])
  })

  it('picks up a series whose bulk-able problem is not its first', () => {
    const messy = {
      ...issue(9, 'no_property'),
      problems: [
        { code: 'no_property', severity: 'info' },
        { code: 'ended_but_active', severity: 'warn' },
      ],
    }
    const groups = groupBulkable([messy, issue(10, 'ended_but_active')])
    expect(groups[0].list.map(i => i.schedule_id)).toEqual([9, 10])
  })

  it('survives a scan with no issues at all', () => {
    expect(groupBulkable([])).toEqual([])
    expect(groupBulkable(undefined)).toEqual([])
  })
})

describe('what each fix writes', () => {
  it('marking ended only flips active, touching nothing else', () => {
    expect(BULK_FIXES.ended_but_active.body(issue(1, 'ended_but_active')))
      .toEqual({ active: false })
  })

  it('renaming uses the same name the per-row fix would', () => {
    const i = issue(1, 'junk_title', { title: 'biweekly' })
    expect(BULK_FIXES.junk_title.body(i)).toEqual({ title: 'Anna Sweet — Weekly on Wed' })
    expect(betterTitle(i)).toBe('Anna Sweet — Weekly on Wed')
  })

  it('falls back to the cadence when the client name is missing', () => {
    expect(betterTitle({ client_name: null, cadence: 'Every 2 weeks' })).toBe('Every 2 weeks')
  })
})

describe('describeBatch', () => {
  it('names every series that will change', () => {
    const list = [issue(1, 'ended_but_active'), issue(2, 'ended_but_active')]
    const text = describeBatch(BULK_FIXES.ended_but_active, list)
    expect(text).toContain('Series 1 · Anna Sweet')
    expect(text).toContain('Series 2 · Anna Sweet')
    expect(text).toContain('(2 series)')
    expect(text).toContain('History and completed visits are kept')
  })

  it('shows a rename as before → after', () => {
    const list = [
      issue(1, 'junk_title', { title: 'biweekly' }),
      issue(2, 'junk_title', { title: 'weekly' }),
    ]
    expect(describeBatch(BULK_FIXES.junk_title, list))
      .toContain('“biweekly” → “Anna Sweet — Weekly on Wed”')
  })

  it('caps the list but says how many more there are', () => {
    const list = Array.from({ length: 12 }, (_, n) => issue(n, 'ended_but_active'))
    const text = describeBatch(BULK_FIXES.ended_but_active, list, 8)
    expect(text).toContain('(12 series)')
    expect(text).toContain('…and 4 more')
    expect(text).not.toContain('Series 9 ·')
  })
})

describe('applyBatch', () => {
  it('writes one at a time, never all at once', async () => {
    // A dozen simultaneous writes against one small container is how a
    // cleanup becomes an outage.
    let live = 0
    let peak = 0
    const apply = vi.fn(async () => {
      live += 1; peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 1))
      live -= 1
    })
    await applyBatch([issue(1, 'x'), issue(2, 'x'), issue(3, 'x')], apply)
    expect(apply).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
  })

  it('keeps going after a failure and names what did not make it', async () => {
    const apply = vi.fn(async (i) => {
      if (i.schedule_id === 2) throw new Error('409')
    })
    const { done, failed } = await applyBatch(
      [issue(1, 'x'), issue(2, 'x'), issue(3, 'x')], apply)

    expect(done).toBe(2)
    expect(failed).toEqual(['Series 2'])
    expect(apply).toHaveBeenCalledTimes(3)   // the third still ran
  })

  it('identifies a failed series by id when it has no title', async () => {
    const apply = async () => { throw new Error('nope') }
    const { failed } = await applyBatch([{ schedule_id: 7, title: '' }], apply)
    expect(failed).toEqual(['#7'])
  })
})
