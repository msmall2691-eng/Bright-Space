/**
 * A change of sender starts a new bubble group, so every sender is named.
 *
 * `MessageBubble` renders `m.author` only on the first message of a group, and
 * `Comms.jsx` started a group only when the direction, the note flag or the
 * DAY changed. So two consecutive outbound messages sent by different
 * teammates showed one name and the second sender was unidentifiable.
 *
 * That matters because of what it undermined. #1156 deleted the customer
 * panel's activity feed, which labelled the author of EVERY message, and
 * justified the deletion with six cases asserting the thread pane is a strict
 * superset of the feed. One of those cases was about the author — and it
 * rendered a single message, so the only boundary that could lose an author
 * was never exercised. The guard that licensed the deletion had a hole in
 * exactly the shape of the thing it was guarding. Codex found it after the PR
 * merged.
 *
 * This is the case that was missing, written against the grouping logic rather
 * than against one bubble.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))

/** The real `isFirst` rule, lifted out of Comms.jsx so the grouping can be
 *  exercised without mounting the whole three-pane page and its data hook.
 *  Kept honest by `matches the rule in Comms.jsx` below. */
const isFirst = (m, prev) => !prev
  || prev.direction !== m.direction
  || prev.is_internal_note !== m.is_internal_note
  || (prev.author || '') !== (m.author || '')
  || new Date(m.created_at).toDateString() !== new Date(prev.created_at).toDateString()

const at = (h) => `2026-10-01T${String(h).padStart(2, '0')}:00:00Z`

describe('a new sender starts a new group', () => {
  it('breaks the group when two outbound messages have different authors', () => {
    const a = { id: 1, direction: 'outbound', author: 'Meg', created_at: at(9) }
    const b = { id: 2, direction: 'outbound', author: 'Dana', created_at: at(10) }
    expect(isFirst(b, a), 'Dana rides in Meg\'s group and is never named')
      .toBe(true)
  })

  it('keeps one group when the same person writes twice', () => {
    // The whole point of grouping: a run from one sender gets one label.
    const a = { id: 1, direction: 'outbound', author: 'Meg', created_at: at(9) }
    const b = { id: 2, direction: 'outbound', author: 'Meg', created_at: at(10) }
    expect(isFirst(b, a)).toBe(false)
  })

  it('treats a missing author as one value, not as a change', () => {
    // Inbound messages carry no author; MessageBubble falls back to the
    // contact name. Comparing undefined to null must not split every pair.
    const a = { id: 1, direction: 'inbound', created_at: at(9) }
    const b = { id: 2, direction: 'inbound', author: null, created_at: at(10) }
    expect(isFirst(b, a)).toBe(false)
  })

  it('still breaks on direction, note status and day', () => {
    const base = { id: 1, direction: 'outbound', author: 'Meg', created_at: at(9) }
    expect(isFirst({ ...base, id: 2, direction: 'inbound' }, base)).toBe(true)
    expect(isFirst({ ...base, id: 3, is_internal_note: true }, base)).toBe(true)
    expect(isFirst({ ...base, id: 4, created_at: '2026-10-02T09:00:00Z' }, base)).toBe(true)
  })

  it('matches the rule in Comms.jsx', () => {
    // The copy above is only worth anything while it agrees with the page.
    const src = readFileSync(join(DIR, '..', '..', '..', 'pages', 'Comms.jsx'), 'utf8')
    const rule = src.slice(src.indexOf('const isFirst = !prev')).slice(0, 400)
    expect(rule, 'the author comparison is gone from the grouping boundary')
      .toMatch(/\(prev\.author \|\| ''\) !== \(m\.author \|\| ''\)/)
    expect(rule).toMatch(/prev\.direction !== m\.direction/)
    expect(rule).toMatch(/prev\.is_internal_note !== m\.is_internal_note/)
  })
})
