/**
 * PageHero — the cockpit-style page header.
 *
 * A dark, glowing gradient band that carries the page title + a row of
 * glass "stat pods", echoing the Home command-cockpit so interior pages
 * read as the same product. Fully controlled: pass title/subtitle/icon,
 * an optional `actions` node (rendered under the title), and up to four
 * `pods` ({ label, value, tone?, onClick? }).
 *
 *   <PageHero icon={Receipt} title="Invoices" subtitle="42 total"
 *     actions={<Button/>} pods={[{label:'Paid', value:'$1.2k'}, …]} />
 */
function Pod({ label, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick}
      className={`text-left rounded-2xl bg-white/[0.06] border border-white/10 backdrop-blur px-3.5 py-2.5 ${onClick ? 'hover:bg-white/[0.10] transition-colors' : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-200/70 truncate">{label}</div>
      <div className={`mt-0.5 text-lg sm:text-xl font-bold tabular-nums leading-none truncate ${tone || 'text-white'}`}>{value}</div>
    </Tag>
  )
}

export default function PageHero({ icon: Icon, title, subtitle, actions, pods = [], className = '', children }) {
  return (
    <>
      <section className={`relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 px-5 py-5 sm:px-7 sm:py-6 ${className}`}>
        <span className="pointer-events-none absolute -top-20 -left-12 w-72 h-72 rounded-full bg-indigo-500/25 blur-3xl" />
        <span className="pointer-events-none absolute -bottom-24 right-8 w-80 h-80 rounded-full bg-fuchsia-500/12 blur-3xl" />

        <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {Icon && (
                <span className="grid place-items-center w-11 h-11 rounded-2xl bg-white/10 border border-white/10 text-indigo-100 shrink-0">
                  <Icon className="w-5 h-5" />
                </span>
              )}
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-[26px] font-bold tracking-tight text-white truncate">{title}</h1>
                {subtitle && <p className="text-[13px] text-indigo-200/70 mt-0.5 truncate">{subtitle}</p>}
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
      {/* Secondary row (tabs / filters) sits just under the band on the light
          canvas, so pages that had a tab strip in their old header keep it. */}
      {children && <div className="mt-3">{children}</div>}
    </>
  )
}
