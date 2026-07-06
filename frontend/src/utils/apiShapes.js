/**
 * Normalize an API response into a plain array.
 *
 * Bright-Space collection endpoints don't yet agree on one shape (issue #90 /
 * docs/api-shapes.md): most return a raw array, `/api/visits` returns a
 * paginated envelope `{ items, total, limit, offset }`, and one route wraps
 * its list under `.messages`. Use this helper at every fetch boundary so
 * downstream `.filter/.map` calls never crash on the envelope form.
 *
 * When the endpoint's shape eventually changes, the update is a one-line swap
 * here instead of a hunt through every call site.
 */
export const toArray = (res) => {
  if (Array.isArray(res)) return res
  if (res && Array.isArray(res.items)) return res.items
  if (res && Array.isArray(res.data)) return res.data
  if (res && Array.isArray(res.messages)) return res.messages
  return []
}
