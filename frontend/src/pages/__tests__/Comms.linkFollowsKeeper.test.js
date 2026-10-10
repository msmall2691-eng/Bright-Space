/**
 * After linking a thread to a client, the inbox follows the KEEPER's id.
 *
 * The server folds the linked thread into the client's existing one and
 * deletes the emptied shell, so the id you posted about may no longer exist
 * (backend side: tests/test_link_client_folds_threads.py). Reloading the old
 * id lands the operator on a dead conversation immediately after a successful
 * link, and the list keeps the deleted row highlighted.
 *
 * ## Why this reads the source instead of rendering the page
 *
 * Reproducing it needs the whole Comms page — its data hook, the list, the
 * detail pane and the contact panel — plus a fold on the server to make the
 * ids diverge. That test would be long, slow and mostly about mocks, and a
 * fragile behaviour test is worse than an honest source pin: it rots, someone
 * deletes it, and the protection goes with it.
 *
 * What is actually at risk is narrow and textual: a later refactor going back
 * to `loadDetail(detail.id)` because that reads more naturally. So that is
 * what this pins. Mutation-checked both ways.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Comms.jsx')
const src = readFileSync(COMMS, 'utf8')

/** The body of the linkClient callback. */
const linkClient = (() => {
  const start = src.indexOf('const linkClient = useCallback')
  expect(start, 'linkClient is gone from Comms.jsx — update this test').toBeGreaterThan(-1)
  const end = src.indexOf('const resolveConv', start)
  return src.slice(start, end > start ? end : start + 2000)
})()

describe('linking a thread follows the keeper the server returns', () => {
  it('keeps the response instead of discarding it', () => {
    expect(linkClient, 'the link POST is fire-and-forget again — the keeper id is in its response')
      .toMatch(/(const|let)\s+\w+\s*=\s*await\s+post\([^)]*link-client/s)
  })

  it('reloads the keeper, not the id it posted about', () => {
    expect(linkClient, 'loadDetail went back to the posted id, which the fold may have deleted')
      .not.toMatch(/loadDetail\(detail\.id\)/)
    expect(linkClient).toMatch(/loadDetail\(keeperId\)/)
  })

  it('moves the list selection when the id changed', () => {
    // Without this the detail pane shows the surviving thread while the list
    // still highlights the row that no longer exists.
    expect(linkClient, 'the list selection no longer follows the fold')
      .toMatch(/setSelectedId\(keeperId\)/)
  })

  it('falls back to the posted id when the response has none', () => {
    // A 204, an older server, or a stubbed client must not produce
    // loadDetail(undefined).
    expect(linkClient).toMatch(/keeperId\s*=\s*\w+\?\.id\s*\?\?\s*detail\.id/)
  })
})
