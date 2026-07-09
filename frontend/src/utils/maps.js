// Property has no lat/lng today, so "route order" (Tier 4 roadmap) is a
// Google Maps multi-stop directions link built from addresses in whatever
// order the day is already sorted (chronological) — no geocoding required.

export function mapsSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}

/** Directions URL through every stop in order. Single stop falls back to a
 *  plain search link (there's nowhere to route "from"). */
export function mapsDirectionsUrl(addresses) {
  const stops = (addresses || []).filter(Boolean)
  if (stops.length === 0) return null
  if (stops.length === 1) return mapsSearchUrl(stops[0])
  const origin = stops[0]
  const destination = stops[stops.length - 1]
  const waypoints = stops.slice(1, -1)
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'driving' })
  if (waypoints.length) params.set('waypoints', waypoints.join('|'))
  return `https://www.google.com/maps/dir/?${params.toString()}`
}
