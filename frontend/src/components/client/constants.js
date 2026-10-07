/**
 * Shared constants for ClientProfile and its extracted sub-components.
 *
 * These were originally declared at the top and bottom of ClientProfile.jsx.
 * None capture any state — they're pure module-level values — so hoisting
 * them out lets each sub-component import cleanly instead of the parent
 * threading them through every prop.
 */

// Status renders are dot + word (owner's veto of tinted pill bubbles):
// DOT_CHIP is the quiet bordered body, the *_COLORS maps now hold the
// little dot's color class. Same export names as before so consumers only
// changed their render markup, not their imports.
import { STATUS_DOT } from '../../theme/statusDots'
export const DOT_CHIP = 'inline-flex items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 py-0.5 text-[11px] font-medium capitalize leading-none text-ink-2'
export const DOT = 'w-1.5 h-1.5 rounded-full shrink-0'

export const STATUS_COLORS = {
  lead:     STATUS_DOT.attention,
  active:   STATUS_DOT.ok,
  inactive: 'bg-ink-3',
}

export const JOB_COLORS = {
  scheduled:   STATUS_DOT.info,
  in_progress: STATUS_DOT.attention,
  completed:   STATUS_DOT.ok,
  cancelled:   STATUS_DOT.problem,
}

export const INVOICE_COLORS = {
  draft:   'bg-ink-3',
  sent:    STATUS_DOT.info,
  paid:    STATUS_DOT.ok,
  overdue: STATUS_DOT.problem,
}

// NOT migrated to STATUS_DOT, deliberately (BB-A11Y-02). These three are the
// wrong SHAPE for a severity palette, and forcing them into it would lose
// information that the colour is carrying:
//
//   QUOTE_COLORS  seven states with TWO distinct good ends — `accepted` and
//                 `converted` would both become `ok` and stop being
//                 distinguishable. Also already off the design language's
//                 vocabulary (teal, and indigo which is the accent).
//   OPP_COLORS    a pipeline: new -> qualified -> quoted -> won/lost. Ordered,
//                 not good-or-bad, and `purple` is off-vocabulary too.
//   PROPERTY_TYPE residential / commercial / str is IDENTITY, not severity.
//
// They are real contrast failures, not non-issues, and they need a measured
// ordinal/categorical ramp — a design decision about how these screens read.
// `__tests__/statusDotMigration.test.js` holds the exact count so no NEW raw
// step can hide among them.
export const QUOTE_COLORS = {
  draft:    'bg-ink-3',
  sent:     'bg-blue-500',
  viewed:   'bg-indigo-500',
  changes_requested: 'bg-amber-500',
  accepted: 'bg-green-500',
  converted: 'bg-teal-500',
  declined: 'bg-red-500',
}

export const OPP_COLORS = {
  new: 'bg-amber-500',
  qualified: 'bg-blue-500',
  quoted: 'bg-purple-500',
  won: 'bg-green-500',
  lost: 'bg-red-500',
}

export const PROPERTY_TYPE_COLORS = {
  residential: 'bg-blue-500',
  commercial:  'bg-emerald-500',
  str:         'bg-orange-500',
}

export const PROPERTY_TYPE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str: 'STR'
}

export const INPUT_CLASS = 'w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-hidden'

/* ─── ClientCalendarTab-adjacent constants ─── */

export const MINI_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
export const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

// Job-type label + dot now come from the one canonical service vocabulary
// (src/utils/services.js) so every screen agrees and "deep_clean" has a label.
export { JOB_TYPE_DOT, JOB_TYPE_LABEL } from '../../utils/services'

// Same dot-not-tint rule for the calendar tab's status chips.
export const STATUS_PILL = {
  scheduled:   STATUS_DOT.info,
  in_progress: STATUS_DOT.attention,
  completed:   STATUS_DOT.ok,
  cancelled:   'bg-ink-3',
}

export const EMPTY_ICAL = {
  url: '', source: '', checkout_time: '', duration_hours: '',
  house_code: '', instructions: '',
}
