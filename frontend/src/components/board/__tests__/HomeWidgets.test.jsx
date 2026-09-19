import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import HomeWidgets, { reconcile } from '../HomeWidgets'

const ORDER_KEY = 'brightbase_home_widgets_order'

const items = [
  { key: 'quick', label: 'Quick actions', node: <div data-testid="w-quick">quick</div> },
  { key: 'notes', label: 'Notes', node: <div data-testid="w-notes">notes</div> },
  { key: 'nova', label: 'Ask Nova', node: <div data-testid="w-nova">nova</div> },
]

// Read the rendered widget order off the DOM (the wrappers carry data-widget).
function renderedOrder() {
  return Array.from(document.querySelectorAll('[data-widget]')).map(el => el.getAttribute('data-widget'))
}

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

describe('reconcile', () => {
  it('returns the live keys when nothing is saved', () => {
    expect(reconcile(null, ['a', 'b'])).toEqual(['a', 'b'])
    expect(reconcile([], ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('keeps saved order, drops dead keys, appends new ones at the end', () => {
    expect(reconcile(['b', 'gone', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
  })
})

describe('HomeWidgets', () => {
  it('renders the tiles in default order', () => {
    render(<HomeWidgets items={items} />)
    expect(renderedOrder()).toEqual(['quick', 'notes', 'nova'])
  })

  it('honors a saved order from localStorage', () => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(['nova', 'quick', 'notes']))
    render(<HomeWidgets items={items} />)
    expect(renderedOrder()).toEqual(['nova', 'quick', 'notes'])
  })

  it('moves a tile down with the arrow key and persists', () => {
    render(<HomeWidgets items={items} />)
    // Focus the first tile's grip and press ArrowDown → it swaps past "notes".
    fireEvent.keyDown(screen.getByLabelText(/Reorder Quick actions/i), { key: 'ArrowDown' })
    expect(renderedOrder()).toEqual(['notes', 'quick', 'nova'])
    expect(JSON.parse(localStorage.getItem(ORDER_KEY))).toEqual(['notes', 'quick', 'nova'])
  })

  it('moves a tile up with the arrow key', () => {
    render(<HomeWidgets items={items} />)
    fireEvent.keyDown(screen.getByLabelText(/Reorder Ask Nova/i), { key: 'ArrowUp' })
    expect(renderedOrder()).toEqual(['quick', 'nova', 'notes'])
  })

  it("doesn't move past the ends", () => {
    render(<HomeWidgets items={items} />)
    fireEvent.keyDown(screen.getByLabelText(/Reorder Quick actions/i), { key: 'ArrowUp' })
    expect(renderedOrder()).toEqual(['quick', 'notes', 'nova'])
  })

  it('renders nothing when there are no items', () => {
    render(<HomeWidgets items={[]} />)
    expect(screen.queryByTestId('home-widgets')).toBeNull()
  })
})
