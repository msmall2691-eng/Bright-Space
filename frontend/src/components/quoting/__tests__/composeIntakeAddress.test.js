/**
 * Audit L1 regression: composeIntakeAddress must not double up city / state /
 * zip components that the free-text `address` field already carries.
 *
 * The maineclean.co address autocomplete stores a formatted string like
 * "Keystone Drive, Waterboro, ME, 04061" in intake.address AND persists each
 * piece in its own column; naively joining all four produced
 * "Keystone Drive, Waterboro, ME, 04061, ME" on the customer-facing quote.
 */
import { describe, it, expect } from 'vitest'
import { composeIntakeAddress } from '../constants'

describe('composeIntakeAddress', () => {
  it('does not double the state when the address already carries it', () => {
    expect(composeIntakeAddress({
      address: 'Keystone Drive, Waterboro, ME, 04061',
      city: 'Waterboro',
      state: 'ME',
      zip_code: '04061',
    })).toBe('Keystone Drive, Waterboro, ME, 04061')
  })

  it('appends city / state / zip when the address is bare street', () => {
    expect(composeIntakeAddress({
      address: '155 Keystone Dr',
      city: 'Waterboro',
      state: 'ME',
      zip_code: '04061',
    })).toBe('155 Keystone Dr, Waterboro, ME, 04061')
  })

  it('appends only the pieces the address is missing', () => {
    expect(composeIntakeAddress({
      address: '155 Keystone Dr, Waterboro',
      state: 'ME',
      zip_code: '04061',
    })).toBe('155 Keystone Dr, Waterboro, ME, 04061')
  })

  it('handles a null / missing address without crashing', () => {
    expect(composeIntakeAddress({
      city: 'Portland',
      state: 'ME',
      zip_code: '04101',
    })).toBe('Portland, ME, 04101')
    expect(composeIntakeAddress({})).toBe('')
    expect(composeIntakeAddress(null)).toBe('')
  })

  it('is not fooled by a substring match (ME inside "Rome")', () => {
    // Not a common Maine town but pins the component-only match.
    expect(composeIntakeAddress({
      address: '10 Main St, Rome',
      state: 'ME',
      zip_code: '04963',
    })).toBe('10 Main St, Rome, ME, 04963')
  })

  it('does not strip a city name that appears inside the street line (Codex #3)', () => {
    // The bug: a bare-street address "123 Bath Rd" with city="Bath" used to
    // suppress "Bath" as a duplicate, producing "123 Bath Rd, ME, 04530".
    // Component match keeps them separate — Bath the street token is not the
    // same as Bath the standalone city component.
    expect(composeIntakeAddress({
      address: '123 Bath Rd',
      city: 'Bath',
      state: 'ME',
      zip_code: '04530',
    })).toBe('123 Bath Rd, Bath, ME, 04530')
  })
})
