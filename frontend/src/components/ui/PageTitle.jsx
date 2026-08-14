/**
 * PageTitle — THE page header. One compact pattern (Notion/Attio/Twenty
 * family) replacing the three that grew over time: `PageHeader` (flat row),
 * `PageHero` (stat-pod card), and hand-rolled <header> blocks. Both old
 * primitives now render through this, so existing call sites keep working.
 *
 *   <PageTitle icon={Users} title="Clients" subtitle="128 active"
 *     actions={<Button>New client</Button>}
 *     stats={[{ label: 'Paid', value: '$12.4k', tone: 'good', onClick }]}
 *   >…tabs strip…</PageTitle>
 *
 * Structure:
 *   [icon glyph] Title            [actions]
 *   subtitle (optional, quiet)
 *   stats line (optional): Label **value** · Label **value**
 *   children (optional): tabs / filter strip
 *
 * Deliberate changes from the old headers:
 *  - The icon is a flat 18px glyph in ink-3 — no tinted chip. Color belongs
 *    to data, not chrome.
 *  - Stats are an inline text line, not pod boxes: quiet labels with bold
 *    tabular values, separated by dots. Status tones (good/warn/bad) keep
 *    their color; everything else is ink.
 */

// Tone → value color. Accepts both the new short names and the legacy
// Tailwind-ish tone strings PageHero callers still pass (text-emerald-300 …).
function toneClass(tone) {
  if (!tone) return 'text-ink'
  if (tone === 'good' || tone.includes('emerald') || tone.includes('green'))
    return 'text-emerald-600 dark:text-emerald-300'
  if (tone === 'warn' || tone.includes('amber') || tone.includes('yellow'))
    return 'text-amber-600 dark:text-amber-300'
  if (tone === 'bad' || tone.includes('red') || tone.includes('rose'))
    return 'text-red-600 dark:text-red-300'
  return 'text-ink'
}

function Stat({ label, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      onClick={onClick}
      className={`inline-flex min-h-0 items-baseline gap-1.5 whitespace-nowrap text-[13px] text-ink-3 ${
        onClick ? '-mx-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-bg-2 hover:text-ink-2' : ''
      }`}
    >
      {label}
      <b className={`font-semibold tabular-nums ${toneClass(tone)}`}>{value}</b>
    </Tag>
  )
}

export default function PageTitle({
  title,
  subtitle,
  icon: Icon,
  actions,
  stats = [],
  className = '',
  children,
}) {
  // No baked-in outer padding: PageHeader call sites expect the header to pad
  // itself (its wrapper adds the classes), PageHero call sites sit inside
  // already-padded containers. Pass padding via className when using directly.
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-ink-3" />}
          <h1 className="truncate text-lg font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && (
            <span className="hidden truncate text-[13px] text-ink-3 sm:inline">{subtitle}</span>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {subtitle && <p className="mt-0.5 text-xs text-ink-3 sm:hidden">{subtitle}</p>}
      {stats.length > 0 && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {stats.map((s, i) => (
            <span key={i} className="flex items-baseline gap-x-2">
              {i > 0 && <span className="text-ink-3/50" aria-hidden>·</span>}
              <Stat {...s} />
            </span>
          ))}
        </div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}
