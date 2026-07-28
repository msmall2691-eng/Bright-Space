import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const get = vi.fn()
vi.mock('../../../api', () => ({ get: (...a) => get(...a) }))

import GoogleCalendarView from '../GoogleCalendarView'

afterEach(cleanup)
beforeEach(() => get.mockReset())

describe('GoogleCalendarView', () => {
  it('embeds the calendar iframe when configured', async () => {
    get.mockResolvedValue({ configured: true, embed_url: 'https://calendar.google.com/embed?src=x' })
    render(<GoogleCalendarView reloadKey={2} />)
    const frame = await screen.findByTitle('Google Calendar')
    expect(frame.getAttribute('src')).toContain('calendar.google.com')
    expect(frame.getAttribute('src')).toContain('_=2') // cache-busting reload key
  })

  it('shows a setup prompt (not a blank frame) when no embed is configured', async () => {
    get.mockResolvedValue({ configured: false })
    render(<GoogleCalendarView />)
    expect(await screen.findByText(/not embedded yet/i)).toBeTruthy()
    expect(screen.queryByTitle('Google Calendar')).toBeNull()
  })

  it('honors the configured embed URL (no overlay=all override)', async () => {
    get.mockResolvedValue({ configured: true, embed_url: 'https://x' })
    render(<GoogleCalendarView />)
    await screen.findByTitle('Google Calendar')
    expect(get).toHaveBeenCalledWith('/api/settings/gcal-embed')
  })
})
