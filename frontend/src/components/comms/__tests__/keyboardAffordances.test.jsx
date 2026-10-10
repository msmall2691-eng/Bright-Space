/**
 * The two visible halves of the keyboard work: the `?` sheet, and keeping the
 * selected row on screen.
 *
 * The scroll case is the one with a real bug behind it. Without it, `j` past
 * the fold moves a selection the operator cannot see — the thread pane changes
 * and the list looks untouched, which reads as the keys not working at all.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShortcutsSheet } from '../ShortcutsSheet'
import { ConvItem } from '../ConvItem'

const DIR = dirname(fileURLToPath(import.meta.url))

afterEach(cleanup)

describe('the ? sheet', () => {
  it('renders nothing when closed, so it costs no layout', () => {
    const { container } = render(<ShortcutsSheet open={false} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists the keys the hook actually binds', () => {
    render(<ShortcutsSheet open onClose={() => {}} />)
    for (const key of ['j', 'k', 'e', '/', '?']) {
      expect(screen.getByText(key), `${key} is missing from the sheet`).toBeTruthy()
    }
  })

  it('does not advertise a key the hook refuses to bind', () => {
    // The page already shipped a docstring promising shortcuts that did not
    // exist. A help sheet listing the arrow keys would be the same mistake with
    // a nicer frame, so the two have to agree.
    const hook = readFileSync(join(DIR, '..', '..', '..', 'hooks', 'useInboxShortcuts.js'), 'utf8')
    render(<ShortcutsSheet open onClose={() => {}} />)
    expect(hook).not.toMatch(/case 'ArrowDown'/)
    expect(screen.queryByText('↓')).toBeNull()
    expect(screen.queryByText(/arrow/i)).toBeNull()
  })

  it.each(['Escape', '?'])('closes on %s', (key) => {
    // useInboxShortcuts is disabled while this is up, so closing is the
    // sheet's own job — including `?`, since a sheet opened with a key that
    // cannot be closed with it lies about how it works.
    const onClose = vi.fn()
    render(<ShortcutsSheet open onClose={onClose} />)
    fireEvent.keyDown(document, { key })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a backdrop click but not on a click inside', () => {
    const onClose = vi.fn()
    render(<ShortcutsSheet open onClose={onClose} />)
    fireEvent.click(screen.getByText('Keyboard'))
    expect(onClose, 'clicking the panel itself dismissed it').not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalled()
  })

  it('stops listening once closed', () => {
    const onClose = vi.fn()
    const { rerender } = render(<ShortcutsSheet open onClose={onClose} />)
    rerender(<ShortcutsSheet open={false} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the page holds its shortcut callbacks still', () => {
  // The other half of the no-churn guard. useInboxShortcuts takes these as
  // effect deps, and `reply` is state on this page, so Comms re-renders on
  // every character typed into the composer. Unmemoized, each of these would
  // tear down and re-add a document keydown listener once per keystroke.
  // Read from source: proving it by render would mean mounting the whole
  // three-pane page and its data hook to observe an identity, which is a lot
  // of mocking for an assertion about three keywords.
  const comms = readFileSync(join(DIR, '..', '..', '..', 'pages', 'Comms.jsx'), 'utf8')

  it.each([
    ['selectConversation', /const selectConversation = useCallback\(/],
    ['focusSearch', /const focusSearch = useCallback\(/],
    ['toggleShortcuts', /const toggleShortcuts = useCallback\(/],
    ['closeShortcuts', /const closeShortcuts = useCallback\(/],
  ])('%s is memoized', (_name, re) => {
    expect(comms).toMatch(re)
  })
})

describe('the shortcuts reach state the list-row path does not', () => {
  // Two codex P2s on #1155, both found after it merged, both from reusing
  // list-row machinery for a keyboard acting on the OPEN thread.
  const comms = readFileSync(join(DIR, '..', '..', '..', 'pages', 'Comms.jsx'), 'utf8')

  it('e refreshes the open pane AND keeps the toast and error handling', () => {
    // Two findings in one assertion, because the first fix caused the second.
    //
    // `rowAction` reloads the list and the folder counts but never the detail
    // — right for a swipe on a row you are not reading, wrong from the
    // keyboard: the pane kept offering "Mark done" for up to sixty seconds
    // while the toast said it was done.
    //
    // Fixing that by routing to `setStatus` was worse. `setStatus` has no
    // try/catch and no toast, so the shortcut silently lost its "Marked done"
    // confirmation and any failure became an unhandled rejection with nothing
    // on screen. The reload has to be ADDED to rowAction, not swapped for it.
    const fn = comms.slice(comms.indexOf('const resolveSelected')).slice(0, 1400)
    expect(fn, 'the toast and the try/catch live in rowAction — do not bypass it')
      .toMatch(/await rowAction\(id, 'status', \{ status: 'resolved' \}, 'Marked done'\)/)
    expect(fn, 'no detail reload, so the open pane goes stale again')
      .toMatch(/if \(id === detail\?\.id\) await loadDetail\(id\)/)
    expect(fn, 'setStatus bypasses rowAction and loses the toast + error handling')
      .not.toMatch(/setStatus\(/)
    expect(comms, 'the shortcut is back on the bare list-row path')
      .toMatch(/onResolve: resolveSelected/)
  })

  it('/ reveals the list before focusing it', () => {
    // focus() inside a display:none subtree does nothing, and `/` has already
    // swallowed the keystroke — so the shortcut looked broken on a phone with
    // a thread open, and in the 900–1280 band while the customer column holds
    // the list's slot (which #1152 introduced, so that half is self-inflicted).
    const fn = comms.slice(comms.indexOf('const focusSearch = useCallback')).slice(0, 2000)
    expect(fn, 'no hidden-element check, so the direct path can focus nothing')
      .toMatch(/offsetParent !== null/)
    expect(fn).toMatch(/setMobileView\('list'\)/)
    expect(fn).toMatch(/setShowContactPanel\(false\)/)
    expect(fn, 'focusing in the same tick lands on the element still hidden')
      .toMatch(/requestAnimationFrame\(/)
  })
})

describe('the selected row stays on screen', () => {
  let spy
  beforeEach(() => {
    // jsdom has no layout and no scrollIntoView, so it has to be stubbed —
    // which is also the only way to assert the ARGUMENT, and the argument is
    // the whole point here.
    spy = vi.fn()
    Element.prototype.scrollIntoView = spy
  })

  const row = (props) => render(
    <MemoryRouter>
      <ConvItem conv={{ id: 1, external_contact: '+12075551212', preview: 'hi',
                        last_message_at: '2026-10-01T12:00:00Z' }} {...props} />
    </MemoryRouter>,
  )

  it('scrolls the active row into view', () => {
    row({ active: true })
    expect(spy).toHaveBeenCalled()
  })

  it('uses block nearest, so a visible row is never yanked', () => {
    // `nearest` is a no-op when the row is already fully visible, which is what
    // keeps a mouse click — on a row the user is by definition looking at —
    // from jerking the list.
    row({ active: true })
    expect(spy.mock.calls[0][0]).toMatchObject({ block: 'nearest' })
  })

  it('does not scroll smoothly', () => {
    // This fires on every keystroke of a held-down j; smooth queues them into
    // a slide that lands long after the keys stopped.
    row({ active: true })
    expect(spy.mock.calls[0][0]?.behavior).toBeUndefined()
  })

  it('leaves an inactive row alone', () => {
    row({ active: false })
    expect(spy).not.toHaveBeenCalled()
  })
})
