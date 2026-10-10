/**
 * The suggested reply above the composer must come from the model, or not
 * appear at all.
 *
 * `/api/ai/draft-conversation-reply` answers 200 with canned filler whenever
 * the model can't be reached, and that answer used to carry nothing to mark
 * it. This component's check was `res.message && !res.error`, and the endpoint
 * only ever set `error` for "Conversation not found" — so every failure was
 * rendered as a genuine suggestion, one tap from being sent to a customer.
 *
 * The component's own docstring has always said the opposite ("any error
 * renders nothing — the composer must never look broken because a suggestion
 * failed"). That branch was unreachable. These tests make it reachable and
 * keep it that way.
 *
 * The cache is module-level and keyed `${conversationId}:${lastMessageId}`,
 * so every case here uses a distinct pair — otherwise the second test would
 * read the first one's cached entry and pass for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ post: vi.fn() }))

import { post } from '../../../api'
import { ReplySuggestion } from '../ReplySuggestion'

let id = 0
const nextThread = () => ({ conversationId: ++id, lastMessageId: 100 + id })

const draw = (props) => render(<ReplySuggestion {...props} onUse={() => {}} />)

beforeEach(() => { post.mockReset() })
afterEach(cleanup)

describe('a fallback is not a suggestion', () => {
  it('renders nothing when the assistant is unconfigured', async () => {
    post.mockResolvedValue({
      subject: '',
      message: 'Hi there, thanks for your message! We\'ll take care of this and follow up shortly.',
      fallback: 'unconfigured',
    })
    const { container } = draw(nextThread())

    await waitFor(() => expect(post).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML, 'rendered a fallback as a suggestion').toBe(''))
    expect(screen.queryByRole('button', { name: 'Use' }), 'offered filler as a draft').toBeNull()
  })

  it('renders nothing when the call failed', async () => {
    post.mockResolvedValue({ subject: '', message: 'canned filler', fallback: 'error' })
    const { container } = draw(nextThread())

    await waitFor(() => expect(post).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML, 'rendered a fallback as a suggestion').toBe(''))
  })

  it('still shows a real draft', async () => {
    // The other half, and the one that matters most: suppressing everything
    // would pass both cases above and quietly delete the feature.
    post.mockResolvedValue({
      subject: '',
      message: 'Yes — we can fit a deep clean in on Thursday. Want me to book it?',
    })
    draw(nextThread())

    expect(await screen.findByText(/deep clean in on Thursday/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use' })).toBeTruthy()
  })

  it('hands the real draft to onUse, not a trimmed copy', async () => {
    const onUse = vi.fn()
    const message = 'Thursday at 9 works — shall I put it on the schedule?'
    post.mockResolvedValue({ subject: 'Re: next week', message })
    const thread = nextThread()
    render(<ReplySuggestion {...thread} onUse={onUse} />)

    const use = await screen.findByRole('button', { name: 'Use' })
    use.click()
    expect(onUse).toHaveBeenCalledWith(message, 'Re: next week')
  })
})
