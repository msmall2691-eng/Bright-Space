import { describe, it, expect } from 'vitest'
import { buildRequestFeed } from '../Requests'

// BB-FIND-03: the Requests feed must not hide a returning customer's earlier
// requests. The old collapse keyed by email+phone and kept only the newest,
// so a second distinct request from the same contact vanished.

const mk = (id, over = {}) => ({
  id, name: `Person ${id}`, email: `p${id}@example.com`, phone: `207555${id}`,
  address: `${id} Main St`, created_at: `2026-0${id}-01T00:00:00`, ...over,
})

describe('buildRequestFeed', () => {
  it('keeps BOTH distinct requests from the same contact', () => {
    // Same email+phone, two different submissions weeks apart.
    const older = mk(1, { email: 'same@example.com', phone: '2075550000',
                          created_at: '2026-01-01T00:00:00', message: 'first job' })
    const newer = mk(2, { email: 'same@example.com', phone: '2075550000',
                          created_at: '2026-03-01T00:00:00', message: 'second job' })
    const feed = buildRequestFeed([older, newer])
    const ids = feed.map(r => r.id)
    expect(ids).toContain(1)   // the older one is NOT hidden
    expect(ids).toContain(2)
    expect(feed[0].id).toBe(2) // newest first
  })

  it('flags same-contact look-alikes as possible duplicates (without hiding)', () => {
    const a = mk(1, { name: 'Jane Doe', address: '5 Oak Ave', email: 'a@x.com', phone: '1' })
    const b = mk(2, { name: 'Jane Doe', address: '5 Oak Ave', email: 'b@x.com', phone: '2' })
    const feed = buildRequestFeed([a, b])
    expect(feed).toHaveLength(2)
    expect(feed.every(r => r._possibleDuplicate)).toBe(true)
  })

  it('a lone request is not flagged', () => {
    const feed = buildRequestFeed([mk(9)])
    expect(feed).toHaveLength(1)
    expect(feed[0]._possibleDuplicate).toBe(false)
  })

  it('search filters by name / email / phone / address', () => {
    const feed = buildRequestFeed([mk(1, { name: 'Alice' }), mk(2, { name: 'Bob' })],
                                  { searchTerm: 'alice' })
    expect(feed.map(r => r.id)).toEqual([1])
  })

  it('showDuplicatesOnly narrows to flagged rows but still shows all of them', () => {
    const dupA = mk(1, { name: 'Dup Person', address: '1 Same St', email: 'a@x.com', phone: '1' })
    const dupB = mk(2, { name: 'Dup Person', address: '1 Same St', email: 'b@x.com', phone: '2' })
    const solo = mk(3, { name: 'Solo', address: '9 Alone Rd' })
    const feed = buildRequestFeed([dupA, dupB, solo], { showDuplicatesOnly: true })
    expect(feed.map(r => r.id).sort()).toEqual([1, 2])
  })
})
