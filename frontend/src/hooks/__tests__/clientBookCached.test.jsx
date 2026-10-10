/**
 * The client book is one lookup table that four screens each loaded raw.
 *
 * Quoting, Properties, Invoicing and Recurring all fetch
 * `/api/clients?limit=1000` on mount for the same reason: to put a client's
 * NAME next to an id. `api.getCached`'s own doc comment describes this exact
 * case — "read-only endpoints that several callers load on the same
 * navigation" — and it was already the house pattern in six other hooks while
 * the biggest shared payload in the app went without it.
 *
 * `getCached` does two things, and the first matters more than the second:
 *
 *   - **in-flight dedupe.** Concurrent callers share one promise. This carries
 *     no staleness risk at all, because it is the same instant.
 *   - a 5s result memo after that.
 *
 * ## Why the 5s memo is safe here, which is the part worth recording
 *
 * The obvious worry is creating a client and not seeing it. That cannot
 * happen through these four: inline client creation does not rely on a
 * refetch. `usePropertyForm` pushes the new row straight into state
 * (`setClients(cs => [client, ...cs])`, deduped by id), and the other hooks
 * expose `setClients` for the same purpose. The cached fetch is a mount-time
 * lookup, not the mutation path.
 *
 * ## What must NOT be cached, and why it is the interesting assertion
 *
 * `useClients` — the Clients PAGE's own list — also carries `limit=1000`, and
 * folding it in would look like finishing the job. It must stay on plain
 * `get`: it is scoped by the selected tab and the search box (`_buildUrl`
 * appends `status`, `include_archived`, `include_inactive`, `with_stats`), and
 * it is deliberately refetched by `load()` after every mutation. A memo there
 * would serve the previous tab's rows, or hide a client the operator just
 * archived. That is the one this file exists to protect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

/** The four read-only name lookups, and the one that must stay uncached. */
const CACHED = [
  'hooks/useQuotingData.js',
  'hooks/useProperties.js',
  'hooks/useInvoicing.js',
  'pages/Recurring.jsx',
]
const MUST_STAY_RAW = 'hooks/useClients.js'

describe('the client book is fetched through getCached', () => {
  for (const rel of CACHED) {
    it(`${rel} asks the cache for it`, () => {
      const src = read(rel)
      expect(src, `${rel} no longer fetches the client book at all — drop it from CACHED`)
        .toMatch(/\/api\/clients\?limit=1000/)
      // Every client-book call in the file goes through getCached, not get.
      const raw = [...src.matchAll(/(\w+)\(\s*['"`]\/api\/clients\?limit=1000/g)]
      expect(raw.length, `${rel}: no client-book call found`).toBeGreaterThan(0)
      for (const m of raw) {
        expect(m[1], `${rel} calls ${m[1]}() for the client book, not getCached()`)
          .toBe('getCached')
      }
      expect(src).toMatch(/import \{[^}]*\bgetCached\b[^}]*\} from '(\.\.?\/)*api'/)
    })
  }

  it('leaves the Clients page\'s own list on a plain get', () => {
    // Not an oversight — see this file's header. It is tab- and search-scoped
    // and refetched after every mutation, so a 5s memo would serve the
    // previous tab's rows or hide a client the operator just archived.
    const src = read(MUST_STAY_RAW)
    expect(src, 'useClients now caches its list — it must not, it is filtered and mutation-refreshed')
      .not.toMatch(/getCached/)
    expect(src, 'useClients no longer builds a limit=1000 url — this guard has drifted')
      .toMatch(/LOOKUP_LIMIT|limit/)
  })
})

describe('and it really goes through the cache at runtime', () => {
  // The source checks above cannot see a rename or a re-export, so one hook is
  // rendered against a mocked api to prove the call actually lands there.
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
  afterEach(cleanup)

  it('useProperties loads the book via getCached and its own rows via get', async () => {
    vi.doMock('../../api', () => ({
      get: vi.fn().mockResolvedValue([]),
      getCached: vi.fn().mockResolvedValue([]),
      post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
    }))
    const { get, getCached } = await import('../../api')
    const { useProperties } = await import('../useProperties')

    await act(async () => { renderHook(() => useProperties()) })

    expect(getCached.mock.calls.map(c => c[0]))
      .toContain('/api/clients?limit=1000')
    expect(get.mock.calls.map(c => c[0]),
      'the properties list itself should not be memoised — it is this page\'s own data')
      .toContain('/api/properties')
    expect(get.mock.calls.map(c => c[0])).not.toContain('/api/clients?limit=1000')
  })
})
