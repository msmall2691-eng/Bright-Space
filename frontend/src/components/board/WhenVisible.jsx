/**
 * Render children only once they're about to be scrolled into view.
 *
 * WHY. The Ops Board's below-the-fold boxes each do their own fetch
 * (MarketplaceBoard → /api/marketplace, BenchDigest → /api/dashboard/bench,
 * StickyNotes → /api/notes, CrewActivity → /api/crew/threads). Mounted
 * eagerly, they all fire on first paint alongside the board payload, the
 * calendar's schedule range, the unread summary and two AI calls — nine
 * requests racing, each popping its own skeleton in at a different moment and
 * shifting the layout under the operator's cursor. That is the "slow and
 * janky" complaint, and none of it is work the page needs before she has
 * scrolled to it.
 *
 * Gating them on visibility keeps the economy rule honest (brightbase-economy:
 * one fetch per screen per need) without deleting a single box: the request
 * still happens, just when its box is actually about to be read. Above-the-
 * fold content is never wrapped in this — the calendar and the action feed
 * must be there on first paint.
 *
 * ONCE VISIBLE, ALWAYS MOUNTED. There is no unmount-on-scroll-away: that would
 * re-fetch on every scroll past, which is worse than eager mounting. This
 * trades a one-time delay for a much lighter first paint.
 *
 * DEGRADES TO EAGER. Without IntersectionObserver — jsdom under vitest, and
 * any browser old enough to lack it — children render immediately. The nine
 * board tests that assert on below-the-fold boxes keep passing unchanged, and
 * a browser that can't defer simply behaves the way the page did before.
 *
 * `minHeight` reserves space so the placeholder doesn't collapse to nothing
 * and make the scrollbar jump as boxes fill in.
 */
import { useEffect, useRef, useState } from 'react'

export default function WhenVisible({ children, minHeight = '8rem', rootMargin = '300px' }) {
  // Eager when the API is missing, so this is a no-op in tests and old browsers.
  const [shown, setShown] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )
  const ref = useRef(null)

  useEffect(() => {
    if (shown) return
    const el = ref.current
    if (!el) return
    // rootMargin starts the fetch a little before the box reaches the viewport,
    // so in normal scrolling the content is already there when it arrives.
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [shown, rootMargin])

  if (shown) return children

  // Not a skeleton: a skeleton here would animate a dozen fake rows the
  // operator never asked for. Just reserved, quiet space.
  return <div ref={ref} style={{ minHeight }} aria-hidden="true" />
}
