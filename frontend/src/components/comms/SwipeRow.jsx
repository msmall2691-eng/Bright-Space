import { useRef, useState, useCallback } from 'react'

/**
 * Swipe-to-reveal row (mobile). Renders `children` on top of a right-hand
 * action tray; dragging left reveals the actions, dragging right (or tapping
 * elsewhere) closes them. A short drag that doesn't cross the open threshold
 * snaps back, so a tap still reaches the child's own onClick.
 *
 * Deliberately dependency-free (no gesture lib) and pointer-event based so it
 * works for touch and mouse alike. Vertical intent is detected up front and
 * yields to the scroll container — we never hijack a list scroll.
 *
 * actions: [{ key, label, icon: Icon, onClick, tone }]  (tone → tailwind bg/text)
 */
const BTN_W = 76 // px per action button

export function SwipeRow({ actions = [], children, className = '' }) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const maxReveal = actions.length * BTN_W

  const start = useRef(null)      // { x, y, base } once a gesture begins
  const axis = useRef(null)       // 'h' | 'v' | null — locked after first move
  const openRef = useRef(false)

  const close = useCallback(() => { setDx(0); openRef.current = false }, [])

  const onPointerDown = (e) => {
    if (!actions.length) return
    // Ignore mouse right/middle; only primary pointer.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY, base: dx }
    axis.current = null
  }

  const onPointerMove = (e) => {
    if (!start.current) return
    const ddx = e.clientX - start.current.x
    const ddy = e.clientY - start.current.y
    if (axis.current === null) {
      // Need a few px before deciding — avoids stealing vertical scrolls.
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return
      axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'h' : 'v'
      if (axis.current === 'h') {
        setDragging(true)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
      }
    }
    if (axis.current !== 'h') return
    let next = start.current.base + ddx
    if (next > 0) next = next * 0.25             // rubber-band closed direction
    if (next < -maxReveal) next = -maxReveal - (next + maxReveal) * 0.5
    setDx(next)
  }

  const onPointerUp = () => {
    if (!start.current) return
    start.current = null
    setDragging(false)
    if (axis.current === 'h') {
      // Snap open past 40% of the tray, else closed.
      if (dx < -maxReveal * 0.4) { setDx(-maxReveal); openRef.current = true }
      else close()
    }
    axis.current = null
  }

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Action tray sits behind, pinned right. */}
      {actions.length > 0 && (
        <div className="absolute inset-y-0 right-0 flex" aria-hidden={dx === 0}>
          {actions.map((a) => {
            const Icon = a.icon
            return (
              <button
                key={a.key}
                onClick={(e) => { e.stopPropagation(); close(); a.onClick?.() }}
                style={{ width: BTN_W }}
                className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold ${a.tone}`}
              >
                {Icon && <Icon className="w-[18px] h-[18px]" />}
                {a.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Foreground — translates to reveal the tray. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.22,1,0.36,1)',
          touchAction: 'pan-y',
        }}
        // When open, a tap on the foreground should just close it, not select.
        onClickCapture={(e) => { if (openRef.current) { e.stopPropagation(); e.preventDefault(); close() } }}
        className="relative bg-panel"
      >
        {children}
      </div>
    </div>
  )
}
