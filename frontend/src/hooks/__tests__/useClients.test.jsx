/**
 * useClients — Clients-page data hook.
 *
 * T-06 regression coverage. Before the fix the hook fetched with the
 * default 50-row cap and filtered client-side over that 50 — so a
 * client at position 51+ was invisible AND unsearchable. These tests
 * pin the new behavior:
 *   - Fetch URL carries limit=1000.
 *   - `statusFilter` and `search` reach the server.
 *   - `search` typing is debounced so we don't burst-fire per keystroke.
 *   - `filtered` is identity — the server did the matching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

vi.mock('../../api', () => ({
  get: vi.fn(),
}))

import { useClients } from '../useClients'
import { get } from '../../api'

const _urls = () => get.mock.calls.map(c => c[0])
const _clientsUrls = () => _urls().filter(u => u.startsWith('/api/clients?'))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  get.mockImplementation((url) => {
    if (url.startsWith('/api/clients/counts')) {
      return Promise.resolve({ '': 3, lead: 1, active: 2, inactive: 0 })
    }
    return Promise.resolve([
      { id: 1, name: 'Ana Client' },
      { id: 2, name: 'Paul Day' },
    ])
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('useClients', () => {
  it('fetches with limit=1000 so all clients are reachable', async () => {
    renderHook(() => useClients('', ''))
    await act(async () => { await vi.runAllTimersAsync() })
    const clientsUrl = _clientsUrls()[0]
    expect(clientsUrl).toMatch(/limit=1000/)
  })

  it('passes statusFilter through to the server', async () => {
    renderHook(() => useClients('lead', ''))
    await act(async () => { await vi.runAllTimersAsync() })
    const clientsUrl = _clientsUrls()[0]
    expect(clientsUrl).toContain('status=lead')
  })

  it('forwards the search string to the server', async () => {
    renderHook(() => useClients('', 'Paul'))
    await act(async () => { await vi.runAllTimersAsync() })
    const clientsUrl = _clientsUrls().pop()
    expect(clientsUrl).toContain('search=Paul')
  })

  it('debounces search-driven refetches (~250ms)', async () => {
    const { rerender } = renderHook(({ q }) => useClients('', q), {
      initialProps: { q: '' },
    })
    // Initial mount fires immediately (empty search).
    await act(async () => { await vi.runAllTimersAsync() })
    const initialCallCount = get.mock.calls.length

    // Type "P", "Pa", "Pau" rapidly.
    rerender({ q: 'P' })
    rerender({ q: 'Pa' })
    rerender({ q: 'Pau' })
    // No new fetch yet — timer hasn't fired.
    expect(get.mock.calls.length).toBe(initialCallCount)

    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    // Exactly one search-driven refetch, not three.
    const trailingClientCalls = _clientsUrls().filter(u => u.includes('search=Pau'))
    expect(trailingClientCalls.length).toBe(1)
  })

  it('narrows visible rows to the current query immediately (during debounce/lag)', async () => {
    // Server returned a mixed set for the initial load; the user then types
    // "Paul". Even before the server responds again with the filtered set,
    // `filtered` must exclude the non-matching row so bulk actions in
    // Clients.jsx can't accidentally hit it (Codex #522).
    get.mockImplementation((url) => {
      if (url.startsWith('/api/clients/counts')) return Promise.resolve({})
      return Promise.resolve([
        { id: 1, name: 'Ana Client' },
        { id: 2, name: 'Paul Day' },
      ])
    })
    const { result, rerender } = renderHook(({ q }) => useClients('', q), {
      initialProps: { q: '' },
    })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(result.current.clients).toHaveLength(2)
    // Type "Paul" — server hasn't refetched yet, but filtered narrows immediately.
    rerender({ q: 'Paul' })
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0].name).toBe('Paul Day')
  })

  it('matches phone and email as well as name (parity with pre-T-06 filter)', async () => {
    get.mockImplementation((url) => {
      if (url.startsWith('/api/clients/counts')) return Promise.resolve({})
      return Promise.resolve([
        { id: 1, name: 'Ana Client', phone: '+12075550123', email: 'ana@x.co' },
        { id: 2, name: 'Bob Sample', phone: '+12075558888', email: 'bob@y.co' },
      ])
    })
    const { result, rerender } = renderHook(({ q }) => useClients('', q), {
      initialProps: { q: '' },
    })
    await act(async () => { await vi.runAllTimersAsync() })
    rerender({ q: '8888' })
    expect(result.current.filtered.map(c => c.name)).toEqual(['Bob Sample'])
    rerender({ q: 'ana@' })
    expect(result.current.filtered.map(c => c.name)).toEqual(['Ana Client'])
  })
})
