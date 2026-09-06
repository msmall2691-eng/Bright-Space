import { useState, useEffect } from 'react'
import { subscribe, resolveConfirm } from '../../utils/confirmBus'
import Button from './Button'

// Renders confirmation requests raised via utils/confirmBus's confirmDialog().
// Mounted once at the app root (main.jsx) — the single replacement for every
// window.confirm() call in the app, so the prompt is themed, testable, and
// doesn't block the JS thread.

export default function GlobalConfirmDialog() {
  const [request, setRequest] = useState(null)

  useEffect(() => subscribe(setRequest), [])

  if (!request) return null
  const { id, message, title, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
          danger = false, altLabel = null } = request
  const choose = (answer) => resolveConfirm(id, answer)

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={() => choose(false)} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title || 'Confirm'}
        className="relative w-full max-w-sm bg-panel border border-hairline rounded-2xl shadow-2xl p-5 max-h-[85dvh] overflow-y-auto overscroll-contain"
      >
        {title && <h3 className="text-base font-bold text-ink mb-1">{title}</h3>}
        <p className="text-sm text-ink-2 mb-5 whitespace-pre-line">{message}</p>
        {/* Three answers stack on a phone rather than squeezing onto one row:
            the labels that need a third button are sentences ("Cancel series
            and its 8 visits"), not words. col-reverse keeps the primary
            nearest the thumb while leaving it first in DOM/tab order. */}
        <div className={altLabel
          ? 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'
          : 'flex justify-end gap-2'}>
          <Button variant="secondary" size="sm" onClick={() => choose(false)}>{cancelLabel}</Button>
          {altLabel && (
            <Button variant="secondary" size="sm" onClick={() => choose('alt')}>{altLabel}</Button>
          )}
          <Button autoFocus variant={danger ? 'danger' : 'primary'} size="sm" onClick={() => choose(true)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
