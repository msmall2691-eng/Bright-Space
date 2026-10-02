import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const roleRef = { value: 'admin' }
vi.mock('../../../nav/routes', () => ({ currentRole: () => roleRef.value }))
const askBoard = vi.fn()
vi.mock('../askBoard', () => ({ askBoard: (...a) => askBoard(...a) }))
// Stub the markdown renderer so answers assert as plain text.
vi.mock('../../workspace/MarkdownContent', () => ({ default: ({ content }) => <div>{content}</div> }))

import NovaChat from '../NovaChat'

const navigate = vi.fn()
beforeEach(() => { roleRef.value = 'admin'; navigate.mockReset(); askBoard.mockReset() })
afterEach(cleanup)

describe('NovaChat', () => {
  it('offers suggestions when empty and answers one', async () => {
    askBoard.mockResolvedValue({ answer: '3 turnovers need a cleaner.', error: false })
    render(<NovaChat navigate={navigate} />)
    fireEvent.click(screen.getByText("Who's unassigned this weekend?"))
    expect(askBoard).toHaveBeenCalledWith("Who's unassigned this weekend?")
    await waitFor(() => expect(screen.getByText('3 turnovers need a cleaner.')).toBeTruthy())
  })

  it('sends a typed question and shows the user turn + answer', async () => {
    askBoard.mockResolvedValue({ answer: 'You have 2 overdue invoices.', error: false })
    render(<NovaChat navigate={navigate} />)
    const input = screen.getByLabelText('Ask Nova')
    fireEvent.change(input, { target: { value: 'which invoices are overdue?' } })
    fireEvent.submit(input.closest('form'))
    expect(screen.getByText('which invoices are overdue?')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('You have 2 overdue invoices.')).toBeTruthy())
  })

  it('shows a calm message on error', async () => {
    askBoard.mockResolvedValue({ answer: '', error: true })
    render(<NovaChat navigate={navigate} />)
    const input = screen.getByLabelText('Ask Nova')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.submit(input.closest('form'))
    await waitFor(() => expect(screen.getByText(/couldn't pull that up/i)).toBeTruthy())
  })

  it('links to the full assistant', () => {
    render(<NovaChat navigate={navigate} />)
    fireEvent.click(screen.getByText(/full assistant/i))
    expect(navigate).toHaveBeenCalledWith('/workspace')
  })

  it('renders nothing for a non-office role', () => {
    roleRef.value = 'cleaner'
    render(<NovaChat navigate={navigate} />)
    expect(screen.queryByTestId('home-nova-chat')).toBeNull()
  })
})
