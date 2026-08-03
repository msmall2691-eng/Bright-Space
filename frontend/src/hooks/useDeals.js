import { useCallback, useEffect, useState } from 'react'
import { get, patch, post } from '../api'

/** Data + mutations for the unified Deals board.
 *
 *  Reads the /api/deals read-model — one flat list of "deal cards" spanning
 *  both lifecycle phases: un-triaged inbox leads (kind:'lead', stage:'inbox')
 *  and opportunities (kind:'deal', at their real stage). The board renders
 *  the whole continuum from this single fetch.
 *
 *  Two mutations, matching the two kinds of row:
 *    • moveStage — a deal's stage, PATCHed to /api/opportunities (optimistic,
 *      reverts on failure), mirroring the Pipeline kanban's mover.
 *    • triageLead — the visible bridge: converting an inbox lead mints its
 *      Opportunity (POST /api/intake/{id}/convert-to-client), after which the
 *      lead drops out of the inbox and reappears as its deal. We reload to
 *      pick up the freshly-minted card rather than guess its shape. */
export function useDeals() {
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const rows = await get('/api/deals?limit=500')
      setDeals(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e?.message || 'Failed to load deals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const moveStage = useCallback(async (card, stage) => {
    if (!card || card.kind !== 'deal' || card.stage === stage) return
    const prev = card.stage
    setDeals(ds => ds.map(d => (d.id === card.id ? { ...d, stage } : d)))
    setBusyId(card.id)
    try {
      await patch(`/api/opportunities/${card.opportunity_id}`, { stage })
    } catch {
      setDeals(ds => ds.map(d => (d.id === card.id ? { ...d, stage: prev } : d)))
      setError('Could not update stage — reverted.')
    } finally {
      setBusyId(null)
    }
  }, [])

  const triageLead = useCallback(async (card) => {
    if (!card || card.kind !== 'lead') return
    setBusyId(card.id)
    try {
      await post(`/api/intake/${card.lead_id}/convert-to-client`, {})
      await load()   // the lead now has a deal — refetch to swap the card in
    } catch (e) {
      setError(e?.message || 'Could not qualify this lead')
    } finally {
      setBusyId(null)
    }
  }, [load])

  return { deals, loading, error, busyId, reload: load, moveStage, triageLead, setError }
}
