/**
 * PageHero — the standard interior-page header.
 *
 * A calm, flat header (Twenty-CRM style) that carries the page title + a row
 * of flat "stat pods", matching the Home dashboard so interior pages read as
 * the same product. Fully controlled: pass title/subtitle/icon, an optional
 * `actions` node (rendered under the title), and up to four `pods`
 * ({ label, value, tone?, onClick? }).
 *
 *   <PageHero icon={Receipt} title="Invoices" subtitle="42 total"
 *     actions={<Button/>} pods={[{label:'Paid', value:'$1.2k'}, …]} />
 *
 * (Was a dark glowing gradient band; flattened app-wide.)
 */

// Callers still pass tones tuned for the old dark band (text-emerald-300,
// text-white, text-indigo-200, …). On the flat light surface those wash out,
// so normalize: keep the ones that carry *status* meaning (good / warning /
// danger) remapped to theme-aware ink-legible steps, and calm every purely
// decorative tone (blue / indigo / white) down to plain ink. Identity still
// comes from the pod label, never color alone.
function podTone(tone) {
  if (!tone) return 'text-ink'
  if (tone.includes('emerald') || tone.includes('green')) return 'text-emerald-600 dark:text-emerald-300'
  if (tone.includes('amber') || tone.includes('yellow')) return 'text-amber-600 dark:text-amber-300'
  if (tone.includes('red') || tone.includes('rose')) return 'text-red-600 dark:text-red-300'
  return 'text-ink'
}

function Pod({ label, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick}
      className={`text-left rounded-xl border border-hairline bg-bg px-3.5 py-2.5 ${onClick ? 'hover:border-hairline-2 transition-colors' : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 truncate">{label}</div>
      <div className={`mt-0.5 text-lg sm:text-xl font-bold tabular-nums leading-none truncate ${podTone(tone)}`}>{value}</div>
    </Tag>
  )
}

export default function PageHero({ icon: Icon, title, subtitle, actions, pods = [], className = '', children }) {
  return (
    <>
      <section className={`bb-surface rounded-2xl bg-panel border border-hairline px-5 py-5 sm:px-6 ${className}`}>
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {Icon && (
                <span className="bb-icon-chip grid place-items-center w-11 h-11 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 shrink-0">
                  <Icon className="w-5 h-5" />
                </span>
              )}
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-[26px] font-bold tracking-tight text-ink truncate">{title}</h1>
                {subtitle && <p className="text-[13px] text-ink-3 mt-0.5 truncate">{subtitle}</p>}
              </div>
            </div>
            {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
          </div>

          {pods.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 lg:w-[520px] shrink-0">
              {pods.map((p, i) => <Pod key={i} {...p} />)}
            </div>
          )}
        </div>
      </section>
      {/* Secondary row (tabs / filters) sits just under the header. */}
      {children && <div className="mt-3">{children}</div>}
    </>
  )
}
