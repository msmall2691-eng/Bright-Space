// Soft two-note chime synthesized via Web Audio API. No asset, no dependency.
// Lazily creates the AudioContext on first call so we don't grab audio rights
// before the user has actually interacted with the page.

let ctx = null

function ensureCtx() {
  if (ctx) return ctx
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

function blip(when, freq, durationS = 0.18, gainPeak = 0.08) {
  const c = ensureCtx()
  if (!c) return
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  // Attack-decay envelope: short attack, exponential decay — feels soft, not harsh.
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(gainPeak, when + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + durationS)
  osc.connect(gain).connect(c.destination)
  osc.start(when)
  osc.stop(when + durationS + 0.02)
}

export function playChime() {
  const c = ensureCtx()
  if (!c) return
  // Resume in case the AudioContext was suspended by browser autoplay policy.
  if (c.state === 'suspended') c.resume().catch(() => {})
  const t = c.currentTime
  blip(t,         880)  // A5
  blip(t + 0.14, 1318)  // E6 — soft major-third-ish lift
}
