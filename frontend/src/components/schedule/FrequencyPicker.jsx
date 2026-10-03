/**
 * The one "how often does this repeat" picker, shared by the New-Job modal
 * (components/JobCreateModal) and the Edit-recurring-rule modal (pages/Recurring)
 * so the two can't drift again.
 *
 * They had drifted: the edit screen was missing "Daily" entirely and modelled
 * cadence purely off interval_weeks, while create used a frequency string with
 * its own option list. The visible symptoms the owner hit — a different set of
 * choices in each place, "daily" available in one and not the other — and a
 * quieter bug underneath: editing a daily series showed "Weekly" selected and
 * saving silently converted it to weekly.
 *
 * The STORED SHAPE is unchanged, so this is a UI unification, not a data-model
 * change: `frequency` ∈ daily | weekly | biweekly | monthly (plus the
 * every_N_weeks labels), with `interval_weeks` the real cadence driver for
 * week-based rules (1 weekly, 2 biweekly, 3/4/8 custom — what the generator
 * actually steps by) and `day_of_month` for monthly. Which button is lit is
 * derived from BOTH fields, so a legacy rule stored as weekly + interval_weeks=3
 * still reads back as "Every 3 weeks".
 */

export const FREQUENCIES = [
  { value: 'daily',          label: 'Daily',         interval: 1 },
  { value: 'weekly',         label: 'Weekly',        interval: 1 },
  { value: 'biweekly',       label: 'Every 2 weeks', interval: 2 },
  { value: 'every_3_weeks',  label: 'Every 3 weeks', interval: 3 },
  { value: 'every_4_weeks',  label: 'Every 4 weeks', interval: 4 },
  { value: 'every_8_weeks',  label: 'Every 8 weeks', interval: 8 },
  { value: 'monthly',        label: 'Monthly',       interval: null },
]

/**
 * Which option a saved rule corresponds to. Monthly and daily key off the
 * frequency string; every other value is a week-based stride, so it keys off
 * interval_weeks — that is what the backend generator steps by, and it is why a
 * rule stored as weekly + interval_weeks=3 lights up "Every 3 weeks" rather than
 * "Weekly". Falls back to weekly for an interval the option list doesn't name.
 */
export function activeFrequency({ frequency, interval_weeks } = {}) {
  if (frequency === 'monthly') return 'monthly'
  if (frequency === 'daily') return 'daily'
  const n = Number(interval_weeks) || 1
  const weekBased = FREQUENCIES.find(
    o => o.value !== 'monthly' && o.value !== 'daily' && o.interval === n)
  return weekBased ? weekBased.value : 'weekly'
}

/**
 * The form patch for picking an option. Sets frequency + interval_weeks
 * together (so the two never disagree), clears days for daily (blank = every
 * day) and seeds/keeps a weekday otherwise. Monthly carries interval_weeks
 * through unchanged — the backend ignores it there and uses day_of_month.
 */
export function pickFrequency(opt, prev = {}) {
  return {
    frequency: opt.value,
    interval_weeks: opt.interval ?? prev.interval_weeks,
    days_of_week: opt.value === 'daily'
      ? []
      : ((prev.days_of_week || []).length ? prev.days_of_week : [0]),
  }
}

/**
 * `value` is the form object (reads frequency / interval_weeks / days_of_week);
 * `onChange` receives a patch to merge into it.
 */
export default function FrequencyPicker({ value, onChange }) {
  const active = activeFrequency(value)
  return (
    <div>
      <label className="block text-xs text-ink-2 font-medium mb-1">Frequency</label>
      <div className="grid grid-cols-2 gap-2">
        {FREQUENCIES.map(opt => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active === opt.value}
            onClick={() => onChange(pickFrequency(opt, value))}
            className={`py-2 rounded-lg text-xs font-medium transition-colors border ${
              active === opt.value
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-panel text-ink-2 border-hairline hover:bg-bg'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
