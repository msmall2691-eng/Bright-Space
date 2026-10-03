/**
 * PropertyPhoto now takes either an `address` (the staff, address-keyed quotes
 * endpoint) or an explicit `url` (a caller's own gated route — the crew app's
 * assigned-only job photo). These pin which endpoint it hits in each mode, and
 * that it renders nothing / never fetches when it has neither.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import PropertyPhoto from '../PropertyPhoto'

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:stub')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mockFetchOk() {
  const blob = new Blob(['x'], { type: 'image/jpeg' })
  const spy = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) })
  vi.stubGlobal('fetch', spy)
  return spy
}

it('fetches the explicit url when given one (crew mode)', async () => {
  const spy = mockFetchOk()
  render(<PropertyPhoto url="/api/crew/jobs/7/property-photo" />)
  await waitFor(() => expect(spy).toHaveBeenCalled())
  expect(spy.mock.calls[0][0]).toBe('/api/crew/jobs/7/property-photo')
  expect(await screen.findByAltText(/street view/i)).toBeTruthy()
})

it('builds the staff quotes url from an address when no url is given', async () => {
  const spy = mockFetchOk()
  render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(spy).toHaveBeenCalled())
  expect(spy.mock.calls[0][0]).toContain('/api/quotes/property-photo?address=')
  expect(spy.mock.calls[0][0]).toContain(encodeURIComponent('12 Harbor Rd'))
})

it('renders nothing and never fetches without a url or a usable address', () => {
  const spy = mockFetchOk()
  const { container } = render(<PropertyPhoto address="" />)
  expect(container.firstChild).toBeNull()
  expect(spy).not.toHaveBeenCalled()
})
