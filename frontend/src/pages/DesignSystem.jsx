import { useEffect, useState } from 'react'
import {
  Calendar, Users, Inbox, AlertTriangle, CheckCircle2, DollarSign,
  Palette, Type, Layers, Sparkles,
} from 'lucide-react'
import {
  Button, GlassCard, StatusBadge, PageHeader, Card, EmptyState,
  ErrorState, StatCard, Skeleton, useToast,
} from '../components/ui'

/**
 * /design-system — the living style guide.
 *
 * Renders every design token and every components/ui/ primitive in its
 * documented states, sourced directly from index.css / tailwind.config.js
 * and the real component files — not a separate spec that can drift out of
 * sync. When a token or component changes, this page changes with it; when
 * it doesn't, a regression here is visible before it ships to a feature page.
 *
 * Read-only reference. Does not restyle any feature page.
 */

const THEMES = [
  { key: 'paper', label: 'Paper (light)' },
  { key: 'console', label: 'Console (dark)' },
  { key: 'neon', label: 'Neon (dark/glass)' },
]
const DENSITIES = [
  { key: 'default', label: 'Default' },
  { key: 'clean', label: 'Clean' },
]

function ThemeSwitcher() {
  const [theme, setTheme] = useState('paper')
  const [density, setDensity] = useState('default')

  useEffect(() => {
    // index.css's dark/clean/neon overrides are keyed off `body.theme-console`
    // / `body.mode-clean` / `body.theme-neon` (not the <html> element), so
    // toggle the class there. Neon is its own skin, not a mode-clean variant,
    // so it's mutually exclusive with console/clean (matches theme.js).
    const body = document.body
    body.classList.toggle('theme-neon', theme === 'neon')
    body.classList.toggle('theme-console', theme === 'console')
    body.classList.toggle('mode-clean', theme !== 'neon' && density === 'clean')
    // Restore whatever the rest of the app was using when we navigate away.
    return () => {
      const saved = localStorage.getItem('tweaks-panel-prefs')
      if (!saved) { body.classList.remove('theme-console', 'mode-clean', 'theme-neon'); return }
      try {
        const prefs = JSON.parse(saved)
        body.classList.toggle('theme-neon', prefs.theme === 'neon')
        body.classList.toggle('theme-console', prefs.theme === 'console')
        body.classList.toggle('mode-clean', prefs.theme !== 'neon' && prefs.density === 'clean')
      } catch {
        body.classList.remove('theme-console', 'mode-clean', 'theme-neon')
      }
    }
  }, [theme, density])

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Theme</span>
        <div className="flex gap-1 bg-bg-2 rounded-lg p-1">
          {THEMES.map(t => (
            <button
              key={t.key}
              onClick={() => setTheme(t.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                theme === t.key ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Density</span>
        <div className="flex gap-1 bg-bg-2 rounded-lg p-1">
          {DENSITIES.map(d => (
            <button
              key={d.key}
              onClick={() => setDensity(d.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                density === d.key ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-ink-3">
        Previews only — doesn't change your saved app preference (Dev Tweaks panel).
      </p>
    </div>
  )
}

function Section({ icon: Icon, title, description, children }) {
  return (
    <section className="mb-12">
      <div className="flex items-start gap-2.5 mb-4">
        {Icon && <Icon className="w-5 h-5 text-ink-3 mt-0.5 shrink-0" />}
        <div>
          <h2 className="text-lg font-bold text-ink tracking-tight">{title}</h2>
          {description && <p className="text-sm text-ink-3 mt-0.5">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function SubLabel({ children }) {
  return (
    <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wide mb-2">
      {children}
    </div>
  )
}

function Swatch({ name, cssVar, textOn }) {
  return (
    <div className="flex flex-col">
      <div
        className={`h-16 rounded-lg border border-hairline flex items-end p-2 ${textOn || 'text-ink'}`}
        style={{ background: `var(${cssVar})` }}
      >
        <code className="text-[10px] bg-black/10 px-1 rounded">{cssVar}</code>
      </div>
      <div className="text-xs font-medium text-ink mt-1.5">{name}</div>
    </div>
  )
}

function SemanticSwatch({ name, fg, bg }) {
  return (
    <div className="flex flex-col">
      <div
        className="h-16 rounded-lg border border-hairline flex items-center justify-center bg-panel"
        style={bg ? { background: `var(${bg})` } : undefined}
      >
        <span className="text-sm font-semibold" style={{ color: `var(${fg})` }}>Aa</span>
      </div>
      <div className="text-xs font-medium text-ink mt-1.5">{name}</div>
      <code className="text-[10px] text-ink-3">{fg}</code>
    </div>
  )
}

const RADII = [
  { name: 'xs', cls: 'rounded-xs' }, { name: 'sm', cls: 'rounded-sm' },
  { name: 'md', cls: 'rounded-md' }, { name: 'lg', cls: 'rounded-lg' },
  { name: 'xl', cls: 'rounded-xl' }, { name: '2xl', cls: 'rounded-2xl' },
]
const TYPE_SCALE = [
  { name: 'xs — 11px', cls: 'text-xs' }, { name: 'sm — 12px', cls: 'text-sm' },
  { name: 'base — 14px', cls: 'text-base' }, { name: 'lg — 16px', cls: 'text-lg' },
  { name: 'xl — 18px', cls: 'text-xl' }, { name: '2xl — 24px', cls: 'text-2xl' },
  { name: '3xl — 32px', cls: 'text-3xl' },
]
const STATUSES = ['success', 'warning', 'danger', 'info', 'neutral']

export default function DesignSystem() {
  const { toast, ToastContainer } = useToast()
  const [showSkeleton, setShowSkeleton] = useState(true)

  return (
    <div className="max-w-5xl mx-auto pb-24">
      <PageHeader
        title="Design System"
        subtitle="Live tokens and components/ui/ primitives — sourced from the running app, not a spec doc."
        icon={Sparkles}
      />

      <div className="px-4 sm:px-8">
        <div className="mb-10 p-4 rounded-xl bg-bg-2 border border-hairline">
          <ThemeSwitcher />
        </div>

        <Section icon={Palette} title="Color"
          description="CSS custom properties in index.css. Every component below reads these — nothing here is a hard-coded hex.">
          <SubLabel>Surfaces &amp; ink</SubLabel>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-6">
            <Swatch name="Background" cssVar="--bg" />
            <Swatch name="Background 2" cssVar="--bg-2" />
            <Swatch name="Background 3" cssVar="--bg-3" />
            <Swatch name="Panel" cssVar="--panel" />
            <Swatch name="Hairline" cssVar="--hairline" />
          </div>
          <SubLabel>Text</SubLabel>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-6">
            <div className="flex flex-col">
              <div className="h-16 rounded-lg border border-hairline flex items-center justify-center bg-panel">
                <span className="text-ink text-sm font-semibold">Primary</span>
              </div>
              <div className="text-xs font-medium text-ink mt-1.5">ink</div>
              <code className="text-[10px] text-ink-3">--ink</code>
            </div>
            <div className="flex flex-col">
              <div className="h-16 rounded-lg border border-hairline flex items-center justify-center bg-panel">
                <span className="text-ink-2 text-sm font-semibold">Secondary</span>
              </div>
              <div className="text-xs font-medium text-ink mt-1.5">ink-2</div>
              <code className="text-[10px] text-ink-3">--ink-2</code>
            </div>
            <div className="flex flex-col">
              <div className="h-16 rounded-lg border border-hairline flex items-center justify-center bg-panel">
                <span className="text-ink-3 text-sm font-semibold">Tertiary</span>
              </div>
              <div className="text-xs font-medium text-ink mt-1.5">ink-3</div>
              <code className="text-[10px] text-ink-3">--ink-3</code>
            </div>
          </div>
          <SubLabel>Accent (single electric accent — primary actions &amp; focus)</SubLabel>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-6">
            <Swatch name="Accent" cssVar="--accent" textOn="text-accent-ink" />
          </div>
          <SubLabel>Semantic — property type &amp; status</SubLabel>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            <SemanticSwatch name="Residential" fg="--c-residential" bg="--c-residential-bg" />
            <SemanticSwatch name="Commercial" fg="--c-commercial" bg="--c-commercial-bg" />
            <SemanticSwatch name="STR" fg="--c-str" bg="--c-str-bg" />
            <SemanticSwatch name="Alert" fg="--c-alert" bg="--c-alert-bg" />
            <SemanticSwatch name="OK" fg="--c-ok" />
          </div>
        </Section>

        <Section icon={Type} title="Typography"
          description="Inter for UI text, JetBrains Mono for numbers/IDs. Scale defined in tailwind.config.js.">
          <div className="space-y-3 mb-6">
            {TYPE_SCALE.map(t => (
              <div key={t.name} className="flex items-baseline gap-4">
                <code className="text-[11px] text-ink-3 w-24 shrink-0">{t.name}</code>
                <span className={`${t.cls} text-ink font-semibold`}>The quick brown fox</span>
              </div>
            ))}
          </div>
          <SubLabel>Monospace (JetBrains Mono) — numbers &amp; IDs</SubLabel>
          <div className="flex items-center gap-4 mb-2">
            <span className="font-mono text-lg text-ink tabular-nums">$1,353.00</span>
            <span className="font-mono text-sm text-ink-3">#INV-00412</span>
            <span className="font-mono text-sm text-ink-3">2026-07-09</span>
          </div>
        </Section>

        <Section icon={Layers} title="Radius, shadow &amp; motion"
          description="4px base grid. Two glass elevation levels. 150ms ease-out is the standard transition.">
          <SubLabel>Border radius</SubLabel>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
            {RADII.map(r => (
              <div key={r.name} className="flex flex-col items-center">
                <div className={`w-14 h-14 bg-accent ${r.cls}`} />
                <code className="text-[10px] text-ink-3 mt-1.5">{r.name}</code>
              </div>
            ))}
          </div>
          <SubLabel>Elevation</SubLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
            <div className="h-16 rounded-lg bg-panel flex items-center justify-center text-xs text-ink-3" style={{ boxShadow: 'var(--shadow-1)' }}>
              shadow-1
            </div>
            <div className="h-16 rounded-lg bg-panel flex items-center justify-center text-xs text-ink-3" style={{ boxShadow: 'var(--shadow-2)' }}>
              shadow-2
            </div>
            <div className="h-16 rounded-lg bg-panel flex items-center justify-center text-xs text-ink-3 shadow-glass">
              shadow-glass
            </div>
          </div>
          <SubLabel>Motion — hover a swatch</SubLabel>
          <div className="w-32 h-12 rounded-lg bg-bg-2 border border-hairline flex items-center justify-center text-xs text-ink-3 transition-all duration-150 ease-out hover:bg-accent hover:text-accent-ink cursor-default">
            150ms ease-out
          </div>
        </Section>

        <Section title="Button" description="components/ui/Button.jsx — 5 variants × 3 sizes, disabled state.">
          <div className="space-y-4">
            {['primary', 'secondary', 'tertiary', 'danger', 'glass'].map(variant => (
              <div key={variant} className={variant === 'glass' ? 'flex items-center gap-3 flex-wrap p-3 rounded-lg bg-gradient-hero' : 'flex items-center gap-3 flex-wrap'}>
                <code className="text-[11px] text-ink-3 w-20 shrink-0">{variant}</code>
                <Button variant={variant} size="sm">Small</Button>
                <Button variant={variant} size="md">Medium</Button>
                <Button variant={variant} size="lg">Large</Button>
                <Button variant={variant} size="md" disabled>Disabled</Button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="StatusBadge" description="components/ui/StatusBadge.jsx — 5 statuses × filled/outline.">
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <code className="text-[11px] text-ink-3 w-16 shrink-0">filled</code>
              {STATUSES.map(s => (
                <StatusBadge key={s} status={s} variant="filled">{s}</StatusBadge>
              ))}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <code className="text-[11px] text-ink-3 w-16 shrink-0">outline</code>
              {STATUSES.map(s => (
                <StatusBadge key={s} status={s} variant="outline">{s}</StatusBadge>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Card" description="components/ui/Card.jsx — the standard token-aware surface, replacing hand-rolled bg-panel/border-hairline blocks.">
          <div className="grid sm:grid-cols-2 gap-4">
            <Card title="Today" icon={Calendar} badge={<StatusBadge status="info" variant="filled">3</StatusBadge>}>
              <p className="text-sm text-ink-2">Plain body content with a header, icon and badge.</p>
            </Card>
            <Card title="Revenue" icon={DollarSign} action={<Button size="sm" variant="secondary">View</Button>}>
              <p className="text-sm text-ink-2">Header with a right-aligned action.</p>
            </Card>
          </div>
        </Section>

        <Section title="GlassCard" description="components/ui/GlassCard.jsx — the older frosted-glass surface (prefer Card for new work; kept for the dashboard's hero tiles).">
          <GlassCard title="Pipeline" subtitle="This month">
            <p className="text-sm text-ink-2">Backdrop-blur surface with hairline border.</p>
          </GlassCard>
        </Section>

        <Section title="StatCard" description="components/ui/StatCard.jsx — a single metric cell; group several for a metrics strip.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-hairline rounded-2xl overflow-hidden border border-hairline">
            <div className="bg-panel"><StatCard label="Pipeline" value="$1,353" icon={DollarSign} /></div>
            <div className="bg-panel"><StatCard label="Today" value="1 job" icon={Calendar} accent="text-accent" /></div>
            <div className="bg-panel"><StatCard label="Overdue" value="2" icon={AlertTriangle} accent="text-red-600" onClick={() => {}} /></div>
            <div className="bg-panel"><StatCard label="Closed" value="9" sub="this month" icon={CheckCircle2} accent="text-emerald-600" /></div>
          </div>
        </Section>

        <Section title="EmptyState &amp; ErrorState" description="Every loading state needs both an empty and an error resolution — never an infinite spinner.">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="rounded-xl border border-hairline bg-panel">
              <EmptyState icon={Inbox} title="Inbox zero" description="Nothing needs your attention." compact />
            </div>
            <div className="rounded-xl border border-hairline bg-panel">
              <ErrorState title="Couldn't load the schedule" onRetry={() => toast.info('Retry clicked')} compact />
            </div>
          </div>
        </Section>

        <Section title="Skeleton" description="components/ui/Skeleton.jsx — token-aware loading placeholder. Toggle to compare against loaded content.">
          <Button size="sm" variant="secondary" className="mb-3" onClick={() => setShowSkeleton(s => !s)}>
            Toggle {showSkeleton ? 'loaded' : 'skeleton'}
          </Button>
          <div className="rounded-xl border border-hairline bg-panel p-4 space-y-2">
            {showSkeleton ? (
              <>
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">Loaded title</p>
                <p className="text-sm text-ink-2">Loaded body content, same footprint as the skeleton above.</p>
                <p className="text-sm text-ink-2">Third line.</p>
              </>
            )}
          </div>
        </Section>

        <Section title="Toast" description="components/ui/Toast.jsx (useToast) — bottom-center, auto-dismisses; longer if it carries an action.">
          <div className="flex gap-3 flex-wrap">
            <Button size="sm" variant="secondary" onClick={() => toast.success('Saved successfully')}>Trigger success</Button>
            <Button size="sm" variant="secondary" onClick={() => toast.error('Something went wrong')}>Trigger error</Button>
            <Button size="sm" variant="secondary" onClick={() => toast.info('Heads up', { action: { label: 'Undo', onClick: () => {} } })}>
              Trigger with action
            </Button>
          </div>
        </Section>
      </div>

      <ToastContainer />
    </div>
  )
}
