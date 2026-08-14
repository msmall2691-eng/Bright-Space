import { useMemo } from 'react'

const propType = (p) => (p?.property_type || '').toLowerCase()

/** Filter memos for the Properties page — same shape as the inline code
 *  they replace:
 *
 *  filteredProperties: base list narrowed by the currentType tab, then
 *    fuzzy-filtered on name / address / client_name against the search
 *    string. Re-runs only when properties, currentType, or search change.
 *  typeCounts: single pass over the full list producing
 *    `{ all, residential, commercial, str }` — recomputed only on data
 *    change so tab badges are cheap. */
// No door code AND no access notes on file — the crew card for any job here
// shows "no access info". Batch-fill target (owner request, Aug 2026).
export const missingAccess = (p) =>
  !(p?.house_code || '').trim() && !(p?.access_notes || '').trim()

export function usePropertyFilters({ properties, currentType, search, missingAccessOnly = false }) {
  const filteredProperties = useMemo(() => {
    let base = currentType === 'all'
      ? properties
      : properties.filter(p => propType(p) === currentType)
    if (missingAccessOnly) base = base.filter(missingAccess)
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter(p =>
      [p.name, p.address, p.client_name].some(v => (v || '').toLowerCase().includes(q)),
    )
  }, [properties, currentType, search, missingAccessOnly])

  const typeCounts = useMemo(() => {
    const counts = { all: properties.length, residential: 0, commercial: 0, str: 0 }
    for (const p of properties) {
      const t = propType(p)
      if (t in counts) counts[t] += 1
    }
    return counts
  }, [properties])

  const missingAccessCount = useMemo(
    () => properties.filter(missingAccess).length, [properties])

  return { filteredProperties, typeCounts, missingAccessCount }
}
