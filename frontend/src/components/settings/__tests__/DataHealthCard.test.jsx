/**
 * DataHealthCard — the read-only data-quality scan in Settings. Pins that each
 * finding's sample records render as links straight to the offending record, so
 * the scan is actionable (not just a count).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../api', () => ({ get: vi.fn() }))
import { get } from '../../../api'
import DataHealthCard from '../DataHealthCard'

beforeEach(() => {
  vi.clearAllMocks()
  try { localStorage.setItem('brightbase_user', JSON.stringify({ role: 'admin' })) } catch { /* ignore */ }
})
afterEach(() => { cleanup(); try { localStorage.clear() } catch { /* ignore */ } })

const draw = () => render(<MemoryRouter><DataHealthCard /></MemoryRouter>)

it('links each finding to the offending record', async () => {
  get.mockResolvedValue({
    healthy: false,
    summary: { error: 1, warn: 1 },
    findings: [
      { code: 'job_no_property', severity: 'error', table: 'jobs', message: '1 jobs have no property',
        count: 1, sample_ids: [42], truncated: false, suggestion: 'Set the missing link', destructive: false },
      { code: 'duplicate_client_phone', severity: 'warn', table: 'clients', message: 'shared phone',
        count: 2, sample_ids: [5, 9], truncated: false, suggestion: 'Merge the duplicates', destructive: true },
    ],
  })
  draw()
  fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
  await waitFor(() => expect(screen.getByText('#42')).toBeTruthy())
  expect(screen.getByText('#42').closest('a').getAttribute('href')).toBe('/jobs/42')
  expect(screen.getByText('#5').closest('a').getAttribute('href')).toBe('/clients/5')
  expect(screen.getByText('#9').closest('a').getAttribute('href')).toBe('/clients/9')
})

// duplicate_client_email keys its sample_ids on the shared EMAIL strings, not
// client ids — those must not render as /clients/<email> links.
it('does not linkify a finding whose sample_ids are not record ids', async () => {
  get.mockResolvedValue({
    healthy: false,
    summary: { warn: 1 },
    findings: [
      { code: 'duplicate_client_email', severity: 'warn', table: 'clients',
        message: '1 email addresses are shared by more than one client',
        count: 1, sample_ids: ['sam@example.com'], truncated: false,
        suggestion: 'Merge the duplicates', destructive: true },
    ],
  })
  draw()
  fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
  await waitFor(() => expect(screen.getByText(/shared by more than one client/)).toBeTruthy())
  expect(screen.queryByText('Open:')).toBeNull()
  expect(screen.queryByText('#sam@example.com')).toBeNull()
})

it('shows nothing but the button for a non-admin', () => {
  try { localStorage.setItem('brightbase_user', JSON.stringify({ role: 'cleaner' })) } catch { /* ignore */ }
  const { container } = draw()
  expect(container.firstChild).toBeNull()
})
