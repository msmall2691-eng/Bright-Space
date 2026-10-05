/**
 * useUrlFilters — filters that live in the URL.
 *
 * The contract that matters: a default is OMITTED from the URL (so `/requests`
 * means "no filters", not "four filters set to all"), unrelated params are
 * preserved (`?new=1` still opens the create modal), and a filter change
 * replaces rather than pushes so it doesn't fill the back button.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useUrlFilters } from '../useUrlFilters'

const DEFAULTS = { status: 'all', source: 'all', priority: 'all' }

function wrapperAt(initial) {
  return ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  )
}

/** The hook plus the live location, so writes can be asserted. */
function useProbe(defaults = DEFAULTS) {
  const [values, setFilter, extra] = useUrlFilters(defaults)
  const { search } = useLocation()
  return { values, setFilter, extra, search }
}

describe('useUrlFilters', () => {
  it('falls back to the defaults when the URL is bare', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests') })
    expect(result.current.values).toEqual({ status: 'all', source: 'all', priority: 'all' })
    expect(result.current.extra.active).toBe(false)
  })

  it('reads what the URL carries, and leaves the rest at default', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapperAt('/requests?source=website&status=new'),
    })
    expect(result.current.values.source).toBe('website')
    expect(result.current.values.status).toBe('new')
    expect(result.current.values.priority).toBe('all')
    expect(result.current.extra.active).toBe(true)
  })

  it('treats an empty param as absent', () => {
    // `?status=` is a URL built by a loop or hand-edited, not a filter choice.
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests?status=') })
    expect(result.current.values.status).toBe('all')
    expect(result.current.extra.active).toBe(false)
  })

  it('writes a non-default filter to the URL', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests') })
    act(() => result.current.setFilter('source', 'website'))
    expect(result.current.search).toContain('source=website')
    expect(result.current.values.source).toBe('website')
  })

  it('OMITS a filter set back to its default, rather than writing all', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapperAt('/requests?source=website'),
    })
    act(() => result.current.setFilter('source', 'all'))
    expect(result.current.search).not.toContain('source')
    expect(result.current.values.source).toBe('all')
  })

  it('preserves params it does not own', () => {
    // The regression this guards: Requests consumes `?new=1` to open the create
    // modal. A filter write that rebuilt the query from scratch would eat it.
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests?new=1') })
    act(() => result.current.setFilter('status', 'new'))
    expect(result.current.search).toContain('new=1')
    expect(result.current.search).toContain('status=new')
  })

  it('clears only the filters it owns', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapperAt('/requests?new=1&source=website&status=new&tab=conversation'),
    })
    act(() => result.current.extra.clearFilters())
    expect(result.current.search).not.toContain('source')
    expect(result.current.search).not.toContain('status')
    expect(result.current.search).toContain('new=1')
    expect(result.current.search).toContain('tab=conversation')
  })

  it('does not stack history entries', () => {
    // replace:true — three filter tweaks should not mean three taps of Back to
    // leave the page.
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests') })
    const before = window.history.length
    act(() => result.current.setFilter('source', 'website'))
    act(() => result.current.setFilter('status', 'new'))
    act(() => result.current.setFilter('priority', 'high'))
    expect(window.history.length).toBe(before)
  })

  it('round-trips a value through the URL unchanged', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapperAt('/requests') })
    act(() => result.current.setFilter('source', 'google_business'))
    expect(result.current.values.source).toBe('google_business')
  })
})
