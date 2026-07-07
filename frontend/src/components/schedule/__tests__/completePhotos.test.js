import { describe, it, expect } from 'vitest'
import {
  mergePhotosForSubmit,
  readFileAsUpload,
  MAX_FILE_BYTES,
  MAX_TOTAL_PHOTOS,
} from '../completePhotos'

describe('mergePhotosForSubmit', () => {
  it('puts staged uploads before pasted URLs', () => {
    const staged = [{ kind: 'upload', data_url: 'data:image/jpeg;base64,AAA' }]
    const urls = 'https://cdn/one.jpg\nhttps://cdn/two.jpg'
    expect(mergePhotosForSubmit(staged, urls)).toEqual([
      { kind: 'upload', data_url: 'data:image/jpeg;base64,AAA' },
      'https://cdn/one.jpg',
      'https://cdn/two.jpg',
    ])
  })

  it('drops blank and whitespace-only lines from pasted URLs', () => {
    const urls = '  \nhttps://cdn/x.jpg\n\n   \nhttps://cdn/y.jpg\n'
    expect(mergePhotosForSubmit([], urls)).toEqual([
      'https://cdn/x.jpg',
      'https://cdn/y.jpg',
    ])
  })

  it('handles missing or non-array inputs', () => {
    expect(mergePhotosForSubmit(null, null)).toEqual([])
    expect(mergePhotosForSubmit(undefined, undefined)).toEqual([])
    expect(mergePhotosForSubmit('not-an-array', 'url')).toEqual(['url'])
  })

  it('filters out falsy entries from staged uploads', () => {
    const staged = [{ data_url: 'a' }, null, { data_url: 'b' }, undefined]
    expect(mergePhotosForSubmit(staged, '')).toEqual([
      { data_url: 'a' },
      { data_url: 'b' },
    ])
  })
})

describe('readFileAsUpload', () => {
  // Vitest's jsdom environment provides FileReader + File, so we can round-trip
  // a tiny blob and assert the packaging matches what the backend stores.
  it('packages a File into the {kind:"upload", data_url, ...} shape', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'kitchen.jpg', { type: 'image/jpeg' })
    const packaged = await readFileAsUpload(file)
    expect(packaged.kind).toBe('upload')
    expect(packaged.mime).toBe('image/jpeg')
    expect(packaged.name).toBe('kitchen.jpg')
    expect(packaged.size).toBe(3)
    expect(packaged.data_url).toMatch(/^data:image\/jpeg;base64,/)
    expect(typeof packaged.added_at).toBe('string')
  })

  it('falls back to image/jpeg when the File has no type', async () => {
    const file = new File([new Uint8Array([9])], 'photo', { type: '' })
    const packaged = await readFileAsUpload(file)
    expect(packaged.mime).toBe('image/jpeg')
  })
})

describe('caps', () => {
  it('exposes sensible per-file and total limits', () => {
    // Guardrail — the modal wires these into its "N/20" counter and file
    // input check; changing them intentionally is fine, changing them by
    // accident (e.g. dropping a 0) would break the UX.
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_TOTAL_PHOTOS).toBe(20)
  })
})
