import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Controlled tab set: two everyday tabs + two rarely-used (secondary) ones.
const TABS = [
  { to: '/a', label: 'Alpha' },
  { to: '/b', label: 'Beta' },
  { to: '/c', label: 'Gamma', secondary: true },
  { to: '/d', label: 'Delta', secondary: true },
]
vi.mock('../../../nav/routes', () => ({ tabsForPath: () => TABS }))

import SubNav from '../SubNav'

afterEach(cleanup)

const at = (path) => render(<MemoryRouter initialEntries={[path]}><SubNav /></MemoryRouter>)

describe('SubNav folding', () => {
  it('shows everyday tabs inline and folds the rare ones under More', () => {
    at('/a')
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('More')).toBeTruthy()
    // Secondary tabs are hidden until More is opened.
    expect(screen.queryByText('Gamma')).toBeNull()
    expect(screen.queryByText('Delta')).toBeNull()
    fireEvent.click(screen.getByText('More'))
    expect(screen.getByText('Gamma')).toBeTruthy()
    expect(screen.getByText('Delta')).toBeTruthy()
  })

  it('surfaces "More" as active when the current route is a folded tab', () => {
    at('/c')
    const more = screen.getByText('More').closest('button')
    // Active tab styling is ink + a solid bottom border.
    expect(more.className).toContain('text-ink')
    expect(more.className).toContain('border-ink')
  })
})
