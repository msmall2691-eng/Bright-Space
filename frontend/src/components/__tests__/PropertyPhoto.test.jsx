/**
 * PropertyPhoto now takes either an `address` (the staff, address-keyed quotes
 * endpoint) or an explicit `url` (a caller's own gated route — the crew app's
 * assigned-only job photo). These pin which endpoint it hits in each mode, and
 * that it renders nothing / never fetches when it has neither.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import PropertyPhoto, { __resetPhotoCache } from '../PropertyPhoto'

let urlSeq = 0
beforeEach(() => {
  // A DISTINCT url per call, so the tests below can tell whose object URL was
  // revoked. A single stub would make the sharing bug invisible.
  urlSeq = 0
  URL.createObjectURL = vi.fn(() => `blob:stub-${++urlSeq}`)
  URL.revokeObjectURL = vi.fn()
  __resetPhotoCache()
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

/* Every fetch here is a billed Street View call, so these are about money as
 * much as about correctness. The shape they pin is Requests': a list card and
 * the drawer for the row you just opened, both on one address. */

it('buys one photo when two instances want the same endpoint', async () => {
  const spy = mockFetchOk()
  render(<><PropertyPhoto address="12 Harbor Rd" /><PropertyPhoto address="12 Harbor Rd" /></>)
  await waitFor(() => expect(screen.getAllByAltText(/street view/i)).toHaveLength(2))
  expect(spy, 'the same address was fetched twice').toHaveBeenCalledTimes(1)
})

it('gives each instance its own object URL, so one unmounting does not blank the other', async () => {
  // The bug this exists for would be invisible with a shared URL: close the
  // drawer, the list row behind it goes blank, and nothing throws.
  mockFetchOk()
  const a = render(<PropertyPhoto address="12 Harbor Rd" />)
  await screen.findByAltText(/street view/i)
  const b = render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(screen.getAllByAltText(/street view/i)).toHaveLength(2))

  const urls = screen.getAllByAltText(/street view/i).map(img => img.getAttribute('src'))
  expect(new Set(urls).size, 'both instances share one object URL').toBe(2)

  b.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[1])
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(urls[0])
  expect(a.container.querySelector('img')?.getAttribute('src')).toBe(urls[0])
})

it('remembers a 404, because asking again buys the same no', async () => {
  // Google has no imagery for this address. That answer does not change, and
  // re-asking is another metered call.
  const spy = vi.fn().mockResolvedValue({ ok: false, status: 404 })
  vi.stubGlobal('fetch', spy)
  const first = render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  first.unmount()

  render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
})

it('does not remember a dropped connection, which is the rural-cell case', async () => {
  // A network error has no status. Caching it would blank the photo for the
  // rest of the session over one lost packet.
  const spy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', spy)
  const first = render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  first.unmount()

  render(<PropertyPhoto address="12 Harbor Rd" />)
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
})
