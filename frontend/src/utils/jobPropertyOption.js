/**
 * The one-entry `properties` list JobEditModal needs when it's opened from a
 * page that hasn't loaded the property roster (Quoting, QuoteDetail). The
 * modal's property <select> only labels an option it can find in that list —
 * with an empty list a job that HAS a property renders as "Select a
 * property...". Built from fields already on the job payload, so it costs no
 * request (brightbase-economy).
 */
export function jobPropertyOption(job) {
  if (!job?.property_id) return []
  return [{
    id: job.property_id,
    client_id: job.client_id,
    name: job.property_name || job.title || `Property #${job.property_id}`,
    address: job.address || '',
    property_type: job.job_type === 'str_turnover' ? 'str' : (job.job_type || 'residential'),
  }]
}
