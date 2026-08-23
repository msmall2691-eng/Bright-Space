/**
 * "When I add a job I can[’t] make it repeating because it auto defaults to
 * one time and I cant edit it." — the owner, after using the modal.
 *
 * The Repeat toggle worked the whole time. It was the third control inside a
 * collapsed "More options" disclosure, under Property and Title, so from the
 * outside the modal looked like it only made one-time jobs. A control nobody
 * can find is the same as a control that isn't there, and no test caught it
 * because every existing test opened the disclosure first.
 *
 * So what's pinned here is DISCOVERABILITY, not the toggle's mechanics:
 * Repeat is visible on the form you land on, without expanding anything, and
 * switching it on brings its own settings into view rather than leaving you
 * with "repeating" selected and nowhere to say how often.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const get = vi.fn()
const post = vi.fn()
vi.mock('../../api', () => ({ get: (...a) => get(...a), post: (...a) => post(...a) }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import JobCreateModal from '../JobCreateModal'

beforeEach(() => {
  get.mockResolvedValue([])
  post.mockResolvedValue({ id: 1 })
})
afterEach(() => { cleanup(); get.mockReset(); post.mockReset() })

const renderModal = (props = {}) =>
  render(<JobCreateModal clientId={42} clientName="Casey"
    onClose={() => {}} onCreated={() => {}} {...props} />)

describe('making a job repeat', () => {
  it('offers Repeat on the form you land on, with nothing expanded', () => {
    renderModal()
    // Not "after clicking More options" — right there, on open.
    expect(screen.getByTestId('job-create-repeat-toggle')).toBeTruthy()
    expect(screen.getByText('Repeat')).toBeTruthy()
  })

  it('sits with the date, because it decides what the date means', () => {
    // Repeat replaces the single Date field with frequency/day-of-week. A
    // toggle that does that belongs next to the field it replaces.
    renderModal()
    expect(screen.getByText(/Date \*/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('job-create-repeat-toggle'))
    expect(screen.queryByText(/Date \*/)).toBeNull()
  })

  it('says which kind of job you are about to create', async () => {
    renderModal()
    // Matched exactly, with its leading dash: the modal HEADER also reads
    // "Recurring Schedule" once the toggle is on, and a loose regex here
    // would pass on the heading while the toggle's own caption said nothing.
    expect(screen.getByText('— one-time job')).toBeTruthy()
    fireEvent.click(screen.getByTestId('job-create-repeat-toggle'))
    expect(screen.getByText('— recurring schedule')).toBeTruthy()
  })

  it('brings the repeat settings into view when you switch it on', async () => {
    // Otherwise you get "recurring" selected with no way to say how often —
    // which is the same dead end, one step later.
    renderModal()
    expect(screen.queryByText('Frequency')).toBeNull()

    fireEvent.click(screen.getByTestId('job-create-repeat-toggle'))
    expect(await screen.findByText('Frequency')).toBeTruthy()
    expect(screen.getByRole('button', { name: /weekly/i })).toBeTruthy()
    expect(screen.getByText(/Days of Week/i)).toBeTruthy()
  })

  it('leaves the options open when you switch it back off', () => {
    // Collapsing under her would hide whatever else she had opened.
    renderModal()
    fireEvent.click(screen.getByTestId('job-create-repeat-toggle'))
    fireEvent.click(screen.getByTestId('job-create-repeat-toggle'))
    expect(screen.getByText('Property')).toBeTruthy()
  })

  it('still opens straight into repeating when the caller asks for it', () => {
    // The Recurring page's "new series" entry point passes defaultRecurring.
    renderModal({ defaultRecurring: true })
    expect(screen.getByTestId('job-create-repeat-toggle').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Frequency')).toBeTruthy()
  })
})
