/**
 * The inbox keyboard shortcuts, and — more importantly — what they refuse to do.
 *
 * A document-level keydown handler is a loaded gun pointed at every input on
 * the page. The cases that matter most here are the negative ones: if this
 * handler fires while the operator is composing a reply, the letter `e`
 * disappears from their message AND the thread gets marked done. Those are the
 * cases written first and mutation-checked hardest.
 *
 * The page's docstring advertised a "Keyboard shortcuts panel" for a long time
 * while nothing bound a key beyond Cmd/Ctrl+Enter. #1152 deleted the claim as
 * false; this suite is the other half of making it true.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useInboxShortcuts, isTypingTarget } from '../useInboxShortcuts'

const CONVS = [{ id: 1 }, { id: 2 }, { id: 3 }]

/** Mount the hook with spies, returning them plus a `press` helper. */
const setup = (over = {}) => {
  const spies = {
    onSelect: vi.fn(),
    onResolve: vi.fn(),
    onFocusSearch: vi.fn(),
    onToggleHelp: vi.fn(),
  }
  const props = { convs: CONVS, selectedId: 2, ...spies, ...over }
  const view = renderHook(p => useInboxShortcuts(p), { initialProps: props })
  /** Dispatch a real KeyboardEvent, optionally from a given element. */
  const press = (key, { target, ...init } = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    ;(target || document.body).dispatchEvent(ev)
    return ev
  }
  return { ...spies, press, view }
}

afterEach(cleanup)

describe('moving through the list', () => {
  it('j goes to the next conversation, k to the previous', () => {
    const a = setup({ selectedId: 2 })
    a.press('j')
    expect(a.onSelect).toHaveBeenCalledWith(3)
    cleanup()

    const b = setup({ selectedId: 2 })
    b.press('k')
    expect(b.onSelect).toHaveBeenCalledWith(1)
  })

  it('clamps at both ends instead of wrapping', () => {
    // Wrapping from the last conversation back to the first loses your place
    // in a triage list, and the only clue is that the thread changed.
    const last = setup({ selectedId: 3 })
    last.press('j')
    expect(last.onSelect).not.toHaveBeenCalled()
    cleanup()

    const first = setup({ selectedId: 1 })
    first.press('k')
    expect(first.onSelect).not.toHaveBeenCalled()
  })

  it('starts at the top when nothing is open yet', () => {
    // Both keys, so the very first keypress always does something visible.
    for (const key of ['j', 'k']) {
      cleanup()
      const s = setup({ selectedId: null })
      s.press(key)
      expect(s.onSelect, `${key} with no selection`).toHaveBeenCalledWith(1)
    }
  })

  it('does nothing on an empty list', () => {
    const s = setup({ convs: [], selectedId: null })
    s.press('j')
    expect(s.onSelect).not.toHaveBeenCalled()
  })
})

