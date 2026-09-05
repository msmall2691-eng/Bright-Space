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
  keepOneCopyPerGroup,
  guardLastScheduleForClient,
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
  it('batches the identical ones, plus the two guarded cancels', () => {
    // duplicate_paused joined deliberately: the scan now groups paused COPIES
    // of one series, and reducing each group to "everything but the keeper" is
    // a mechanical rule, which is what makes it bulk-able where live
    // `duplicate` still isn't.
    expect(Object.keys(BULK_FIXES).sort())
      .toEqual(['duplicate_paused', 'ended_but_active', 'junk_title', 'stale_paused'])
  })

  it('marks cancelling as the destructive one', () => {
    // It is the only fix that ends something, so the confirm must read as a
    // warning rather than as another tidy-up.
    expect(BULK_FIXES.stale_paused.danger).toBe(true)
    expect(BULK_FIXES.stale_paused.method).toBe('delete')
    expect(BULK_FIXES.ended_but_active.danger).toBeFalsy()
    expect(BULK_FIXES.junk_title.danger).toBeFalsy()
  })

  it('never batches the fix that creates visits', () => {
    // "Generate visits" puts real work on the calendar and on crew phones, and
    // undoing it means deleting jobs — which must never happen automatically.
    expect(BULK_FIXES.active_no_upcoming).toBeUndefined()
  })

  it('keeps one copy per duplicate group, and names the one it kept', () => {
    // Without this reduction "cancel all" would cancel the keeper too. The
    // survivor is the copy that still has visits on the calendar — cancelling
    // that one would take real work off the schedule.
    const group = [11, 12, 13]
    const mk = (id, upcoming) => ({
      schedule_id: id, title: `Copy ${id}`, client_name: 'Bre', client_id: 5,
      cadence: 'Every 4 weeks Tue', upcoming_job_count: upcoming,
      problems: [{ code: 'duplicate_paused',
                   partners: group.filter(g => g !== id) }],
    })
    const { list, held, heldReason } = keepOneCopyPerGroup(
      [mk(11, 0), mk(12, 2), mk(13, 0)])

    expect(held.map(i => i.schedule_id)).toEqual([12])
    expect(list.map(i => i.schedule_id).sort()).toEqual([11, 13])
    // The confirm has to be able to say which one stayed.
    expect(heldReason).toMatch(/kept/)
  })

  it('falls back to the most recent copy when none has visits', () => {
    const group = [21, 22]
    const mk = (id) => ({
      schedule_id: id, title: `Copy ${id}`, client_id: 5, cadence: 'Weekly Mon',
      upcoming_job_count: 0,
      problems: [{ code: 'duplicate_paused', partners: group.filter(g => g !== id) }],
    })
    const { list, held } = keepOneCopyPerGroup([mk(21), mk(22)])
    expect(held.map(i => i.schedule_id)).toEqual([22])
    expect(list.map(i => i.schedule_id)).toEqual([21])
  })

  it('keeps groups separate — two clients are two decisions', () => {
    const mk = (id, partners, client) => ({
      schedule_id: id, title: `Copy ${id}`, client_id: client, cadence: 'Weekly',
      upcoming_job_count: 0,
      problems: [{ code: 'duplicate_paused', partners }],
    })
    const { list, held } = keepOneCopyPerGroup([
      mk(31, [32], 1), mk(32, [31], 1),
      mk(41, [42], 2), mk(42, [41], 2),
    ])
    expect(held.map(i => i.schedule_id).sort()).toEqual([32, 42])
    expect(list.map(i => i.schedule_id).sort()).toEqual([31, 41])
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
    // active_no_upcoming is not in the list at all (its fix creates visits).
    // stale_paused IS bulk-able, but with no schedules passed its guard can't
    // tell a spare leftover from a client's last schedule, so it holds
    // everything back — the safe read, and the reason this comes back empty.
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


/**
 * The guard on bulk cancel.
 *
 * Every leftover looks the same to the scan: inactive, nothing upcoming. But a
 * leftover whose client still has a live series is genuinely spare, while one
 * whose client has nothing live IS that customer's whole arrangement — the
 * owner's Bre Lynch, paused with nothing upcoming and no other schedule
 * anywhere. Sweeping that one up would quietly end a real customer's cleans.
 */
describe('bulk cancel never ends a client’s only schedule', () => {
  const leftover = (id, clientId) => ({
    schedule_id: id, client_id: clientId, title: `Series ${id}`,
    client_name: `Client ${clientId}`, cadence: 'Biweekly Thu',
    problems: [{ code: 'stale_paused', severity: 'info' }],
  })
  // Client 1 has a live series; client 9 has nothing live at all.
  const schedules = [
    { id: 100, client_id: 1, active: true },
    { id: 101, client_id: 9, active: false },
  ]

  it('sweeps the spare ones and holds back the last one', () => {
    const { list, held, heldReason } = guardLastScheduleForClient(
      [leftover(1, 1), leftover(2, 1), leftover(3, 9)], { schedules })

    expect(list.map(i => i.schedule_id)).toEqual([1, 2])
    expect(held.map(i => i.schedule_id)).toEqual([3])
    expect(heldReason).toMatch(/only schedule/i)
  })

  it('counts an ended series as not live, so its leftovers are held too', () => {
    // active:true but past its end date is how a split retires a predecessor —
    // that client has nothing running either.
    const ended = [{ id: 102, client_id: 7, active: true, series_end_date: '2020-01-01' }]
    const { list, held } = guardLastScheduleForClient(
      [leftover(4, 7)], { schedules: ended })
    expect(list).toEqual([])
    expect(held.map(i => i.schedule_id)).toEqual([4])
  })

  it('holds everything back rather than guessing when the list is missing', () => {
    // No schedules means no way to tell spare from only — the safe read is
    // "don't cancel anything", not "cancel everything".
    const { list, held } = guardLastScheduleForClient([leftover(5, 1)], {})
    expect(list).toEqual([])
    expect(held).toHaveLength(1)
  })

  it('offers no bulk button when the guard leaves fewer than two', () => {
    const groups = groupBulkable(
      [leftover(1, 9), leftover(2, 9)], { schedules })
    expect(groups.find(g => g.code === 'stale_paused')).toBeUndefined()
  })

  it('carries the held-back ones through grouping so the confirm can name them', () => {
    const groups = groupBulkable(
      [leftover(1, 1), leftover(2, 1), leftover(3, 9)], { schedules })
    const g = groups.find(x => x.code === 'stale_paused')
    expect(g.list).toHaveLength(2)
    expect(g.held.map(i => i.schedule_id)).toEqual([3])
  })
})

describe('the cancel confirm', () => {
  const item = (id, name) => ({
    schedule_id: id, client_id: 1, title: `Series ${id}`,
    client_name: name, cadence: 'Every 4 weeks Tue',
  })

  it('names every series being cancelled, with its client and cadence', () => {
    const text = describeBatch(BULK_FIXES.stale_paused,
      [item(1, 'Anna Sweet'), item(2, 'Casey Allison')])
    expect(text).toContain('Series 1 · Anna Sweet · Every 4 weeks Tue')
    expect(text).toContain('Series 2 · Casey Allison · Every 4 weeks Tue')
    expect(text).toContain('(2 series)')
  })

  it('says what it is deliberately NOT touching, and why', () => {
    // A sweep that silently skipped rows would send her hunting for them.
    const text = describeBatch(BULK_FIXES.stale_paused,
      [item(1, 'Anna Sweet')], 8, [item(9, 'Bre Lynch')],
      'it is the only schedule that client has left')
    expect(text).toContain('Leaving 1 alone')
    expect(text).toContain('only schedule that client has left')
    expect(text).toContain('Series 9 · Bre Lynch')
  })

  it('tells the truth about what cancelling keeps', () => {
    const text = describeBatch(BULK_FIXES.stale_paused, [item(1, 'Anna Sweet')])
    expect(text).toContain('Past and completed visits are untouched')
    expect(text).toContain('resumed later from Manage')
  })
})
