/**
 * `voice` is a real channel and must look like one.
 *
 * The Twilio voice webhook has been writing `channel="voice"` since
 * BB-VOICE-01, and the inbox offers a "Voicemail" tab that filters for it —
 * but `CHANNEL_CONFIG` had no `voice` entry, and `ConvItem` falls back to
 * `CHANNEL_CONFIG.sms` for an unknown channel. So every voicemail rendered
 * with the SMS phone icon and the SMS dot: a missed call was pixel-identical
 * to a text, on the one tab that exists to separate them.
 *
 * The fallback is deliberate and stays — an unknown channel should render as
 * *something*. That is exactly why the gap was silent, and why this file
 * asserts the channel tabs and the config agree rather than just checking that
 * `voice` happens to be present today.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_CONFIG, PRIORITY_COLORS } from '../constants'
import { ConvItem } from '../ConvItem'
import { ChannelBadge } from '../primitives'

const DIR = dirname(fileURLToPath(import.meta.url))

const base = {
  id: 1,
  external_contact: '+12075551212',
  client: { id: 7, name: 'Sam Rivera' },
  preview: 'Left a voicemail about Friday',
  last_message_at: '2026-09-19T12:00:00Z',
}
const row = (over) => render(
  <MemoryRouter><ConvItem conv={{ ...base, ...over }} /></MemoryRouter>
)

afterEach(cleanup)

describe('every channel the inbox can filter by has a config', () => {
  it('CHANNEL_TABS and CHANNEL_CONFIG do not drift', () => {
    // Read the tab list out of the source rather than importing the component,
    // because the tabs are a module-private const. This is the assertion that
    // would have caught the original bug: the tab existed, the config did not.
    const src = readFileSync(join(DIR, '..', 'InboxLeftPanel.jsx'), 'utf8')
    const block = src.slice(src.indexOf('const CHANNEL_TABS'), src.indexOf(']', src.indexOf('const CHANNEL_TABS')))
    const keys = [...block.matchAll(/key:\s*'([^']*)'/g)].map(m => m[1]).filter(Boolean)

    expect(keys.length, 'no channel tab keys parsed — the regex or the const moved').toBeGreaterThanOrEqual(3)
    for (const k of keys) {
      expect(CHANNEL_CONFIG[k], `the inbox offers a "${k}" tab with no CHANNEL_CONFIG entry`).toBeTruthy()
    }
  })

  it('gives voice its own label and icon, not the SMS ones', () => {
    expect(CHANNEL_CONFIG.voice).toBeTruthy()
    expect(CHANNEL_CONFIG.voice.label).toBe('Voicemail')
    expect(CHANNEL_CONFIG.voice.icon).not.toBe(CHANNEL_CONFIG.sms.icon)
    expect(CHANNEL_CONFIG.voice.dot).not.toBe(CHANNEL_CONFIG.sms.dot)
  })

  it('renders a voice row as a voicemail, and names it', () => {
    // The chip is the only channel signal on a row, and it carried no
    // accessible name — so this asserts both halves of the fix at once.
    row({ channel: 'voice' })
    expect(screen.getByRole('img', { name: 'Voicemail' })).toBeTruthy()
  })

  it('still renders an UNKNOWN channel rather than blowing up', () => {
    // The fallback is load-bearing: a channel added server-side first must not
    // crash the inbox. It should just look like an SMS until it gets a config.
    row({ channel: 'telepathy' })
    expect(screen.getByRole('img', { name: 'SMS' })).toBeTruthy()
  })

  it('ChannelBadge spells the channel out as a dot + word', () => {
    // The other consumer of CHANNEL_CONFIG, and the one that renders `.dot`
    // and `.label` — which is what makes the contrast cases below live.
    render(<MemoryRouter><ChannelBadge channel="voice" /></MemoryRouter>)
    expect(screen.getByText('Voicemail')).toBeTruthy()
  })
})

/* ---- BB-A11Y-02 ------------------------------------------------------- */

const PALETTE = {
  'emerald-500': '#10b981', 'emerald-700': '#047857',
  'blue-500': '#3b82f6', 'blue-600': '#2563eb',
  'violet-500': '#8b5cf6', 'violet-600': '#7c3aed',
  'amber-500': '#f59e0b', 'amber-700': '#b45309',
  'red-500': '#ef4444', 'rose-600': '#e11d48',
  'green-500': '#22c55e', 'green-700': '#15803d',
}
const LIGHT = ['#ffffff', '#f7f7f8', '#f1f1f3', '#e9e9ec']
const chan = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1).slice(i, i + 2), 16))
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const lightStep = (cls) => (cls.match(/(?:^|\s)bg-((?:emerald|blue|violet|amber|red|rose|green)-\d{3})\b/) || [])[1] || null

describe('the inbox dots clear 3:1', () => {
  for (const [name, map] of [['channel', CHANNEL_CONFIG], ['priority', PRIORITY_COLORS]]) {
    it(`every ${name} dot, on all four light grounds`, () => {
      let checked = 0
      for (const [key, cfg] of Object.entries(map)) {
        const step = lightStep(cfg.dot)
        if (!step) continue          // `low` is the neutral ink-3 token
        const hex = PALETTE[step]
        expect(hex, `${step} is not in this test's palette — add it`).toBeTruthy()
        for (const g of LIGHT) {
          const got = ratio(hex, g)
          expect(got, `${name} "${key}" (${step}) on ${g} is ${got.toFixed(2)}:1, under 3:1`)
            .toBeGreaterThanOrEqual(3)
        }
        checked++
      }
      expect(checked).toBeGreaterThanOrEqual(3)
    })
  }
})
