import { useEffect } from 'react'

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** True when this keystroke belongs to whatever the operator is typing in.
 *
 *  Exported because it is the single most important line in this file: a
 *  document-level shortcut handler that forgets this check eats the letter `e`
 *  out of every reply the operator writes, and marks the thread done while
 *  doing it. */
export function isTypingTarget(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  return TYPING_TAGS.has(el.tagName)
}

/**
 * Keyboard navigation for the Messages inbox — j/k to move, e to close, / to
 * search, ? for the list.
 *
 * The page's docstring advertised a "Keyboard shortcuts panel" for a long time
 * and nothing in it ever bound a key beyond Cmd/Ctrl+Enter to send. #1152
 * deleted that claim as false; this makes it true instead, because it is the
 * one thing on the owner's list ("cooler and futuristic") that is pure utility
 * rather than decoration.
 *
 * ## What it deliberately does not bind
 *
 * **Arrow keys.** Linear and Superhuman take both, but they own the whole
 * window. Here the conversation list is one scrollable pane among three, and
 * preventing default on ArrowDown to move the selection would take away the
 * scroll every user already expects from it. j/k is the idiomatic pair and
 * costs nothing that already worked.
 *
 * **Anything with Cmd/Ctrl/Alt.** `Cmd+/` is GlobalSearch and `Cmd+Enter`
 * sends; a handler at document level that ignores modifiers will shadow those
 * and every browser chord besides. Shift is NOT excluded, because `?` IS
 * Shift+/ on most layouts — excluding it would silently disable the help sheet
 * on exactly the keyboards it was written for.
 *
 * ## Selection clamps rather than wraps
 *
 * j at the bottom stays at the bottom. Wrapping from the last conversation
 * back to the first is disorienting in a triage list — you lose your place and
 * the only clue is that the thread changed.
 */
export function useInboxShortcuts({
  enabled = true,
  convs,
  selectedId,
  onSelect,
  onResolve,
  onFocusSearch,
  onToggleHelp,
}) {
  useEffect(() => {
    if (!enabled) return undefined

    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (isTypingTarget(e.target)) {
        // Escape is the way back out of the search box or the composer. It is
        // the one key that has to work WHILE typing, and it must not also run
        // a shortcut.
        if (e.key === 'Escape') e.target.blur()
        return
      }

      switch (e.key) {
        case 'j':
        case 'k': {
          if (!convs?.length) return
          e.preventDefault()
          const at = convs.findIndex(c => c.id === selectedId)
          // Nothing open yet: both keys land on the first row rather than
          // doing nothing, so the first keypress always has an effect.
          const next = at < 0
            ? 0
            : e.key === 'j'
              ? Math.min(at + 1, convs.length - 1)
              : Math.max(at - 1, 0)
          const target = convs[next]
          if (target && target.id !== selectedId) onSelect?.(target.id)
          break
        }
        case 'e':
          // Reversible: the Done folder offers Reopen, and the toast names what
          // happened. Same key Superhuman uses for the same gesture.
          if (selectedId != null) {
            e.preventDefault()
            onResolve?.(selectedId)
          }
          break
        case '/':
          // Without preventDefault the slash also lands in the search box the
          // focus call just moved to.
          e.preventDefault()
          onFocusSearch?.()
          break
        case '?':
          e.preventDefault()
          onToggleHelp?.()
          break
        default:
          break
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, convs, selectedId, onSelect, onResolve, onFocusSearch, onToggleHelp])
}
