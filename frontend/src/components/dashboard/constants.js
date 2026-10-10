/** Flat card surface — Twenty-CRM style. A near-white panel on a hairline
 *  border with only a whisper of shadow, no indigo glow or luminous top
 *  edge. Calm and record-forward: the content is the focus, not the chrome.
 *  (Was the glowing `bb-surface` treatment; flattened for the Twenty look.) */
export const SOFT_CARD =
  'bg-panel rounded-xl border border-hairline shadow-glass-sm'

// A `TONE` map of tinted row/callout backgrounds (`bg-amber-50
// border-amber-200` and three more) used to sit here. Nothing imported it —
// not before the orphaned dashboard tiles were deleted either; they used
// SOFT_CARD. `utils/statusTone.js` has its own private TONE, unrelated.
//
// Worth a note rather than a silent delete, because a resting tinted fill is
// the pattern the owner has vetoed three times (brightbase-design-language,
// "Solid tinted banners"). It survived review only by being unreachable, and
// an exported map named TONE is exactly what someone reaches for in good faith.
// Attention is a hairline card with an amber dot — see schedule/OpsAlerts.jsx.
