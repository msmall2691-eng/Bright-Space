import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConvItem } from '../ConvItem'

const base = {
  id: 1,
  channel: 'sms',
  external_contact: '+12075551212',
  client: { id: 7, name: 'Sam Rivera' },
  preview: 'hello there',
  last_message_at: '2026-09-19T12:00:00Z',
}

const row = (over) => render(
  <MemoryRouter><ConvItem conv={{ ...base, ...over }} /></MemoryRouter>
)

afterEach(cleanup)

describe('ConvItem status signal', () => {
  it('marks a thread that needs a reply (customer spoke last, not resolved)', () => {
    row({ last_inbound_at: '2026-09-19T12:00:00Z', last_outbound_at: '2026-09-19T09:00:00Z' })
    expect(screen.getByText('Needs reply')).toBeTruthy()
  })

  it('stays quiet when we replied last', () => {
    row({ last_inbound_at: '2026-09-19T09:00:00Z', last_outbound_at: '2026-09-19T12:00:00Z' })
    expect(screen.queryByText('Needs reply')).toBeNull()
    expect(screen.queryByText('Overdue')).toBeNull()
  })

  it('does not mark a resolved thread even if the customer spoke last', () => {
    row({ status: 'resolved', last_inbound_at: '2026-09-19T12:00:00Z', last_outbound_at: '2026-09-19T09:00:00Z' })
    expect(screen.queryByText('Needs reply')).toBeNull()
  })

  it('Overdue wins over Needs reply', () => {
    row({ sla_state: 'breached', last_inbound_at: '2026-09-19T12:00:00Z', last_outbound_at: '2026-09-19T09:00:00Z' })
    expect(screen.getByText('Overdue')).toBeTruthy()
    expect(screen.queryByText('Needs reply')).toBeNull()
  })

  it('falls back to Unassigned when handled but nobody owns it', () => {
    row({ last_inbound_at: '2026-09-19T09:00:00Z', last_outbound_at: '2026-09-19T12:00:00Z', assignee: null })
    expect(screen.getByText('Unassigned')).toBeTruthy()
  })
})
