import { describe, it, expect } from 'vitest'
import { htmlToText, formatDate, formatDateTime, combineAddress } from '../format'

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

describe('combineAddress (audit July-2026 L1/L3)', () => {
  it('does not re-append state or zip already in the base', () => {
    // The maineclean.co /book flow posts the whole "street, city, ME, zip"
    // string into LeadIntake.address, with city/zip separate columns NULL and
    // state defaulting to "ME". Before this helper the quote seeder wrote
    // "Keystone Drive, Waterboro, ME, 04061, ME" — the doubled ME shipped
    // to the customer-facing quote page.
    expect(combineAddress(
      'Keystone Drive, Waterboro, ME, 04061', null, 'ME', null,
    )).toBe('Keystone Drive, Waterboro, ME, 04061')
  })

  it('appends components that are genuinely missing from base', () => {
    expect(combineAddress('155 Main St', 'Portland', 'ME', '04101'))
      .toBe('155 Main St, Portland, ME, 04101')
  })

  it('is case-insensitive on the dedupe check', () => {
    expect(combineAddress('123 Elm St, Portland, me', null, 'ME', null))
      .toBe('123 Elm St, Portland, me')
  })

  it('handles the missing-house-number case gracefully', () => {
    expect(combineAddress('Keystone Drive', 'Waterboro', 'ME', '04061'))
      .toBe('Keystone Drive, Waterboro, ME, 04061')
  })

  it('drops empty and whitespace-only components', () => {
    expect(combineAddress('1 Main St', '', 'ME', '  '))
      .toBe('1 Main St, ME')
  })

  it('returns empty string when everything is empty', () => {
    expect(combineAddress(null, null, null, null)).toBe('')
    expect(combineAddress('', '', '', '')).toBe('')
  })

  it('does not append a duplicate second-time (e.g. same state twice)', () => {
    expect(combineAddress('123 Oak', 'Portland', 'ME', 'ME'))
      .toBe('123 Oak, Portland, ME')
  })

  it('keeps the city when the street name contains the city as a word (codex P2 on PR #527)', () => {
    // Whitespace tokenization used to drop "Portland" because "12 Portland St"
    // was tokenized to ["12","portland","st"]. Address components are
    // comma-delimited, not word-delimited.
    expect(combineAddress('12 Portland St', 'Portland', 'ME', '04101'))
      .toBe('12 Portland St, Portland, ME, 04101')
  })

  it('still skips the city when it IS its own comma-delimited component', () => {
    expect(combineAddress('12 Elm St, Portland', 'Portland', 'ME', '04101'))
      .toBe('12 Elm St, Portland, ME, 04101')
  })
})
