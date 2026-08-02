import { MapPin, Printer } from 'lucide-react'
import { mapsDirectionsUrl } from '../../utils/maps'

/** "Get directions" (Google Maps multi-stop route through the day's
 *  addresses, in whatever order the day is already sorted — no lat/lng
 *  needed) + "Print" (day sheet via window.print(), Tier 4 roadmap items
 *  13 and 15). Shared between AgendaHero (the live agenda header) and
 *  AgendaDay's own header (the standalone/hideHeader=false case). */
export default function DayActionButtons({ visits, jobs, properties, className = '' }) {
  const addresses = (visits || [])
    .filter(v => v.status !== 'cancelled')
    .map(v => properties?.[jobs?.[v.job_id]?.property_id]?.address)
    .filter(Boolean)
  const directionsUrl = mapsDirectionsUrl(addresses)

  return (
    <div className={`no-print flex items-center gap-2 ${className}`}>
      {directionsUrl && (
        <a
          href={directionsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg bg-bg-2 hover:bg-hairline text-ink-2 transition-colors"
          title="Open today's stops as a driving route in Google Maps"
        >
          <MapPin className="w-3.5 h-3.5" />
          Directions
        </a>
      )}
      <button
        onClick={() => window.print()}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg bg-bg-2 hover:bg-hairline text-ink-2 transition-colors"
        title="Print this day's schedule"
      >
        <Printer className="w-3.5 h-3.5" />
        Print
      </button>
    </div>
  )
}
