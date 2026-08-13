// fitWithin is the piece that decides what actually gets stored — a wrong
// rounding here ships every photo at the wrong size, silently. The canvas
// plumbing around it is exercised in real browsers, not jsdom.
import { describe, it, expect } from 'vitest'
import { fitWithin, MAX_DIMENSION } from '../imageDownscale'

describe('fitWithin', () => {
  it('never upscales a small image', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1600, 1200)).toEqual({ width: 1600, height: 1200 })
  })

  it('caps the longest edge at maxDim, preserving aspect', () => {
    // 4032×3024 — a stock iPhone photo.
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 })
    // Portrait orientation caps on height instead.
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 })
  })

  it('respects a custom maxDim', () => {
    expect(fitWithin(4000, 2000, 400)).toEqual({ width: 400, height: 200 })
  })

  it('survives degenerate inputs without a zero dimension', () => {
    // A 1px-tall panorama must not round the short edge to 0 (a 0-height
    // canvas throws on toBlob).
    const out = fitWithin(10000, 1)
    expect(out.width).toBe(MAX_DIMENSION)
    expect(out.height).toBeGreaterThanOrEqual(1)
    expect(fitWithin(0.4, 0.4)).toEqual({ width: 1, height: 1 })
  })
})
