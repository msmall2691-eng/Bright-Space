import { describe, it, expect } from 'vitest'
import { htmlToText, formatDate, formatDateTime } from '../format'

describe('htmlToText', () => {
  it('strips a full HTML email document to readable text', () => {
    const html = '<!DOCTYPE html><html><head><style>p{color:red}</style></head>' +
      '<body><p>Hi there</p><p>Need a quote please</p></body></html>'
    const out = htmlToText(html)
    expect(out).toContain('Hi there')
    expect(out).toContain('Need a quote please')
    expect(out).not.toMatch(/</)          // no markup left
    expect(out).not.toContain('color:red') // style content dropped
  })

  it('leaves plain text untouched', () => {
    expect(htmlToText('Just a normal message')).toBe('Just a normal message')
  })

  it('handles null/empty', () => {
    expect(htmlToText(null)).toBe('')
    expect(htmlToText('')).toBe('')
  })
})

describe('formatDate / formatDateTime', () => {
  it('formats an ISO timestamp instead of showing it raw', () => {
    const out = formatDateTime('2026-06-15T08:07:53.933Z')
    expect(out).not.toContain('T08:07')
    expect(out).not.toContain('Z')
  })

  it('returns the original value when not a date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })

  it('returns empty string for falsy input', () => {
    expect(formatDate('')).toBe('')
    expect(formatDateTime(null)).toBe('')
  })
})
