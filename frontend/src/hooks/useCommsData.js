import { useCallback, useEffect, useRef, useState } from 'react'
import { get, post, getCached } from '../api'

/** Data-loading + polling for the Comms unified inbox.
 *
 *  Owns:
 *   • Fetched state: convs, summary, detail, loadingDetail, clients.
 *   • Selection: selectedId (parent flips it via setSelectedId).
 *   • Load callbacks: loadList, loadSummary, loadDetail, loadClients.
 *     Filter inputs (folder / chipFilters / channelFilter / search) come in
 *     as args, so the parent still owns the filter state — the debounced
 *     refresh re-runs whenever any of them changes.
 *   • Effects: initial load, per-filter debounced refresh, per-selection
 *     detail fetch, thread auto-scroll to bottom, 15s poller.
 *   • threadRef: attached to the scroll container in the thread view; the
 *     scroll-to-bottom effect keys off detail.messages.length.
 *
 *  The parent's mutation actions (sendReply / setStatus / setPriority /
 *  setAssignee) call loadList / loadDetail / loadSummary directly. */
export function useCommsData({ folder, chipFilters, channelFilter, search }) {
  const [convs, setConvs] = useState([])
  const [summary, setSummary] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [clients, setClients] = useState([])

  const threadRef = useRef(null)

  const loadList = useCallback(async () => {
    const params = new URLSearchParams()
    // Folder maps to status + (optionally) assignee. Status names on the
    // backend stay as 'open'/'resolved' for API compat; UI renames them.
    if (folder === 'mine') {
      params.set('status', 'open')
      const stored = localStorage.getItem('brightbase_user')
      const currentUser = stored ? JSON.parse(stored) : null
      params.set('assignee', currentUser?.email?.split('@')[0] || 'Me')
    } else if (folder === 'done') {
      params.set('status', 'resolved')
    } else {
      params.set('status', 'open') // 'active'
    }
    // Chip filters layer on top.
    if (chipFilters.has('overdue'))     params.set('sla_state', 'breached')
    if (chipFilters.has('unread'))      params.set('unread_only', 'true')
    if (chipFilters.has('unassigned') && folder !== 'mine') {
      // 'unassigned' is mutually exclusive with 'mine'; skip when on Mine.
      params.set('assignee', 'unassigned')
    }
    if (channelFilter) params.set('channel', channelFilter)
    if (search) params.set('q', search)
    try {
      const data = await get(`/api/comms/conversations?${params.toString()}`)
      setConvs(data)
    } catch (e) { console.error('[Comms] loadList:', e) }
    finally { setLoadingList(false) }
  }, [folder, chipFilters, channelFilter, search])

  const loadSummary = useCallback(async () => {
    try { setSummary(await getCached('/api/comms/conversations/summary')) }
    catch (e) { console.error('[Comms] loadSummary:', e) }
  }, [])

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return }
    setLoadingDetail(true)
    try {
      const d = await get(`/api/comms/conversations/${id}`)
      setDetail(d)
      if (d.unread_count > 0) {
        await post(`/api/comms/conversations/${id}/read`)
        setDetail(prev => prev ? { ...prev, unread_count: 0 } : prev)
        setConvs(prev => prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c))
        loadSummary()
      }
    } catch (e) { console.error('[Comms] loadDetail:', e) }
    finally { setLoadingDetail(false) }
  }, [loadSummary])

  const loadClients = useCallback(async () => {
    try { setClients(await get('/api/clients?limit=100')) }
    catch (e) { console.error('[Comms] loadClients:', e) }
  }, [])

  useEffect(() => { loadSummary(); loadClients() }, [loadSummary, loadClients])
  // Refresh the list whenever ANY filter changes (folder / channel / chips /
  // search). loadList is rebuilt by useCallback on each of those, so depending
  // on it covers them all — previously this watched only `search`, so tapping
  // a channel/folder/chip didn't refresh until the 15s poller fired. The small
  // debounce keeps typing in the search box smooth.
  useEffect(() => { const t = setTimeout(() => loadList(), 250); return () => clearTimeout(t) }, [loadList])
  useEffect(() => { loadDetail(selectedId) }, [selectedId, loadDetail])
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [detail?.messages?.length])
  useEffect(() => {
    const iv = setInterval(() => {
      loadList(); loadSummary()
      if (selectedId) loadDetail(selectedId)
    }, 15000)
    return () => clearInterval(iv)
  }, [selectedId, loadList, loadSummary, loadDetail])

  return {
    convs,
    summary,
    selectedId, setSelectedId,
    detail,
    loadingDetail,
    loadingList,
    clients,
    threadRef,
    loadList,
    loadSummary,
    loadDetail,
  }
}
