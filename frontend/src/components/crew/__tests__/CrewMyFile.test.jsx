/**
 * "My file" — the screen that turns a 403 into something a sub can act on.
 *
 * The claim endpoint refuses anyone whose file is incomplete. Before this
 * screen the refusal was all a sub got: no list, no upload, no way forward.
 * So what's pinned here is that the missing pieces are NAMED and each one is
 * the thing you tap — and that an expiring certificate can't be uploaded
 * without the date off it, because the date is how the office knows when to
 * ask for the next one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn(), upload: vi.fn() }))
vi.mock('../../../utils/toastBus', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { get, post, upload } from '../../../api'
import CrewMyFile from '../CrewMyFile'

const INCOMPLETE = {
  can_take_jobs: false,
  missing: ['Sign the subcontractor agreement', 'Upload your certificate of insurance'],
  agreement_version: '2026-09', agreement_accepted: false,
  documents: [
    { kind: 'w9', label: 'W-9', required: true, expires: false,
      status: 'accepted', expires_at: null, notes: null },
    { kind: 'coi', label: 'Certificate of insurance', required: true, expires: true,
      status: 'missing', expires_at: null, notes: null },
    { kind: 'license', label: 'Licence', required: false, expires: true,
      status: 'missing', expires_at: null, notes: null },
  ],
}
const COMPLETE = { ...INCOMPLETE, can_take_jobs: true, missing: [], agreement_accepted: true }

const mount = (payload = INCOMPLETE) => { get.mockResolvedValue(payload); return render(<CrewMyFile bare />) }

beforeEach(() => { get.mockReset(); post.mockReset(); post.mockResolvedValue(COMPLETE) })
afterEach(cleanup)

it('names every missing piece, in the order to do them', async () => {
  mount()
  expect(await screen.findByText('To start asking for jobs:')).toBeTruthy()
  // Matched inside the list: the sign-the-agreement BUTTON carries the same
  // words, and a loose getByText would pass on the button while the list said
  // nothing.
  const todo = screen.getByText('To start asking for jobs:').parentElement
  expect(todo.textContent).toContain('Sign the subcontractor agreement')
  expect(todo.textContent).toContain('Upload your certificate of insurance')
})

it('says plainly when the file is done', async () => {
  mount(COMPLETE)
  expect(await screen.findByText(/Your file is complete/)).toBeTruthy()
  expect(screen.queryByText('To start asking for jobs:')).toBeNull()
})

it('signs the agreement and takes the refreshed file back', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Sign the subcontractor agreement/ }))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/crew/my-file/agreement', {}))
  // The POST returns the whole file — no second request to find out what changed.
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
})

it('will not let a certificate be uploaded before its expiry date is set', async () => {
  // The server refuses it, and the date is how the office knows when to ask
  // for the next one — so it's asked for before the file picker opens rather
  // than surfacing as a failed upload.
  mount()
  await screen.findByText('Certificate of insurance')
  const coiRow = screen.getByText('Certificate of insurance').closest('div').parentElement.parentElement
  const upload = [...coiRow.querySelectorAll('button')].find(b => /Upload/.test(b.textContent))
  expect(upload.disabled).toBe(true)
  expect(upload.getAttribute('title')).toMatch(/expiry date first/)
})

it('a document with no expiry can be uploaded straight away', async () => {
  mount()
  await screen.findByText('W-9')
  const w9Row = screen.getByText('W-9').closest('div').parentElement.parentElement
  const btn = [...w9Row.querySelectorAll('button')].find(b => /Replace|Upload/.test(b.textContent))
  expect(btn.disabled).toBe(false)
})

it('shows the office’s reason when something was sent back', async () => {
  // Without it, "needs review" is a dead end for the person who has to fix it.
  mount({ ...INCOMPLETE, documents: [
    { ...INCOMPLETE.documents[0], status: 'pending', notes: 'The date is cut off' }] })
  expect(await screen.findByText(/The date is cut off/)).toBeTruthy()
})

it('says nothing changed when the file cannot be loaded', async () => {
  get.mockRejectedValue(new Error('offline'))
  render(<CrewMyFile bare />)
  expect(await screen.findByText(/Nothing has changed/)).toBeTruthy()
})


// ── The upload had to be a multipart POST, and wasn't ───────────────────────
// It went through post(), which does JSON.stringify(body) and forces
// Content-Type: application/json. JSON.stringify(new FormData()) is "{}", so
// every W-9 and every certificate reached a multipart endpoint as an empty
// JSON object and 422'd — for everyone, every time. Nothing downstream could
// work: can_take_jobs is derived from these documents, so no subcontractor
// recruited after the vetting gate could ever ask for a job.
//
// The old test mocked `post` and asserted it was called, which is exactly why
// this passed CI while being completely broken in a browser. It now asserts
// the helper that actually sends multipart, and that a FormData carrying the
// real file is what reaches it.
describe('the document upload actually sends the file', () => {
  beforeEach(() => {
    get.mockResolvedValue(INCOMPLETE)
    upload.mockResolvedValue(INCOMPLETE)
    post.mockResolvedValue(INCOMPLETE)
  })
  afterEach(cleanup)

  it('posts multipart via upload(), never JSON via post()', async () => {
    const { container } = render(<CrewMyFile />)
    await screen.findByText('Certificate of insurance')

    const input = container.querySelector('input[type="file"]')
    expect(input).toBeTruthy()
    const file = new File(['pretend-pdf'], 'coi.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(upload).toHaveBeenCalled())

    const [url, body] = upload.mock.calls[0]
    expect(url).toContain('/api/crew/my-file/')
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('file')).toBe(file)

    // The precise regression: a FormData handed to post() serializes to "{}".
    expect(post).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/crew/my-file/'), expect.any(FormData))
  })
})
