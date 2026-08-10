/**
 * LaunchStepper — run one deal through the pipeline in a single surface.
 *
 * Quote → Send → Accept → Schedule → Dispatch, opening at the deal's current
 * stage (detected in useLaunch). Each step is one deliberate action wrapping
 * an existing endpoint; steps already behind the deal render as done, the
 * current step is actionable, later steps are locked until their turn. The
 * money/scheduling moves are deterministic buttons — no AI in the firing path
 * (AI, when added, drafts the content a human reviews before the tap).
 *
 * Twenty idiom: flat panel, hairline rail, calm ink, one indigo accent; the
 * active step gets the color, the rest stay quiet.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Check, Send, CheckCircle2, CalendarDays, Rocket, ArrowRight, Lock } from 'lucide-react'
import { useLaunch, LAUNCH_STEPS } from '../../hooks/useLaunch'

const STEP_META = {
  quote:    { label: 'Quote',    icon: Rocket,       blurb: 'Draft the price for this deal.' },
  send:     { label: 'Send',     icon: Send,         blurb: 'Email the quote to the customer.' },
  accept:   { label: 'Accept',   icon: CheckCircle2, blurb: 'Mark the quote accepted (creates the job).' },
  schedule: { label: 'Schedule', icon: CalendarDays, blurb: 'Put the job on the calendar.' },
  dispatch: { label: 'Dispatch', icon: Rocket,       blurb: 'Send the assigned crew their shift.' },
}

function Rail({ steps, currentStep }) {
  return (
    <ol className="flex sm:flex-col gap-1 sm:gap-0 overflow-x-auto">
      {steps.map((s, i) => {
        const meta = STEP_META[s.key]
        const active = s.key === currentStep
        const Icon = s.done ? Check : meta.icon
        return (
          <li key={s.key} className="flex items-center sm:items-stretch gap-2.5 sm:gap-3 shrink-0">
            <div className="flex flex-col items-center">
              <span className={`grid place-items-center w-7 h-7 rounded-full border text-[12px] font-semibold shrink-0 ${
                s.done ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-300'
                : active ? 'bg-indigo-600 border-indigo-600 text-white'
                : 'bg-bg-2 border-hairline text-ink-3'}`}>
                <Icon className="w-3.5 h-3.5" />
              </span>
              {i < steps.length - 1 && <span className="hidden sm:block w-px flex-1 min-h-[14px] bg-hairline my-0.5" />}
            </div>
            <span className={`text-[12px] font-medium pt-1 sm:pt-0.5 ${active ? 'text-ink' : s.done ? 'text-ink-2' : 'text-ink-3'}`}>
              {meta.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Inline inputs for the Schedule step — optional; leaving them blank creates
 *  the job unscheduled (the operator can date it later on the board). */
function ScheduleForm({ busy, onSchedule }) {
  const [date, setDate] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('11:00')
  const submit = () => onSchedule(date ? { scheduled_date: date, start_time: start, end_time: end } : {})
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[11px] text-ink-3 col-span-3 -mb-1">Date &amp; time (optional)</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="col-span-3 sm:col-span-1 bg-bg-2 border border-hairline rounded-lg px-2 py-1.5 text-[13px] text-ink focus:outline-none focus:border-indigo-400" />
        <input type="time" value={start} onChange={e => setStart(e.target.value)} disabled={!date}
          className="bg-bg-2 border border-hairline rounded-lg px-2 py-1.5 text-[13px] text-ink disabled:opacity-50 focus:outline-none focus:border-indigo-400" />
        <input type="time" value={end} onChange={e => setEnd(e.target.value)} disabled={!date}
          className="bg-bg-2 border border-hairline rounded-lg px-2 py-1.5 text-[13px] text-ink disabled:opacity-50 focus:outline-none focus:border-indigo-400" />
      </div>
      <button onClick={submit} disabled={busy}
        className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white">
        <CalendarDays className="w-4 h-4" /> {busy ? 'Scheduling…' : (date ? 'Schedule job' : 'Create job (unscheduled)')}
      </button>
    </div>
  )
}

