/** Column sort on the Clients table: each visible column header is a button
 *  that calls onSort with the column id, and the active column shows a
 *  direction chevron. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ClientTableView } from '../ClientTableView'

afterEach(cleanup)

const columns = [
  { id: 'name', label: 'Name', render: (c) => <span>{c.name}</span> },
  { id: 'balance', label: 'Balance', render: (c) => <span>{c.balance}</span> },
]

const base = {
  filtered: [{ id: 1, name: 'Ada', balance: 120 }],
  visibleColumns: columns,
  selectedIds: new Set(),
  toggleSelect: vi.fn(),
  toggleSelectAll: vi.fn(),
  updateStatus: vi.fn(),
  setJobClient: vi.fn(),
  navigate: vi.fn(),
  onRowOpen: vi.fn(),
  peekId: null,
  openNew: vi.fn(),
  openEdit: vi.fn(),
  deleteClient: vi.fn(),
}

describe('Clients table column sort', () => {
  it('clicking a column header requests a sort on that column', () => {
    const onSort = vi.fn()
    render(<ClientTableView {...base} sort={{ key: null, dir: 'asc' }} onSort={onSort} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Balance' }))
    expect(onSort).toHaveBeenCalledWith('balance')
  })

  it('shows a direction indicator on the active column only', () => {
    const { container } = render(
      <ClientTableView {...base} sort={{ key: 'balance', dir: 'desc' }} onSort={vi.fn()} />)
    // The active header (Balance) carries a chevron svg; the inactive one doesn't.
    const headers = Array.from(container.querySelectorAll('thead th'))
    const nameTh = headers.find(th => th.textContent.includes('Name'))
    const balTh = headers.find(th => th.textContent.includes('Balance'))
    expect(balTh.querySelector('svg')).toBeTruthy()
    expect(nameTh.querySelector('svg')).toBeNull()
  })

  it('renders plain labels (no sort buttons) when onSort is not provided', () => {
    render(<ClientTableView {...base} sort={undefined} onSort={undefined} />)
    expect(screen.queryByRole('button', { name: 'Sort by Balance' })).toBeNull()
    expect(screen.getByText('Balance')).toBeTruthy()
  })
})
