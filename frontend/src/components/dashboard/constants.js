/** Soft, airy card surface shared by the facelifted dashboard (white +
 *  blue, rounded, gentle shadow — the look from the reference dashboard). */
export const SOFT_CARD =
  'bg-panel rounded-2xl border border-hairline shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-16px_rgba(15,23,42,0.12)]'

/** Map the existing iconColor tokens (passed by tile call sites) to a
 *  tinted chip so the icons read as colored badges without touching any
 *  call site. */
export const CHIP = {
  'text-blue-500':    'bg-blue-50 text-blue-600',
  'text-violet-500':  'bg-violet-50 text-violet-600',
  'text-purple-500':  'bg-purple-50 text-purple-600',
  'text-amber-500':   'bg-amber-50 text-amber-600',
  'text-emerald-500': 'bg-emerald-50 text-emerald-600',
}
