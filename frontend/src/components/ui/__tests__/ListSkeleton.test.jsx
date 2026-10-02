/**
 * ListSkeleton — the calm placeholder office list pages now show instead of a
 * bare "Loading…" line while their first fetch is in flight. It renders the
 * requested number of rows and is aria-hidden so a screen reader isn't handed
 * placeholder content.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ListSkeleton from '../ListSkeleton'

afterEach(cleanup)

describe('ListSkeleton', () => {
  it('renders the requested number of placeholder rows, hidden from AT', () => {
    const { getByTestId } = render(<ListSkeleton rows={4} />)
    const wrap = getByTestId('list-skeleton')
    expect(wrap.getAttribute('aria-hidden')).toBe('true')
    expect(wrap.children.length).toBe(4)
  })

  it('defaults to six rows', () => {
    const { getByTestId } = render(<ListSkeleton />)
    expect(getByTestId('list-skeleton').children.length).toBe(6)
  })
})
