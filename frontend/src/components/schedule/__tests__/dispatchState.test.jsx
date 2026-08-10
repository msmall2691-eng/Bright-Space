/**
 * computeDispatchState pins the crew hand-off signal: shifts vs assigned
 * cleaners → sent / partial / unsent / na, plus the action gates
 * (canNotify / canResend). These mirror the Connecteam shift semantics the
 * sync badge relies on, but framed as "has the crew been told?".
 */
import { describe, it, expect } from 'vitest'
import { computeDispatchState } from '../dispatchState'

describe('computeDispatchState', () => {
  it('is "sent" when every assigned cleaner has a shift', () => {
    const s = computeDispatchState({ cleaner_ids: [1, 2], connecteam_shift_ids: ['a', 'b'] }, {})
    expect(s.state).toBe('sent')
    expect(s.canNotify).toBe(false)
    expect(s.canResend).toBe(true)
  })

  it('is "partial" when only some cleaners were pushed', () => {
    const s = computeDispatchState({ cleaner_ids: [1, 2], connecteam_shift_ids: ['a'] }, {})
    expect(s.state).toBe('partial')
    expect(s.shifts).toBe(1)
    expect(s.expected).toBe(2)
    expect(s.canNotify).toBe(true)   // still one crew member to reach
  })

  it('is "unsent" when cleaners are assigned but nothing pushed', () => {
    const s = computeDispatchState({ cleaner_ids: [1], connecteam_shift_ids: [] }, {})
    expect(s.state).toBe('unsent')
    expect(s.canNotify).toBe(true)
  })

  it('is "na" when there is no crew and no shift — nothing to hand off', () => {
    const s = computeDispatchState({ cleaner_ids: [], connecteam_shift_ids: [] }, {})
    expect(s.state).toBe('na')
    expect(s.canNotify).toBe(false)
    expect(s.canResend).toBe(false)
  })

  it('prefers the visit cleaner_ids over the job when present', () => {
    const s = computeDispatchState(
      { cleaner_ids: [1], connecteam_shift_ids: [] },
      { cleaner_ids: [1, 2, 3] },
    )
    expect(s.expected).toBe(3)
    expect(s.state).toBe('unsent')
  })

  it('offers no action on a cancelled or completed visit', () => {
    const cancelled = computeDispatchState({ cleaner_ids: [1], connecteam_shift_ids: [] }, { status: 'cancelled' })
    expect(cancelled.canNotify).toBe(false)
    const completed = computeDispatchState({ cleaner_ids: [1], connecteam_shift_ids: ['a'] }, { status: 'completed' })
    expect(completed.canResend).toBe(false)
    expect(completed.terminal).toBe(true)
  })

  it('handles connecteam_shift_ids=null defensively', () => {
    const s = computeDispatchState({ cleaner_ids: [1], connecteam_shift_ids: null }, {})
    expect(s.state).toBe('unsent')
  })

  it('treats an open-shift push (shift, no cleaners) as sent', () => {
    const s = computeDispatchState({ cleaner_ids: [], connecteam_shift_ids: ['open_1'] }, {})
    expect(s.state).toBe('sent')
  })
})