export default function LaunchStepper({ opportunityId, title, onClose }) {
  const L = useLaunch(opportunityId)
  const navigate = useNavigate()
  const { steps, currentStep, primaryQuote, primaryJob, busy, loading, error } = L

  // Close automatically once the whole pipeline is done (dispatch complete).
  useEffect(() => {
    if (steps.length && steps.every(s => s.done)) { /* stay open on the done state */ }
  }, [steps])

  const meta = STEP_META[currentStep]
  const allDone = steps.length > 0 && steps.every(s => s.done)

  const primaryAction = () => {
    switch (currentStep) {
      case 'quote':
        // Quote needs line items — hand off to the quote editor rather than
        // create an empty ($0, unsendable) quote.
        return { label: 'Open quote editor', onClick: () => { onClose?.(); navigate('/billing?view=quotes') } }
      case 'send':
        return { label: busy ? 'Sending…' : 'Send quote', icon: Send, onClick: L.sendQuote, disabled: !primaryQuote }
      case 'accept':
        return { label: busy ? 'Accepting…' : 'Mark accepted', icon: CheckCircle2, onClick: L.acceptQuote, disabled: !primaryQuote }
      case 'dispatch':
        return {
          label: busy ? 'Sending…' : 'Send to crew', icon: Rocket, onClick: L.dispatchJob,
          disabled: !primaryJob || !(primaryJob.cleaner_ids?.length),
          hint: primaryJob && !(primaryJob.cleaner_ids?.length) ? 'Assign a crew to this job first.' : null,
        }
      default:
        return null
    }
  }
  const action = primaryAction()

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div className="w-full sm:max-w-lg bg-panel rounded-t-2xl sm:rounded-2xl border border-hairline shadow-glass-lg max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-hairline">
          <div className="flex items-center gap-2 min-w-0">
            <span className="grid place-items-center w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 shrink-0"><Rocket className="w-4 h-4" /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink truncate">Launch{title ? ` · ${title}` : ''}</h2>
              <p className="text-[11px] text-ink-3">Run this deal through to dispatch</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-2 text-ink-3"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-ink-3 text-sm">Loading deal…</div>
        ) : error ? (
          <div className="p-8 text-center text-red-600 dark:text-red-300 text-sm">{error}</div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 grid sm:grid-cols-[130px_1fr] gap-5">
            <Rail steps={steps} currentStep={currentStep} />

            <div className="min-w-0">
              {allDone ? (
                <div className="text-center py-6">
                  <span className="grid place-items-center w-12 h-12 rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 mx-auto mb-3"><Check className="w-6 h-6" /></span>
                  <p className="text-sm font-semibold text-ink">Launched</p>
                  <p className="text-[12px] text-ink-3 mt-0.5">This deal is scheduled and the crew has been notified.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <meta.icon className="w-4 h-4 text-indigo-600 dark:text-indigo-300" />
                    <h3 className="text-sm font-semibold text-ink">{meta.label}</h3>
                  </div>
                  <p className="text-[13px] text-ink-2 mb-4">{meta.blurb}</p>

                  {currentStep === 'schedule' ? (
                    <ScheduleForm busy={busy} onSchedule={L.scheduleJob} />
                  ) : action ? (
                    <>
                      <button onClick={action.onClick} disabled={action.disabled || busy}
                        className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white">
                        {action.icon && <action.icon className="w-4 h-4" />} {action.label}
                        {!action.icon && <ArrowRight className="w-4 h-4" />}
                      </button>
                      {action.hint && (
                        <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-300"><Lock className="w-3 h-3" /> {action.hint}</p>
                      )}
                    </>
                  ) : null}

                  {/* Context on what already exists for the deal. */}
                  {primaryQuote && (
                    <p className="mt-4 text-[11px] text-ink-3">Quote {primaryQuote.quote_number || `#${primaryQuote.id}`} · <span className="capitalize">{primaryQuote.status}</span></p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
