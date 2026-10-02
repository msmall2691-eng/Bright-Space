import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }
vi.mock('../../../api', () => ({
  get: (...a) => api.get(...a),
  post: (...a) => api.post(...a),
  patch: (...a) => api.patch(...a),
  del: (...a) => api.del(...a),
}))

import StickyNotes from '../StickyNotes'

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.del.mockReset()
  api.patch.mockResolvedValue({}); api.del.mockResolvedValue({})
})
afterEach(cleanup)

describe('StickyNotes', () => {
  it('loads the account notes and shows their text', async () => {
    api.get.mockResolvedValue([{ id: 1, body: 'Order microfiber', color: 'blue', sort_order: 0 }])
    render(<StickyNotes />)
    expect(api.get).toHaveBeenCalledWith('/api/notes')
    await waitFor(() => expect(screen.getByDisplayValue('Order microfiber')).toBeTruthy())
  })

  it('adds a note via the API and shows it', async () => {
    api.get.mockResolvedValue([])
    api.post.mockResolvedValue({ id: 5, body: '', color: 'amber', sort_order: 0 })
    render(<StickyNotes />)
    await waitFor(() => expect(screen.getByText(/no notes yet/i)).toBeTruthy())
    fireEvent.click(screen.getAllByText(/^Add$|New note/i)[0])
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notes', expect.objectContaining({ body: '' })))
  })

  it('saves an edited body on blur', async () => {
    api.get.mockResolvedValue([{ id: 2, body: 'old', color: 'amber', sort_order: 0 }])
    render(<StickyNotes />)
    const ta = await screen.findByDisplayValue('old')
    fireEvent.change(ta, { target: { value: 'new text' } })
    fireEvent.blur(ta)
    expect(api.patch).toHaveBeenCalledWith('/api/notes/2', { body: 'new text' })
  })

  it('recolors a note through the API', async () => {
    api.get.mockResolvedValue([{ id: 3, body: 'x', color: 'amber', sort_order: 0 }])
    render(<StickyNotes />)
    await screen.findByDisplayValue('x')
    fireEvent.click(screen.getByLabelText('Color green'))
    expect(api.patch).toHaveBeenCalledWith('/api/notes/3', { color: 'green' })
  })

  it('deletes a note and removes it locally', async () => {
    api.get.mockResolvedValue([{ id: 4, body: 'toss', color: 'amber', sort_order: 0 }])
    render(<StickyNotes />)
    await screen.findByDisplayValue('toss')
    fireEvent.click(screen.getByLabelText('Delete note'))
    expect(api.del).toHaveBeenCalledWith('/api/notes/4')
    await waitFor(() => expect(screen.queryByDisplayValue('toss')).toBeNull())
  })

  it('shows a retry affordance when loading fails', async () => {
    api.get.mockRejectedValue(new Error('nope'))
    render(<StickyNotes />)
    await waitFor(() => expect(screen.getByText(/couldn't load your notes/i)).toBeTruthy())
    api.get.mockResolvedValue([])
    fireEvent.click(screen.getByText(/retry/i))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })
})
