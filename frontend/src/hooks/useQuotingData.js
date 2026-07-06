import { useEffect, useState } from 'react'
import { get } from '../api'

/** Guard (June 10 P1): one malformed row — legacy JSON shapes where items
 *  is a dict/string, or a non-string status — must never crash or wedge the
 *  page. Coerce the fields the page iterates/renders before they reach state.
 *  Exported so mutation handlers can sanitize freshly-returned rows the same
 *  way the initial fetch does. */
export const safeQuote = (q) => ({
  ...q,
  items: Array.isArray(q?.items) ? q.items : [],
  status: typeof q?.status === 'string' ? q.status : 'draft',
})

/** Loads everything the Quoting page renders: quotes + intakes + follow-ups
 *  + clients + templates + company identity. Returns the four aggregate lists
 *  + their setters (mutations still call the setters for optimistic patches)
 *  + refetchers each mutation handler can call after write. */
export function useQuotingData() {
  const [quotes, setQuotes] = useState([])
  const [followUps, setFollowUps] = useState([])
  const [intakes, setIntakes] = useState([])
  const [clients, setClients] = useState([])
  const [quoteTemplates, setQuoteTemplates] = useState([])
  // Gate the template editor until the initial GET settles. Without this, an
  // admin could open the editor while templates are still [] (loading), then
  // Save — overwriting all stored templates with an empty list.
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  // Full customer-facing identity (Settings → General) — drives the REAL
  // public-page preview, SMS copy, and send-panel subject prefill.
  const [company, setCompany] = useState({ company_name: 'The Maine Cleaning Co.' })
  const [archivedQuotes, setArchivedQuotes] = useState([])

  const loadQuotes = () => get('/api/quotes').then(d => setQuotes(Array.isArray(d) ? d.map(safeQuote) : [])).catch(err => console.error('[Quoting]', err))
  const loadIntakes = () => get('/api/intake').then(d => setIntakes(Array.isArray(d) ? d : [])).catch(err => console.error('[Quoting]', err))
  // Quotes the customer is sitting on (sent-but-unopened / opened-but-no-reply).
  const loadFollowUps = () => get('/api/quotes/follow-ups').then(d => setFollowUps(Array.isArray(d) ? d.map(safeQuote) : [])).catch(err => console.error('[Quoting]', err))
  const loadArchived = () => get('/api/quotes?status=archived')
    .then(d => setArchivedQuotes(Array.isArray(d) ? d.map(safeQuote) : []))
    .catch(err => console.error('[Quoting]', err))

  useEffect(() => {
    loadQuotes()
    loadIntakes()
    loadFollowUps()
    get('/api/clients').then(d => setClients(Array.isArray(d) ? d : [])).catch(err => console.error('[Quoting]', err))
    get('/api/settings/quote-templates').then(d => {
      // Treat any array as authoritative — including [] — so deleting every
      // template sticks instead of the hardcoded defaults reappearing on reload.
      if (Array.isArray(d?.templates)) setQuoteTemplates(d.templates)
    }).catch(() => {}).finally(() => setTemplatesLoaded(true))
    // Customer-facing identity for previews/SMS/subjects. /general is the
    // canonical source; fall back to the legacy settings dump for viewers.
    get('/api/settings/general')
      .then(d => setCompany(c => ({ ...c, ...Object.fromEntries(Object.entries(d || {}).filter(([, v]) => v != null)) })))
      .catch(() => get('/api/settings')
        .then(d => { if (d?.company_name) setCompany(c => ({ ...c, company_name: d.company_name })) })
        .catch(() => {}))
  }, [])

  return {
    quotes, setQuotes,
    followUps, setFollowUps,
    intakes, setIntakes,
    clients, setClients,
    quoteTemplates, setQuoteTemplates,
    templatesLoaded,
    company,
    companyName: company.company_name || 'The Maine Cleaning Co.',
    archivedQuotes,
    loadQuotes, loadIntakes, loadFollowUps, loadArchived,
  }
}
