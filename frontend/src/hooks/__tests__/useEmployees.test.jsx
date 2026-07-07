import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

// Mock the api module BEFORE importing the hook so the hook picks up our
// stubbed getCached rather than the real network call.
const apiState = {
  calls: 0,
  resolvers: [],
  makePayload: null,
}

vi.mock('../../api', () => ({
  getCached: vi.fn(async (url) => {
    apiState.calls += 1
    // Simulate a normal /api/dispatch/employees response shape.
    return apiState.makePayload ? apiState.makePayload(url) : []
  }),
}))

import { useEmployees } from '../useEmployees'

afterEach(() => {
  apiState.calls = 0
  apiState.makePayload = null
  cleanup()
})

describe('useEmployees', () => {
  it('exposes the roster once the fetch resolves', async () => {
    apiState.makePayload = () => [
      { id: 1, name: 'Ana' },
      { userId: '2', displayName: 'Bo' },
    ]
    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.employees).toHaveLength(2)
    expect(result.current.employeeById['1']?.name).toBe('Ana')
    expect(result.current.employeeById['2']).toBeTruthy()
  })

  it('empName maps ids to display names and falls back to "Cleaner N"', async () => {
    apiState.makePayload = () => [{ id: 42, name: 'Chris' }]
    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.empName(42)).toBe('Chris')
    expect(result.current.empName('42')).toBe('Chris')
    expect(result.current.empName(99)).toBe('Cleaner 99')
    expect(result.current.empName(null)).toBe('')
  })

  it('surfaces error + empty roster if the fetch throws', async () => {
    const { getCached } = await import('../../api')
    getCached.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useEmployees())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.employees).toEqual([])
    expect(result.current.error).toBeInstanceOf(Error)
  })
})
