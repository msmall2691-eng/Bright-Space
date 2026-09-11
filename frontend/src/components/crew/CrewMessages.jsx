/**
 * Chat tab — "Message the office" thread (crew side).
 *
 * One thread per cleaner. Sends push to staff; office replies land here
 * (and push back). Fetch on open + after send — no live socket; the push
 * notification is the "you have a reply" signal.
 *
 * The chat surface itself is the shared <Thread> (same one Ask uses).
 */
import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../../api'
import Thread from './Thread'

const fmtTime = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
  catch { return '' }
}

export function CrewThread({ onClose, previewUserId = null }) {
  const [msgs, setMsgs] = useState(null)
  const [error, setError] = useState(null)

  // The office's chat with a cleaner is a live two-way thread the office
  // already holds in its own inbox — previewing it here would be reading its
  // own conversation, and sending would post AS the cleaner. So in an office
  // preview the chat is not fetched and not sendable.
  const preview = previewUserId != null

  const load = useCallback(() => {
    if (preview) { setMsgs([]); return }
    get('/api/crew/messages')
      .then(setMsgs)
      .catch(e => setError(e.detail || e.message || 'Could not load'))
  }, [preview])
  useEffect(() => { load() }, [load])

  const send = async (text) => {
    if (preview) return
    setError(null)
    try {
      await post('/api/crew/messages', { body: text })
      load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not send')
      throw e   // Thread puts the draft back in the box
    }
  }

  return (
    <Thread
      title="The office"
      subtitle="They get a ping when you send"
      onClose={onClose}
      loading={msgs === null && !error}
      messages={(msgs || []).map(m => ({
        key: m.id,
        mine: m.sender === 'cleaner',
        body: m.body,
        meta: `${m.sender === 'office' ? `${m.sender_name || 'Office'} · ` : ''}${fmtTime(m.created_at)}`,
      }))}
      empty={preview
        ? "Chat isn't shown in preview — the office's thread with a cleaner lives in the office inbox."
        : "No messages yet — say hi, ask about a schedule, report a problem."}
      error={error}
      onSend={send}
      maxLength={2000}
      placeholder={preview ? 'Not available in preview' : 'Message the office…'}
    />
  )
}

export default CrewThread
