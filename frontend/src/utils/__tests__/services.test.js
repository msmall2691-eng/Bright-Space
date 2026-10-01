/**
 * The canonical service vocabulary: one label/dot per job_type (deep_clean
 * included — it used to render as a raw string), a normalizer from the
 * quote/property vocab, and the per-property service grouping.
 */
import { describe, it, expect } from 'vitest'
import {
  jobTypeLabel, jobTypeDot, normalizeServiceType,
  serviceGroupKey, groupJobsByService, SERVICE_GROUPS,
} from '../services'

describe('job_type labels/dots', () => {
  it('labels every job_type, including deep_clean', () => {
    expect(jobTypeLabel('residential')).toBe('Residential')
    expect(jobTypeLabel('deep_clean')).toBe('Deep clean')
    expect(jobTypeLabel('commercial')).toBe('Commercial')
    expect(jobTypeLabel('str_turnover')).toBe('STR Turnover')
  })
  it('falls back to Residential for unknown/empty', () => {
    expect(jobTypeLabel(undefined)).toBe('Residential')
    expect(jobTypeLabel('nonsense')).toBe('Residential')
  })
  it('gives a dot class for each type', () => {
    expect(jobTypeDot('str_turnover')).toMatch(/^bg-/)
    expect(jobTypeDot('deep_clean')).toMatch(/^bg-/)
  })
})

describe('normalizeServiceType (quote/property vocab → job_type)', () => {
  it('maps the str family to str_turnover', () => {
    expect(normalizeServiceType('str')).toBe('str_turnover')
    expect(normalizeServiceType('turnover')).toBe('str_turnover')
    expect(normalizeServiceType('rental')).toBe('str_turnover')
  })
  it('maps commercial and deep clean, defaults residential', () => {
    expect(normalizeServiceType('commercial')).toBe('commercial')
    expect(normalizeServiceType('deep clean')).toBe('deep_clean')
    expect(normalizeServiceType('')).toBe('residential')
    expect(normalizeServiceType(null)).toBe('residential')
  })
})

describe('serviceGroupKey', () => {
  it('buckets specialized job types regardless of recurrence', () => {
    expect(serviceGroupKey({ job_type: 'str_turnover' })).toBe('turnover')
    expect(serviceGroupKey({ job_type: 'commercial', recurring_schedule_id: 5 })).toBe('commercial')
    expect(serviceGroupKey({ job_type: 'deep_clean' })).toBe('deep_clean')
  })
  it('splits residential into recurring vs one-time', () => {
    expect(serviceGroupKey({ job_type: 'residential', recurring_schedule_id: 9 })).toBe('recurring')
    expect(serviceGroupKey({ job_type: 'residential' })).toBe('one_time')
    expect(serviceGroupKey({})).toBe('one_time')
  })
})

describe('groupJobsByService', () => {
  it('returns only non-empty buckets, in SERVICE_GROUPS order, preserving input order', () => {
    const jobs = [
      { id: 1, job_type: 'residential' },                         // one_time
      { id: 2, job_type: 'residential', recurring_schedule_id: 7 }, // recurring
      { id: 3, job_type: 'str_turnover' },                         // turnover
      { id: 4, job_type: 'residential', recurring_schedule_id: 7 }, // recurring
    ]
    const groups = groupJobsByService(jobs)
    expect(groups.map(g => g.key)).toEqual(['recurring', 'turnover', 'one_time'])
    const recurring = groups.find(g => g.key === 'recurring')
    expect(recurring.label).toBe('Recurring clean')
    expect(recurring.jobs.map(j => j.id)).toEqual([2, 4])   // input order kept
  })
  it('handles empty/nullish input', () => {
    expect(groupJobsByService([])).toEqual([])
    expect(groupJobsByService(null)).toEqual([])
  })
  it('every group key is defined in SERVICE_GROUPS', () => {
    const keys = new Set(SERVICE_GROUPS.map(g => g.key))
    for (const jt of ['residential', 'deep_clean', 'commercial', 'str_turnover']) {
      expect(keys.has(serviceGroupKey({ job_type: jt }))).toBe(true)
    }
  })
})
