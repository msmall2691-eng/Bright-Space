/**
 * The standing rules — what this business does on its own, in one list.
 *
 * These rules all existed before this panel; they were just scattered and, in
 * one case, unreachable. "Text the customer 24 hours before" lived in an env
 * var she couldn't touch from the app. "Chase overdue invoices" sat under a
 * messaging heading, "cover STR turnovers" under a scheduling one. So the
 * question "what does my app do without me?" had no answer anywhere.
 *
 * RENDERED ENTIRELY FROM THE BACKEND CATALOGUE (GET /api/settings/rules —
 * services/standing_rules.py). The wording, the knobs, their bounds and their
 * defaults all come down with the data, so a rule added there appears here
 * with no frontend change and there is exactly one wording of what each rule
 * does. That's the point of the generic renderer, not cleverness for its own
 * sake — two copies of "we text them 24 hours ahead" is how one of them ends
 * up wrong.
 *
 * SAVING: each control saves itself on change (POST returns the refreshed
 * catalogue, which replaces local state) — the same per-field auto-save the
 * job editor uses, so there's no "did I press Save?" There is one exception:
 * a number field saves on blur, not on every keystroke.
 *
 * REQUEST ECONOMY: one GET when the panel becomes active, and one POST per
 * change. No polling.
 *
 * DESIGN (skills/brightbase-design-language): hairline-separated rows, plain
 * ink text, a segmented control for the three-way modes matching the one the
 * STR dial already used. A rule the deployment has switched off gets a plain
 * amber dot and a sentence — not a tinted banner.
 */
import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../../api'

const inputCls = 'w-24 rounded-md border border-hairline bg-bg px-2 py-1 text-sm text-ink outline-none focus:border-hairline-2'

/** Segmented three-way control — the shape the STR auto-assign dial already
 *  used, kept so the rule that moved in here doesn't change under her. */
function Choice({ field, disabled, onPick }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-bg-2 p-0.5 w-fit">
      {field.choices.map(c => (
        <button key={c.value} type="button" disabled={disabled}
          onClick={() => onPick(c.value)}
          aria-pressed={field.value === c.value}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            field.value === c.value ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'}`}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

function NumberField({ field, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(field.value))
  // The catalogue is the source of truth: when a save comes back (or another
  // field's save refreshes the list), follow it rather than keeping a stale
  // local edit on screen.
  useEffect(() => { setDraft(String(field.value)) }, [field.value])

  const commit = async () => {
    const n = parseInt(draft, 10)
    if (!Number.isFinite(n) || n === field.value) { setDraft(String(field.value)); return }
    // The server refuses an out-of-range value rather than clamping it, and a
    // refusal leaves `field.value` unchanged — so nothing would pull the
    // rejected number back off the screen, and the panel would show a lead
    // time that isn't the one in force.
    const ok = await onCommit(n)
    if (!ok) setDraft(String(field.value))
  }
  return (
    <span className="flex items-center gap-2">
      <input type="number" value={draft} disabled={disabled}
        min={field.min} max={field.max}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        aria-label={field.label}
        className={inputCls} />
      {field.unit && <span className="text-xs text-ink-3">{field.unit}</span>}
    </span>
  )
}

function Field({ field, disabled, onSave }) {
  const save = (value) => onSave(field.key, value)
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <p className="text-sm text-ink-2">{field.label}</p>
        {field.help && <p className="mt-0.5 text-xs text-ink-3">{field.help}</p>}
      </div>
      <div className="shrink-0">
        {field.type === 'bool' && (
          <label className="flex cursor-pointer items-center gap-2">
            <span className="sr-only">{field.label}</span>
            <input type="checkbox" checked={!!field.value} disabled={disabled}
              onChange={e => save(e.target.checked)}
              className="h-4 w-4 rounded" />
          </label>
        )}
        {field.type === 'choice' && (
          <Choice field={field} disabled={disabled} onPick={save} />
        )}
        {field.type === 'number' && (
          <NumberField field={field} disabled={disabled} onCommit={save} />
        )}
      </div>
    </div>
  )
}

export default function RulesPanel({ active = true, toast }) {
  const [rules, setRules] = useState(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!active) return
    let ignore = false
    get('/api/settings/rules')
      .then(r => { if (!ignore) setRules(r?.rules || []) })
      .catch(() => { if (!ignore) setError(true) })
    return () => { ignore = true }
  }, [active])

  const save = useCallback(async (key, value) => {
    setSaving(true)
    try {
      const r = await post('/api/settings/rules', { settings: { [key]: value } })
      setRules(r?.rules || [])
      toast?.('Rule saved')
      return true
    } catch (e) {
      // The backend refuses an out-of-range value rather than clamping it, so
      // its message names the actual bounds — pass it through instead of
      // replacing it with "could not save".
      toast?.(e?.message || 'Could not save that rule', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }, [toast])

  if (error) {
    return (
      <div className="border-t border-hairline pt-5">
        <h3 className="font-semibold text-ink">Standing rules</h3>
        <p className="mt-1 text-xs text-ink-3">
          Couldn’t load the rules just now. Nothing has changed — reload to try again.
        </p>
      </div>
    )
  }

  return (
    <div className="border-t border-hairline pt-5">
      <h3 className="font-semibold text-ink">Standing rules</h3>
      <p className="mt-1 text-xs text-ink-3">
        What BrightBase does on its own, without you. Anything that reaches a
        customer or changes the schedule can be set to ask you first.
      </p>

      {rules === null ? (
        <div className="mt-4 space-y-3" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-2" />)}
        </div>
      ) : (
        <div className="mt-2 divide-y divide-hairline">
          {rules.map(rule => (
            <div key={rule.key} className="py-4" data-testid={`rule-${rule.key}`}>
              <p className="text-sm font-medium text-ink">{rule.title}</p>
              <p className="mt-0.5 text-xs text-ink-3">{rule.summary}</p>
              {rule.blocked && (
                /* Dot + sentence, not a tinted warning bar. Her setting is
                   still hers; it just isn't running right now. */
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                  <span>{rule.blocked_reason}</span>
                </p>
              )}
              {rule.fields.map(f => (
                <Field key={f.key} field={f} disabled={saving} onSave={save} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
