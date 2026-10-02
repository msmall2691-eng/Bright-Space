/**
 * The two decluttering defaults for the client book, pinned so a refactor
 * can't quietly revert them and regrow the lead pile:
 *   - the Clients list lands on Active (guardrail #5), and
 *   - a client added by hand starts Active, not as a lead (the flip that
 *     stops the pile regrowing). Website/intake leads still come in via
 *     Requests and are promoted on conversion — that path is untouched.
 */
import { describe, it, expect } from 'vitest'
import { EMPTY, DEFAULT_CLIENT_STATUS } from '../constants'

describe('client defaults', () => {
  it('the New Client form starts a client as Active, not a lead', () => {
    expect(EMPTY.status).toBe('active')
  })

  it('the Clients list default status is Active', () => {
    expect(DEFAULT_CLIENT_STATUS).toBe('active')
  })
})
