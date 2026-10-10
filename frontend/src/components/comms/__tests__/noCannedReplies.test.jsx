/**
 * The generic canned replies are gone and must stay gone.
 *
 * Six static chips — "On our way!", "Running 10 min late", "All done!", "Can we
 * reschedule?", "Thanks for your business!", "Your access code is " — held a
 * permanent row above the textarea on every thread, in all three places
 * ComposeBar is embedded. Asked directly, the owner: "the canned replies i
 * dont use ever lol". An unused control is not free; it spends the vertical
 * space the conversation wanted, on a composer that already stacks four rows.
 *
 * Two deserved removing on their own terms, which is why this guard exists
 * rather than just the deletion:
 *
 *   - "On our way!" and "All done!" are the CREW's words. This composer is the
 *     office side of a customer thread, so they were never right here.
 *   - "Your access code is " invited an operator to type a door code into an
 *     SMS. It is not a BB-SEC-08 breach — the operator types the value and it
 *     is never served from the API — but the app suggesting it is the wrong
 *     default, and that one is checked across all of src/, not just this file:
 *     the concern travels with the string, wherever someone puts it next.
 *
 * What must NOT regress in the other direction: the appointment-aware
 * Remind/Confirm chips. They look similar and are a different feature — they
 * read the customer's real next visit and drop in a complete message with the
 * actual date, time and first name. Those earn their row.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComposeBar } from '../ComposeBar'

const DIR = dirname(fileURLToPath(import.meta.url))
const SRC = join(DIR, '..', '..', '..')

const GONE = [
  'On our way!',
  'Running 10 min late',
  'All done!',
  'Can we reschedule?',
  'Thanks for your business!',
]

const bar = (over = {}) => render(
  <ComposeBar
    detail={{ id: 1, channel: 'sms', subject: null }}
    reply="" setReply={() => {}}
    replySubject="" setReplySubject={() => {}}
    noteMode={false} setNoteMode={() => {}}
    sending={false} flash={null}
    onSend={() => {}}
    {...over}
  />,
)

afterEach(cleanup)

describe('the composer no longer ships generic canned replies', () => {
  it('renders none of the six chips', () => {
    bar()
    for (const text of GONE) {
      expect(screen.queryByRole('button', { name: text }),
        `the canned reply "${text}" is back`).toBeNull()
    }
  })

  it('has dropped the CANNED_REPLIES list itself', () => {
    // Not just the render: an unreferenced const invites someone to wire it
    // back up, and the explanation for why these went lives in its place.
    const src = readFileSync(join(SRC, 'components', 'comms', 'ComposeBar.jsx'), 'utf8')
    expect(src).not.toMatch(/CANNED_REPLIES/)
  })

  it('suggests no access code anywhere in the app', () => {
    // Deliberately tree-wide, and deliberately a literal rather than a
    // pattern: this is the one removal with a security edge, and the concern
    // follows the string wherever it is reintroduced — a crew view, a template
    // picker, an SMS preset in Settings.
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!/\.(jsx?|tsx?)$/.test(name)) continue
        const body = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')      // this file's own explanation
          .replace(/^\s*\/\/.*$/gm, '')
        if (/[Yy]our access code is/.test(body)) hits.push(full.slice(SRC.length + 1))
      }
    }
    walk(SRC)
    expect(hits, 'something offers to type a door code into a message').toEqual([])
  })
})

describe('the appointment-aware chips are not collateral', () => {
  const nextAppt = {
    id: 42,
    title: 'Cleaning',
    scheduled_date: '2026-11-02',
    start_time: '10:00:00',
  }

  it('still offers Remind and Confirm for a real upcoming visit', () => {
    bar({ nextAppt, firstName: 'Sam', companyName: 'The Maine Cleaning Co.',
          onFillReply: () => {} })
    expect(screen.getByRole('button', { name: /remind/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /confirm/i })).toBeTruthy()
  })

  it('shows nothing when there is no upcoming visit', () => {
    // The row has to earn its space per thread, not just in general — that is
    // the whole difference between these and what was cut.
    bar({ onFillReply: () => {} })
    expect(screen.queryByRole('button', { name: /remind/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
  })
})
