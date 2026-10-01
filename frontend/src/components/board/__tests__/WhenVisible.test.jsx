/**
 * WhenVisible defers the Ops Board's below-the-fold boxes.
 *
 * What is pinned, and why each matters:
 *
 *   * it does NOT render children before they're in view. This is the whole
 *     point — each wrapped box does its own fetch on mount, so a child that
 *     mounts eagerly is a request fired on first paint. If this assertion goes
 *     green-by-accident (e.g. someone makes the fallback unconditional), the
 *     page silently goes back to nine racing requests;
 *   * it renders them once the observer reports an intersection, and KEEPS
 *     them rendered — no unmount on scroll-away, which would re-fetch on every
 *     pass;
 *   * it renders EAGERLY where IntersectionObserver doesn't exist. jsdom has
 *     no IO, so this is what keeps the other nine board test files passing
 *     unchanged, and it's the honest fallback for an old browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

import WhenVisible from '../WhenVisible'

afterEach(() => { cleanup(); delete global.IntersectionObserver })

/** Installs a fake IntersectionObserver and hands back a trigger. */
function stubObserver() {
  let cb = null
  const disconnect = vi.fn()
  global.IntersectionObserver = class {
    constructor(fn) { cb = fn }
    observe() {}
    disconnect() { disconnect() }
  }
  return {
    disconnect,
    enter: () => act(() => cb([{ isIntersecting: true }])),
    scrollPast: () => act(() => cb([{ isIntersecting: false }])),
  }
}

it('does not render children until they come into view', () => {
  const io = stubObserver()
  render(<WhenVisible><p>marketplace</p></WhenVisible>)

  // The box — and therefore its fetch — has not mounted.
  expect(screen.queryByText('marketplace')).toBeNull()

  io.enter()
  expect(screen.getByText('marketplace')).toBeTruthy()
})

it('keeps children mounted after scrolling away, rather than re-fetching', () => {
  const io = stubObserver()
  render(<WhenVisible><p>bench</p></WhenVisible>)

  io.enter()
  expect(screen.getByText('bench')).toBeTruthy()

  // An unmount here would re-run the child's fetch on the next scroll past.
  io.scrollPast()
  expect(screen.getByText('bench')).toBeTruthy()
})

it('stops observing once it has fired', () => {
  const io = stubObserver()
  render(<WhenVisible><p>notes</p></WhenVisible>)
  io.enter()
  expect(io.disconnect).toHaveBeenCalled()
})

it('renders eagerly where IntersectionObserver is unavailable', () => {
  // No stub installed — exactly the jsdom case the other board tests run in.
  expect(typeof IntersectionObserver).toBe('undefined')
  render(<WhenVisible><p>crew</p></WhenVisible>)
  expect(screen.getByText('crew')).toBeTruthy()
})

it('reserves space while deferred so the scrollbar does not jump', () => {
  stubObserver()
  const { container } = render(
    <WhenVisible minHeight="12rem"><p>trends</p></WhenVisible>
  )
  const placeholder = container.firstChild
  expect(placeholder.style.minHeight).toBe('12rem')
  // Nothing for a screen reader to announce — it isn't content yet.
  expect(placeholder.getAttribute('aria-hidden')).toBe('true')
})
