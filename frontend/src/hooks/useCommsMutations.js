import { useCallback } from 'react'
import { post } from '../api'

const currentUsername = () =>
  JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Unknown'

/** Server-side mutations for the open conversation: assign, status,
 *  priority, and send-reply-or-note. Each function POSTs, then refreshes
 *  detail + list (and summary, for status changes that affect folder
 *  counts). Compose UX state (sending / flash / clearing inputs) stays in
 *  Comms.jsx — this hook just returns pure async wrappers. */
export function useCommsMutations({ detail, loadDetail, loadList, loadSummary }) {
  const refreshDetailAndList = useCallback(async () => {
    if (!detail) return
    await loadDetail(detail.id)
    await loadList()
  }, [detail, loadDetail, loadList])

  const setAssignee = useCallback(async (a) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/assign`, {
      assignee: a === 'Unassigned' ? null : a,
    })
    await refreshDetailAndList()
  }, [detail, refreshDetailAndList])

  // Phase F: assign to a real user (or null to unassign). Sends assignee_user_id
  // so ownership is a proper reference, not a free-text name.
  const assignUser = useCallback(async (user) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/assign`, {
      assignee_user_id: user?.id ?? null,
    })
    await refreshDetailAndList()
  }, [detail, refreshDetailAndList])

  const setStatus = useCallback(async (s) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/status`, { status: s })
    await refreshDetailAndList()
    await loadSummary()
  }, [detail, loadSummary, refreshDetailAndList])

  const setPriority = useCallback(async (p) => {
    if (!detail) return
    await post(`/api/comms/conversations/${detail.id}/priority`, { priority: p })
    await refreshDetailAndList()
  }, [detail, refreshDetailAndList])

  /** Send an outbound message or save an internal note. Caller passes
   *  { body, subject, isNote }; email subject only sticks when the
   *  conversation channel is 'email'. */
  const sendReplyOrNote = useCallback(async ({ body, subject, isNote }) => {
    if (!body?.trim() || !detail) return
    const author = currentUsername()
    if (isNote) {
      await post(`/api/comms/conversations/${detail.id}/notes`, { body, author })
    } else {
      await post(`/api/comms/conversations/${detail.id}/messages`, {
        body,
        subject: detail.channel === 'email' ? (subject || detail.subject) : undefined,
        author,
      })
    }
    await refreshDetailAndList()
  }, [detail, refreshDetailAndList])

  return { setAssignee, assignUser, setStatus, setPriority, sendReplyOrNote }
}
