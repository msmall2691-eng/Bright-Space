/**
 * Design-system barrel. Import the shared UI vocabulary from one place:
 *
 *   import { PageHeader, Card, EmptyState, Button, StatCard } from '../components/ui'
 *
 * All primitives are token-aware (bg-panel / text-ink / border-hairline) so
 * they adapt to light / dark / alternate themes. Prefer these over hand-rolled
 * zinc/neutral markup when building or refactoring pages.
 */
export { default as Button } from './Button'
export { default as GlassCard } from './GlassCard'
export { default as StatusBadge } from './StatusBadge'
export { default as PageHeader } from './PageHeader'
export { default as PageHero } from './PageHero'
export { default as PageTitle } from './PageTitle'
export { default as Card } from './Card'
export { default as EmptyState } from './EmptyState'
export { default as ErrorState } from './ErrorState'
export { default as StatCard } from './StatCard'
export { default as AuthImage } from './AuthImage'
export { Skeleton } from './Skeleton'
export { default as Kbd } from './Kbd'
export { default as PeekPanel } from './PeekPanel'
