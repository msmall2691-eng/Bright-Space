/**
 * The scope dialog is the ONLY explanation the owner gets before a change
 * reshapes a whole series, so its three sentences have to be true. Two weren't.
 *
 *   "All visits in the series" said the change applied to "past and future"
 *   visits. The backend's _resync_future_jobs filters `scheduled_date >= today`
 *   — a completed visit is never touched. The copy invited her to expect
 *   history to move, and to reach for this scope to correct something already
 *   done.
 *
 *   "This and all future visits" read like a gentle switch to a new day and
 *   time. split_schedule retires the series by end-date and builds a NEW one,
 *   regenerating every future visit with new ids; per-visit skips and
 *   reschedules on the old series do not come across. That's a different
 *   operation than the one the sentence described.
 *
 * These assertions are deliberately about MEANING, not wording — they'd fail
 * again if either claim came back, and they don't care how the rest is phrased.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import RecurrenceScopeDialog from '../RecurrenceScopeDialog'

afterEach(cleanup)

const open = (props = {}) =>
  render(<RecurrenceScopeDialog onChoose={() => {}} onCancel={() => {}} {...props} />)

describe('RecurrenceScopeDialog — what it promises must be what happens', () => {
  it('does not claim a series edit reaches visits already done', () => {
    open()
    expect(screen.queryByText(/past and future/i)).toBeNull()
    expect(screen.getByText(/Visits already done stay as they were/i)).toBeTruthy()
  })

  it('warns that "this and all future" rebuilds the series from here', () => {
    open()
    const detail = screen.getByText(/starts over from this visit/i).textContent
    // The part that actually costs her something: per-visit skips and
    // reschedules are lost in the rebuild.
    expect(detail).toMatch(/not carried over/i)
  })

  it('leads with the safe choice and still offers all three', () => {
    open()
    for (const label of ['This visit only', 'This and all future visits', 'All visits in the series']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }
    expect(screen.getByText('Most common')).toBeTruthy()
  })

  it('offers only the single-visit scope when cancelling', () => {
    // Ending a whole series is a Recurring-page action, not this dialog's job.
    open({ mode: 'delete' })
    expect(screen.getByText('Cancel this repeating visit?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /This visit only/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /All visits in the series/ })).toBeNull()
  })

  it('cannot be answered twice while a choice is being applied', () => {
    const onChoose = vi.fn()
    open({ onChoose, busy: true })
    fireEvent.click(screen.getByRole('button', { name: /This visit only/ }))
    expect(onChoose).not.toHaveBeenCalled()
  })
})
