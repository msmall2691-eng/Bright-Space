/**
 * LaunchStepper — opens at the deal's current stage and fires the matching
 * one-tap action. We mock useLaunch so the component test stays about the UI
 * wiring (the hook has its own test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const sendQuote = vi.fn()
const acceptQuote = vi.fn()
const dispatchJob = vi.fn()
const scheduleJob = vi.fn()
let hookState
vi.mock('../../../hooks/useLaunch', async () => {
  const actual = await vi.importActual('../../../hooks/useLaunch')
  return { ...actual, useLaunch: () => hookState }
})

import LaunchStepper from '../LaunchStepper'

const baseSteps = (current) => ['quote', 'send', 'accept', 'schedule', 'dispatch']
  .map(key => ({ key, done: ['quote', 'send', 'accept', 'schedule', 'dispatch'].indexOf(key) < ['quote', 'send', 'accept', 'schedule', 'dispatch'].indexOf(current) }))

beforeEach(() => {
  hookState = {
    detail: {}, loading: false, error: null, busy: false,
    steps: baseSteps('send'), currentStep: 'send',
    primaryQuote: { id: 9, status: 'draft', quote_number: 'QT-1' }, primaryJob: null,
    reload: vi.fn(), sendQuote, acceptQuote, scheduleJob, dispatchJob,
  }
})
afterEach(() => { cleanup(); sendQuote.mockReset(); acceptQuote.mockReset(); dispatchJob.mockReset(); scheduleJob.mockReset() })

const renderStepper = () => render(<MemoryRouter><LaunchStepper opportunityId={5} title="Acme" onClose={() => {}} /></MemoryRouter>)

describe('LaunchStepper', () => {
  it('shows the Send step action and fires sendQuote', () => {
    renderStepper()
    fireEvent.click(screen.getByRole('button', { name: /Send quote/ }))
    expect(sendQuote).toHaveBeenCalledTimes(1)
  })

  it('fires acceptQuote on the accept step', () => {
    hookState.steps = baseSteps('accept'); hookState.currentStep = 'accept'
    hookState.primaryQuote = { id: 9, status: 'sent' }
    renderStepper()
    fireEvent.click(screen.getByRole('button', { name: /Mark accepted/ }))
    expect(acceptQuote).toHaveBeenCalledTimes(1)
  })

  it('locks Dispatch when the job has no crew', () => {
    hookState.steps = baseSteps('dispatch'); hookState.currentStep = 'dispatch'
    hookState.primaryJob = { id: 3, status: 'scheduled', scheduled_date: '2026-08-10', cleaner_ids: [] }
    renderStepper()
    const btn = screen.getByRole('button', { name: /Send to crew/ })
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/Assign a crew/)).toBeTruthy()
  })

  it('shows the schedule form on the schedule step', () => {
    hookState.steps = baseSteps('schedule'); hookState.currentStep = 'schedule'
    hookState.primaryQuote = { id: 9, status: 'accepted' }
    renderStepper()
    // No date entered → the button offers the unscheduled path.
    fireEvent.click(screen.getByRole('button', { name: /Create job \(unscheduled\)/ }))
    expect(scheduleJob).toHaveBeenCalledWith({})
  })

  it('renders the Launched done-state when every step is done', () => {
    hookState.steps = ['quote', 'send', 'accept', 'schedule', 'dispatch'].map(key => ({ key, done: true }))
    hookState.currentStep = 'dispatch'
    renderStepper()
    expect(screen.getByText('Launched')).toBeTruthy()
  })
})
