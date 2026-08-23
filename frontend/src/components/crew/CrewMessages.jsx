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

export function CrewThread({ onClose }) {
  const [msgs, setMsgs] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    get('/api/crew/messages')
      .then(setMsgs)
      .catch(e => setError(e.detail || e.message || 'Could not load'))
  }, [])
  useEffect(() => { load() }, [load])

  const send = async (text) => {
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
      empty="No messages yet — say hi, ask about a schedule, report a problem."
      error={error}
      onSend={send}
      maxLength={2000}
      placeholder="Message the office…"
    />
  )
}

export default CrewThread
