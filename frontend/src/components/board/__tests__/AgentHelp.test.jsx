/**
 * AgentHelp — the always-visible "Ask an agent" widget on Home.
 *
 * What's pinned here is the behaviour the widget exists for: the prompts are
 * grounded in the day's free followup scan (and stay useful when that scan
 * says nothing or fails), tapping one actually asks the SAME endpoint the
 * board assistant uses, and nothing about a failure ever renders as an error
 * card on the dashboard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), getCached: vi.fn() }))

import { getCached, post } from '../../../api'
import AgentHelp from '../AgentHelp'

const SCAN = {
  total: 2,
  followups: [
    { title: '3 overdue invoice(s)', detail: '$1,200 past due across 3 invoice(s).',
      action: 'Send payment reminders', severity: 'high', href: '/billing?view=invoices' },
    { title: '2 upcoming job(s) with no cleaner', detail: 'Next 7 days.',
      action: 'Assign a cleaner', severity: 'medium', href: '/schedule' },
  ],
}

beforeEach(() => {
  getCached.mockReset()
  post.mockReset()
  localStorage.clear()
})
afterEach(cleanup)

describe('AgentHelp', () => {
  it('grounds its prompts in the day’s followup scan, topped up with general ones', async () => {
    getCached.mockResolvedValue(SCAN)
    render(<AgentHelp navigate={vi.fn()} />)

    // Contextual, from the scan…
    expect(await screen.findByText('Chase overdue invoices')).toBeTruthy()
    expect(screen.getByText('Jobs with no cleaner')).toBeTruthy()
    // …and a general one so the row is never thin.
    expect(screen.getByText('What needs me today?')).toBeTruthy()

    // The scan is the free deterministic one, not a second board/brief fetch.
    expect(getCached.mock.calls[0][0]).toBe('/api/ai/followup-check')
  })

  it('shows a loading state before the scan lands', async () => {
    let resolve
    getCached.mockReturnValue(new Promise(r => { resolve = r }))
    const { container } = render(<AgentHelp navigate={vi.fn()} />)

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText('What needs me today?')).toBeNull()

    resolve(SCAN)
    expect(await screen.findByText('Chase overdue invoices')).toBeTruthy()
  })

  it('tapping a prompt asks the same endpoint the board assistant uses', async () => {
    getCached.mockResolvedValue(SCAN)
    post.mockResolvedValue({ answer: 'Three invoices are overdue.', error: false })
    render(<AgentHelp navigate={vi.fn()} />)

    fireEvent.click(await screen.findByText('Chase overdue invoices'))

    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/api/ai/quick')
    expect(body.page_context).toBe('dashboard')
    expect(body.question).toMatch(/overdue/i)
    expect(await screen.findByText(/Three invoices are overdue/)).toBeTruthy()
  })

  it('hands the prompt to the full assistant when the parent offers one', async () => {
    getCached.mockResolvedValue(SCAN)
    const onOpenAssistant = vi.fn()
    render(<AgentHelp navigate={vi.fn()} onOpenAssistant={onOpenAssistant} />)

    fireEvent.click(await screen.findByText('Chase overdue invoices'))

    expect(onOpenAssistant).toHaveBeenCalledTimes(1)
    expect(onOpenAssistant.mock.calls[0][0]).toMatch(/overdue/i)
    // No second conversation: the widget doesn't also ask on its own.
    expect(post).not.toHaveBeenCalled()
  })

  it('degrades quietly when the scan fails — general prompts, no error card', async () => {
    getCached.mockRejectedValue(new Error('offline'))
    render(<AgentHelp navigate={vi.fn()} />)

    expect(await screen.findByText('What needs me today?')).toBeTruthy()
    expect(screen.queryByText(/couldn.t load/i)).toBeNull()
    expect(screen.queryByText(/error/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('says one calm line when the model can’t answer', async () => {
    getCached.mockResolvedValue(SCAN)
    post.mockRejectedValue(new Error('500'))
    render(<AgentHelp navigate={vi.fn()} />)

    fireEvent.click(await screen.findByText('Chase overdue invoices'))

    expect(await screen.findByText(/couldn’t answer that right now/i)).toBeTruthy()
    // Still a usable widget, not a dead card.
    expect(screen.getByText('Ask something else')).toBeTruthy()
  })

  it('stays useful when nothing is flagged', async () => {
    getCached.mockResolvedValue({ total: 0, followups: [] })
    render(<AgentHelp navigate={vi.fn()} />)

    expect(await screen.findByText(/nothing.s flagged right now/i)).toBeTruthy()
    expect(screen.getByText('What needs me today?')).toBeTruthy()
    expect(screen.getByText('How does this week look?')).toBeTruthy()
  })

  it('reuses the day’s cached scan instead of fetching again', async () => {
    const today = new Date()
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    localStorage.setItem('brightbase_workspace_suggestions',
      JSON.stringify({ date: ymd, items: SCAN.followups, dismissed: true }))

    render(<AgentHelp navigate={vi.fn()} />)

    expect(await screen.findByText('Chase overdue invoices')).toBeTruthy()
    expect(getCached).not.toHaveBeenCalled()
  })

  it('links out to the agents workspace', async () => {
    const navigate = vi.fn()
    getCached.mockResolvedValue(SCAN)
    render(<AgentHelp navigate={navigate} />)

    fireEvent.click(await screen.findByText('Agents'))
    expect(navigate).toHaveBeenCalledWith('/workspace')
  })
})
