import { Home, Building2, Wind } from 'lucide-react'

/** Source dropdown values + their display labels. Keep aligned with the
 *  backend's iCal source labels (used as "ical_source" on Visit rows for
 *  turnover idempotency). */
export const ICAL_SOURCES = [
  { value: 'airbnb',     label: 'Airbnb' },
  { value: 'vrbo',       label: 'VRBO' },
  { value: 'booking_com', label: 'Booking.com' },
  { value: 'manual',     label: 'Manual / Custom' },
]

/** Empty scaffold for a new/reset property form. Keep every persisted
 *  field here so `setForm(EMPTY)` fully resets state between edits. */
export const EMPTY = {
  client_id: '', property_type: 'residential', name: '', address: '', city: '', state: '',
  zip_code: '', default_duration_hours: 3, default_crew_size: null,
  access_notes: '', parking_notes: '',
  check_in_time: '14:00', check_out_time: '10:00', house_code: '', timezone: '',
  business_name: '', hours_of_operation: '',
  notes: '', custom_fields: {},
}

/** Per-type visual config: badge color, icon, accent color. */
export const PROPERTY_TYPE_CONFIG = {
  residential: { label: 'Residential', badge: 'bg-blue-100 text-blue-700',   icon: Home,      color: 'text-blue-600' },
  commercial:  { label: 'Commercial',  badge: 'bg-purple-100 text-purple-700', icon: Building2, color: 'text-purple-600' },
  str:         { label: 'STR',         badge: 'bg-amber-100 text-amber-700', icon: Wind,      color: 'text-amber-600' },
}
