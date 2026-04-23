/**
 * Component Token Patterns
 * Reusable Tailwind class combinations for consistent styling
 */

export const cards = {
  // Glass effect card
  glass: 'bg-white/70 backdrop-blur-lg border border-white/20 rounded-xl shadow-glass',
  glassLg: 'bg-white/80 backdrop-blur-xl border border-white/20 rounded-2xl shadow-glassLg',

  // Solid white card
  solid: 'bg-white border border-neutral-200/60 rounded-xl shadow-sm',
  solidLg: 'bg-white border border-neutral-200/60 rounded-2xl shadow-md',

  // Subtle gradient card
  subtle: 'bg-gradient-to-br from-blue-50/50 to-violet-50/30 border border-neutral-200/40 rounded-xl shadow-xs',

  // Interactive hover
  interactive: 'transition-all duration-200 hover:shadow-md hover:border-neutral-300/60',
};

export const buttons = {
  // Base styles
  base: 'font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',

  // Primary button
  primary: 'bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg focus:ring-blue-500',
  primaryLg: 'px-6 py-2.5 text-base font-semibold',
  primaryMd: 'px-4 py-2 text-sm font-medium',
  primarySm: 'px-3 py-1.5 text-xs font-medium',

  // Secondary button
  secondary: 'bg-neutral-200 hover:bg-neutral-300 text-neutral-900 focus:ring-neutral-500',
  secondaryLg: 'px-6 py-2.5 text-base font-semibold',
  secondaryMd: 'px-4 py-2 text-sm font-medium',
  secondarySm: 'px-3 py-1.5 text-xs font-medium',

  // Tertiary (text button)
  tertiary: 'text-blue-600 hover:text-blue-700 hover:bg-blue-50 focus:ring-blue-500',
  tertiaryLg: 'px-6 py-2.5 text-base font-semibold',
  tertiaryMd: 'px-4 py-2 text-sm font-medium',
  tertiarySm: 'px-3 py-1.5 text-xs font-medium',

  // Danger button
  danger: 'bg-red-600 hover:bg-red-700 text-white shadow-md hover:shadow-lg focus:ring-red-500',
  dangerLg: 'px-6 py-2.5 text-base font-semibold',
  dangerMd: 'px-4 py-2 text-sm font-medium',
  dangerSm: 'px-3 py-1.5 text-xs font-medium',

  // Glass button
  glass: 'bg-white/30 backdrop-blur-sm border border-white/50 text-neutral-900 hover:bg-white/40 focus:ring-blue-500',
  glassLg: 'px-6 py-2.5 text-base font-semibold',
  glassMd: 'px-4 py-2 text-sm font-medium',
  glassSm: 'px-3 py-1.5 text-xs font-medium',
};

export const inputs = {
  base: 'w-full px-3 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors duration-200',
  error: 'border-red-500 focus:ring-red-500',
  success: 'border-green-500 focus:ring-green-500',
  disabled: 'bg-neutral-100 text-neutral-500 cursor-not-allowed',
};

export const badges = {
  // Status badges
  statusSuccess: 'inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-semibold',
  statusWarning: 'inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold',
  statusDanger: 'inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-xs font-semibold',
  statusInfo: 'inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold',
  statusNeutral: 'inline-flex items-center gap-1.5 px-2.5 py-1 bg-neutral-200 text-neutral-700 rounded-full text-xs font-semibold',

  // Outlined variants
  outlineSuccess: 'inline-flex items-center gap-1.5 px-2.5 py-1 border border-green-200 text-green-700 rounded-full text-xs font-semibold',
  outlineWarning: 'inline-flex items-center gap-1.5 px-2.5 py-1 border border-amber-200 text-amber-700 rounded-full text-xs font-semibold',
  outlineDanger: 'inline-flex items-center gap-1.5 px-2.5 py-1 border border-red-200 text-red-700 rounded-full text-xs font-semibold',
};

export const sections = {
  // Page content container
  container: 'px-6 py-8 lg:px-8',

  // Card section
  cardSection: 'rounded-xl border border-neutral-200/60 bg-white shadow-sm overflow-hidden',

  // Section header
  sectionHeader: 'px-6 py-4 border-b border-neutral-200/40 bg-neutral-50/50',
  sectionTitle: 'text-lg font-semibold text-neutral-900',
  sectionSubtitle: 'text-sm text-neutral-600 mt-1',

  // Section content
  sectionContent: 'p-6',
};

export const tables = {
  base: 'w-full text-sm',
  header: 'text-xs font-semibold text-neutral-600 uppercase tracking-wide',
  headerCell: 'px-6 py-3 text-left bg-neutral-50/80 border-b border-neutral-200/40',
  bodyRow: 'border-b border-neutral-200/40 hover:bg-blue-50/50 transition-colors duration-150',
  bodyCell: 'px-6 py-3 text-neutral-700',
};

export const modals = {
  overlay: 'fixed inset-0 bg-black/40 backdrop-blur-sm z-40',
  container: 'fixed inset-0 z-50 flex items-center justify-center p-4',
  content: 'bg-white rounded-2xl shadow-xl max-w-md w-full border border-white/20',
  header: 'px-6 py-4 border-b border-neutral-200/40 bg-white rounded-t-2xl',
  body: 'px-6 py-4',
  footer: 'px-6 py-4 border-t border-neutral-200/40 bg-neutral-50/50 rounded-b-2xl flex gap-3 justify-end',
};

export const typography = {
  // Headings
  h1: 'text-3xl font-bold text-neutral-900 tracking-tight',
  h2: 'text-2xl font-semibold text-neutral-900 tracking-tight',
  h3: 'text-xl font-semibold text-neutral-900',
  h4: 'text-lg font-semibold text-neutral-900',
  h5: 'text-base font-semibold text-neutral-900',

  // Body text
  bodyLarge: 'text-base text-neutral-700 leading-relaxed',
  body: 'text-sm text-neutral-600 leading-relaxed',
  bodySmall: 'text-xs text-neutral-500 leading-relaxed',

  // Semantic text
  muted: 'text-neutral-500 text-sm',
  mutedSmall: 'text-neutral-400 text-xs',
  error: 'text-red-600 text-sm',
  success: 'text-green-600 text-sm',
  label: 'block text-xs font-semibold text-neutral-700 uppercase tracking-wide mb-2',
};

export const spacing = {
  // Common padding/margin utilities
  pageContainer: 'px-4 sm:px-6 lg:px-8 py-8',
  cardContainer: 'p-6',
  sectionGap: 'gap-6',
  itemGap: 'gap-4',
};

export default {
  cards,
  buttons,
  inputs,
  badges,
  sections,
  tables,
  modals,
  typography,
  spacing,
};
