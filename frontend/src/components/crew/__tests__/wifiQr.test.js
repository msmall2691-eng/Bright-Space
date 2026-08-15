import { describe, it, expect } from 'vitest'
import { escapeWifiField, wifiQrPayload, qrMatrix, qrSvgPath } from '../wifiQr'

describe('wifiQrPayload', () => {
  it('builds the standard WPA join string', () => {
    expect(wifiQrPayload('BeachHouse24', 'lobster99'))
      .toBe('WIFI:T:WPA;S:BeachHouse24;P:lobster99;;')
  })

  it('uses nopass for open networks and null without an SSID', () => {
    expect(wifiQrPayload('OpenNet', '')).toBe('WIFI:T:nopass;S:OpenNet;;')
    expect(wifiQrPayload('', 'pw')).toBeNull()
  })

  it('escapes the WIFI: special characters', () => {
    expect(escapeWifiField('a;b,c:d"e\\f')).toBe('a\\;b\\,c\\:d\\"e\\\\f')
    expect(wifiQrPayload('Sea; Breeze', 'p:a,ss'))
      .toBe('WIFI:T:WPA;S:Sea\\; Breeze;P:p\\:a\\,ss;;')
  })
})

describe('qrMatrix', () => {
  // Full decode correctness is verified out-of-band against the jsQR decoder
  // (round-trips for versions 1 through 10); these tests pin the structural
  // invariants so a refactor that breaks the geometry fails fast.

  it('emits a valid version-1 matrix for a short string', () => {
    const m = qrMatrix('HELLO')
    expect(m).toHaveLength(21)          // version 1 = 21×21
    m.forEach(row => expect(row).toHaveLength(21))
  })

  it('draws finder, timing, and the always-dark module', () => {
    const m = qrMatrix(wifiQrPayload('BeachHouse24', 'lobster99'))
    const size = m.length
    expect(size % 4).toBe(1)            // sizes are 17 + 4·version
    // Finder pattern at top-left: dark center ring, white at ring distance 2.
    expect(m[3][3]).toBe(true)
    expect(m[3][1]).toBe(false)
    expect(m[0][0]).toBe(true)
    // Timing pattern row 6 alternates between the finders.
    for (let x = 8; x < size - 8; x++) expect(m[6][x]).toBe(x % 2 === 0)
    // The spec's always-dark module at (x=8, y=size-8).
    expect(m[size - 8][8]).toBe(true)
  })

  it('is deterministic and scales up for longer payloads', () => {
    const text = wifiQrPayload('CamdenCottageGuest_5G', 'a-long-wpa2-passphrase-here')
    expect(qrMatrix(text)).toEqual(qrMatrix(text))
    const big = qrMatrix('Z'.repeat(200))
    expect(big.length).toBeGreaterThan(21)
  })

  it('returns null past version-10 capacity instead of throwing', () => {
    expect(qrMatrix('Z'.repeat(213))).not.toBeNull()   // exactly at capacity
    expect(qrMatrix('Z'.repeat(214))).toBeNull()
  })
})

describe('qrSvgPath', () => {
  it('emits one closed square per dark module', () => {
    const m = [[true, false], [false, true]]
    expect(qrSvgPath(m)).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
  })
})