describe('the other keys', () => {
  it('e closes the open thread', () => {
    const s = setup({ selectedId: 2 })
    s.press('e')
    expect(s.onResolve).toHaveBeenCalledWith(2)
  })

  it('e does nothing with no thread open', () => {
    const s = setup({ selectedId: null })
    s.press('e')
    expect(s.onResolve).not.toHaveBeenCalled()
  })

  it('/ focuses search and swallows the slash', () => {
    // Without preventDefault the slash lands in the box the focus call just
    // moved to, so the operator starts every search with a stray "/".
    const s = setup()
    const ev = s.press('/')
    expect(s.onFocusSearch).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('? toggles the help sheet', () => {
    const s = setup()
    s.press('?', { shiftKey: true })
    expect(s.onToggleHelp).toHaveBeenCalled()
  })
})

describe('what it refuses to touch', () => {
  it.each(['input', 'textarea', 'select'])('ignores every key typed in a <%s>', (tag) => {
    const el = document.createElement(tag)
    document.body.appendChild(el)
    const s = setup()
    try {
      for (const key of ['j', 'k', 'e', '/', '?']) s.press(key, { target: el })
      expect(s.onSelect).not.toHaveBeenCalled()
      expect(s.onResolve, 'marked a thread done while the operator was typing')
        .not.toHaveBeenCalled()
      expect(s.onFocusSearch).not.toHaveBeenCalled()
      expect(s.onToggleHelp).not.toHaveBeenCalled()
    } finally {
      el.remove()
    }
  })

  it('ignores keys typed in a contenteditable', () => {
    const el = document.createElement('div')
    // jsdom does not derive isContentEditable from the attribute, so set the
    // property the guard actually reads. The attribute alone would make this
    // test pass against a guard that checks neither.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    document.body.appendChild(el)
    const s = setup()
    try {
      s.press('e', { target: el })
      expect(s.onResolve).not.toHaveBeenCalled()
    } finally {
      el.remove()
    }
  })

  it('blurs on Escape while typing, and runs nothing', () => {
    const el = document.createElement('input')
    document.body.appendChild(el)
    el.focus()
    const blur = vi.spyOn(el, 'blur')
    const s = setup()
    try {
      s.press('Escape', { target: el })
      expect(blur).toHaveBeenCalled()
      expect(s.onResolve).not.toHaveBeenCalled()
      expect(s.onSelect).not.toHaveBeenCalled()
    } finally {
      el.remove()
    }
  })

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['altKey', { altKey: true }],
  ])('leaves %s chords to the browser', (_name, mods) => {
    // Cmd+/ is GlobalSearch and Cmd+Enter sends. A handler that ignores
    // modifiers shadows those and every browser chord besides.
    const s = setup()
    for (const key of ['j', 'e', '/']) s.press(key, mods)
    expect(s.onSelect).not.toHaveBeenCalled()
    expect(s.onResolve).not.toHaveBeenCalled()
    expect(s.onFocusSearch).not.toHaveBeenCalled()
  })

  it('does not bind the arrow keys', () => {
    // Deliberate: the conversation list is one scrollable pane of three, and
    // preventing default on ArrowDown would take away the scroll every user
    // expects from it. Pinned so "j/k should really have arrows too" is a
    // decision rather than a drive-by addition.
    const s = setup()
    s.press('ArrowDown')
    s.press('ArrowUp')
    expect(s.onSelect).not.toHaveBeenCalled()
  })
})

describe('the enabled gate', () => {
  it('binds nothing when disabled', () => {
    const s = setup({ enabled: false })
    for (const key of ['j', 'e', '/', '?']) s.press(key)
    expect(s.onSelect).not.toHaveBeenCalled()
    expect(s.onResolve).not.toHaveBeenCalled()
    expect(s.onFocusSearch).not.toHaveBeenCalled()
    expect(s.onToggleHelp).not.toHaveBeenCalled()
  })

  it('does not rebind while its inputs hold still', () => {
    // Half of the guard against a listener churned once per keystroke. `reply`
    // is state on the Comms page, so the page re-renders on every character
    // typed into the composer; this half proves the hook adds nothing when its
    // props are unchanged, and the page's own useCallbacks — pinned in
    // components/comms/__tests__/keyboardAffordances — are what keep them
    // unchanged across those renders. Neither half is sufficient alone.
    const add = vi.spyOn(document, 'addEventListener')
    try {
      const props = {
        convs: CONVS, selectedId: 1,
        onSelect: () => {}, onResolve: () => {},
        onFocusSearch: () => {}, onToggleHelp: () => {},
      }
      const { rerender } = renderHook(p => useInboxShortcuts(p), { initialProps: props })
      const bound = () => add.mock.calls.filter(c => c[0] === 'keydown').length
      const afterMount = bound()
      rerender(props)
      rerender(props)
      expect(bound(), 'the effect re-ran on an unchanged render').toBe(afterMount)
    } finally {
      add.mockRestore()
    }
  })

  it('stops listening once unmounted', () => {
    // Checked against the listener, not against a dead component: React drops
    // setState on an unmounted component silently, so a test that only watched
    // for a re-render would pass with the cleanup deleted.
    const s = setup()
    s.view.unmount()
    s.press('j')
    expect(s.onSelect).not.toHaveBeenCalled()
  })
})

describe('isTypingTarget', () => {
  it('is safe on a null target', () => {
    // A synthetic event with no target must not throw inside the handler.
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })

  it('does not treat an ordinary element as typing', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
  })
})
