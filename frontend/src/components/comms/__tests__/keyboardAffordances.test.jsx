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
