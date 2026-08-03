/**
 * splitQuotedEmail — collapses the quoted reply chain / signature off an email
 * body so the inbox shows just the new content. Conservative: it must never
 * hide the whole message, and must leave plain replies untouched.
 */
import { describe, it, expect } from 'vitest'
import { splitQuotedEmail } from '../format'

describe('splitQuotedEmail', () => {
  it('leaves a plain reply with no quoted history untouched', () => {
    const { body, quoted } = splitQuotedEmail('Sounds great, see you Tuesday!')
    expect(body).toBe('Sounds great, see you Tuesday!')
    expect(quoted).toBe('')
  })

  it('splits on a Gmail "On … wrote:" attribution line', () => {
    const raw = [
      'Yes please, 10am works.',
      '',
      'On Tue, Jun 16, 2026 at 9:00 AM Jane <jane@x.com> wrote:',
      '> Are you available Tuesday?',
    ].join('\n')
    const { body, quoted } = splitQuotedEmail(raw)
    expect(body).toBe('Yes please, 10am works.')
    expect(quoted).toContain('On Tue, Jun 16')
    expect(quoted).toContain('> Are you available Tuesday?')
  })

  it('splits on an Outlook "Original Message" divider', () => {
    const raw = 'Confirmed.\n\n-----Original Message-----\nFrom: Us\nHi there'
    const { body, quoted } = splitQuotedEmail(raw)
    expect(body).toBe('Confirmed.')
    expect(quoted).toContain('Original Message')
  })

  it('splits on a block of ">"-quoted lines', () => {
    const raw = 'Looks good.\n> line one\n> line two'
    const { body, quoted } = splitQuotedEmail(raw)
    expect(body).toBe('Looks good.')
    expect(quoted).toContain('> line one')
  })

  it('strips a trailing signature only when it sits near the end', () => {
    const raw = 'Thanks so much for the quick turnaround on this.\n-- \nJane Doe\nAcme Co'
    const { body, quoted } = splitQuotedEmail(raw)
    expect(body).toBe('Thanks so much for the quick turnaround on this.')
    expect(quoted).toContain('Jane Doe')
  })

  it('never blanks the message: a body that is entirely a quote stays visible', () => {
    const raw = 'On Tue, Jun 16, 2026 at 9:00 AM Jane <jane@x.com> wrote:\n> hello'
    const { body, quoted } = splitQuotedEmail(raw)
    expect(body.length).toBeGreaterThan(0)
    expect(quoted).toBe('')
  })

  it('handles empty / nullish input', () => {
    expect(splitQuotedEmail('')).toEqual({ body: '', quoted: '' })
    expect(splitQuotedEmail(null)).toEqual({ body: '', quoted: '' })
  })
})
