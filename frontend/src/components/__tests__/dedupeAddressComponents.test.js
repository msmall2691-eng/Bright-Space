/**
 * Audit L3 (re-audit): quotes stored before the write-side fix in PR #505
 * landed carry doubled address components like
 * "Keystone Drive, Waterboro, ME, 04061, ME". The customer-facing quote page
 * and the Accept & schedule confirmation must not leak that until the row is
 * rewritten — collapse repeats at display time.
 */
import { describe, it, expect } from 'vitest'

// Mirror of dedupeAddressComponents (kept private to QuoteDocument.jsx so
// the display-only helper stays close to its call site). Any change here
// should be mirrored on both.
const dedupeAddressComponents = (addr) => {
  if (!addr || typeof addr !== 'string') return addr || ''
  const seen = new Set()
  const kept = []
  for (const raw of addr.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(trimmed)
  }
  return kept.join(', ')
}

describe('dedupeAddressComponents', () => {
  it('collapses a trailing repeated state', () => {
    expect(dedupeAddressComponents('Keystone Drive, Waterboro, ME, 04061, ME'))
      .toBe('Keystone Drive, Waterboro, ME, 04061')
  })

  it('collapses a repeated zip too', () => {
    expect(dedupeAddressComponents('42 Pine St, Portland, ME, 04101, 04101'))
      .toBe('42 Pine St, Portland, ME, 04101')
  })

  it('is case-insensitive', () => {
    expect(dedupeAddressComponents('Keystone Drive, Waterboro, ME, 04061, me'))
      .toBe('Keystone Drive, Waterboro, ME, 04061')
  })

  it('leaves a clean address untouched', () => {
    expect(dedupeAddressComponents('155 Keystone Dr, Waterboro, ME, 04061'))
      .toBe('155 Keystone Dr, Waterboro, ME, 04061')
  })

  it('handles null / undefined / non-string safely', () => {
    expect(dedupeAddressComponents(null)).toBe('')
    expect(dedupeAddressComponents(undefined)).toBe('')
    expect(dedupeAddressComponents(42)).toBe(42)
  })

  it('drops empty pieces without producing double commas', () => {
    expect(dedupeAddressComponents('Waterboro, , ME, 04061'))
      .toBe('Waterboro, ME, 04061')
  })
})
