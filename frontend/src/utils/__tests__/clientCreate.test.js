/**
 * The shared "create a client, but check for duplicates first" helper used by
 * every inline "+ New client" affordance. Pins the two things that were broken
 * before it existed: reading the duplicates off a 409 (api.js flattens the
 * error so `detail` is a JSON *string*), and the pre-check short-circuit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api', () => ({
  get: vi.fn(),
  post: vi.fn(),
}))

import { get, post } from '../../api'
import { checkClientDuplicates, duplicatesFrom409, createClientChecked } from '../clientCreate'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('duplicatesFrom409', () => {
  it('parses a JSON-string detail (how api.js flattens it)', () => {
    const err = { status: 409, detail: JSON.stringify({ duplicates: [{ id: 7, name: 'Meg' }] }) }
    expect(duplicatesFrom409(err)).toEqual([{ id: 7, name: 'Meg' }])
  })
  it('handles an already-parsed object detail', () => {
    const err = { status: 409, detail: { duplicates: [{ id: 9 }] } }
    expect(duplicatesFrom409(err)).toEqual([{ id: 9 }])
  })
  it('returns [] for a non-409', () => {
    expect(duplicatesFrom409({ status: 422, detail: '{}' })).toEqual([])
  })
  it('returns [] for unparseable detail', () => {
    expect(duplicatesFrom409({ status: 409, detail: 'not json' })).toEqual([])
  })
})

describe('checkClientDuplicates', () => {
  it('queries by the provided fields and returns the matches', async () => {
    get.mockResolvedValue({ duplicates: [{ id: 3, name: 'Dup' }] })
    const out = await checkClientDuplicates({ name: 'Dup', email: 'd@x.co' })
    expect(out).toEqual([{ id: 3, name: 'Dup' }])
    const url = get.mock.calls[0][0]
    expect(url).toContain('/api/clients/check-duplicate?')
    expect(url).toContain('name=Dup')
    expect(url).toContain('email=d%40x.co')
  })
  it('skips the call and returns [] when nothing identifying was given', async () => {
    const out = await checkClientDuplicates({})
    expect(out).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
  it('fails soft to [] when the pre-check errors', async () => {
    get.mockRejectedValue(new Error('boom'))
    expect(await checkClientDuplicates({ name: 'X' })).toEqual([])
  })
})

describe('createClientChecked', () => {
  it('returns duplicates from the pre-check without creating', async () => {
    get.mockResolvedValue({ duplicates: [{ id: 1, name: 'Existing' }] })
    const res = await createClientChecked({ name: 'Existing' })
    expect(res).toEqual({ status: 'duplicates', duplicates: [{ id: 1, name: 'Existing' }] })
    expect(post).not.toHaveBeenCalled()
  })

  it('creates when the pre-check is clear', async () => {
    get.mockResolvedValue({ duplicates: [] })
    post.mockResolvedValue({ id: 42, name: 'New' })
    const res = await createClientChecked({ name: 'New' })
    expect(res).toEqual({ status: 'created', client: { id: 42, name: 'New' } })
    expect(post.mock.calls[0][0]).toBe('/api/clients')
  })

  it('force=true skips the pre-check and posts ?force=true', async () => {
    post.mockResolvedValue({ id: 5 })
    const res = await createClientChecked({ name: 'Dup' }, { force: true })
    expect(get).not.toHaveBeenCalled()
    expect(post.mock.calls[0][0]).toBe('/api/clients?force=true')
    expect(res.status).toBe('created')
  })

  it('surfaces a server-side 409 (a match the pre-check missed) as duplicates', async () => {
    get.mockResolvedValue({ duplicates: [] })
    post.mockRejectedValue({ status: 409, detail: JSON.stringify({ duplicates: [{ id: 8, name: 'Race' }] }) })
    const res = await createClientChecked({ name: 'Race', phone: '2075550000' })
    expect(res).toEqual({ status: 'duplicates', duplicates: [{ id: 8, name: 'Race' }] })
  })

  it('rethrows a non-409 create error', async () => {
    get.mockResolvedValue({ duplicates: [] })
    post.mockRejectedValue(new Error('server down'))
    await expect(createClientChecked({ name: 'Z' })).rejects.toThrow('server down')
  })
})
