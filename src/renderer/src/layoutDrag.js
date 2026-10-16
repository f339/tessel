// A drag of one of the window's edges: the projects sidebar's
// (WorkspaceSidebar.vue) or the right panel's (App.vue). The edge follows
// the pointer through the element's own style, once a frame, and nothing
// else changes until it is let go:
// - App's width (the sidebar's or the panel's) is set once, at the end. Set
//   on every frame, it re-rendered the window and the sidebar's rows, and
//   the layout's save watcher walked every project's panes each time.
// - Terminals keep their grid and their PTY's size while it runs (their box
//   follows with CSS alone) and fit once it ends. A fit reflows a
//   terminal's whole scrollback: every terminal of every project (hidden
//   ones too) refitted at each pause of the hand longer than their settle
//   delay, and the window stalled each time.
// - The hidden projects' panes are not laid out again on every frame
//   (body.ws-resizing, style.css): only once, at the size it ends at.
// - The resize cursor over the whole window comes from one element on top
//   (.layout-drag-shield), not from a rule on every element: switching
//   such a rule on and off restyled the whole window (some 15,000
//   elements, about 100 ms) when the drag began and again when it ended.
let drags = 0
let shield = null

// Is an edge being dragged now?
export function layoutDragging() {
  return drags > 0
}

// A drag starts: -> end(), which tells the terminals to fit their new size
// (once, when the last drag running ends; a second call does nothing).
export function beginLayoutDrag() {
  drags++
  if (drags === 1 && typeof document !== 'undefined') {
    document.body.classList.add('ws-resizing')
    shield = document.createElement('div')
    shield.className = 'layout-drag-shield'
    shield.setAttribute('aria-hidden', 'true')
    document.body.appendChild(shield)
  }
  let ended = false
  return () => {
    if (ended) return
    ended = true
    drags = Math.max(0, drags - 1)
    if (drags) return
    if (typeof document !== 'undefined') {
      document.body.classList.remove('ws-resizing')
      if (shield) shield.remove()
      shield = null
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('terminal-layout-change'))
  }
}

// The width the pointer asks for, applied once a frame at most (a pointer
// moves up to 250 times a second): set(px) for each move, finish() when it
// is let go applies the last one now and returns it (null: never moved).
export function frameFollower(apply) {
  let pending = null
  let frame = 0
  const flush = () => {
    frame = 0
    if (pending != null) apply(pending)
  }
  return {
    set(px) {
      pending = px
      if (!frame) frame = requestAnimationFrame(flush)
    },
    finish() {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      flush()
      return pending
    }
  }
}

// Tests.
export function _resetLayoutDragForTests() {
  drags = 0
  if (shield) shield.remove()
  shield = null
  if (typeof document !== 'undefined') document.body.classList.remove('ws-resizing')
}
