// Live Share, as a guest: the text size a host's terminal is drawn at in a
// guest's pane (TerminalPane.vue fitLiveShareFont). The host's terminal keeps
// its columns and rows (it is never resized for a guest); the guest's pane
// shows all of them at the largest text size where every column fits its
// width and every row its height.
//
// Larger than the guest's own size in a pane larger than the host's terminal
// (a guest who hid the sidebar, maximized the pane or has a larger screen),
// up to 1.6 times, never over 22 px: a host's terminal about two thirds the
// size of the pane fills it, while a tiny host terminal (40 x 12) does not
// turn into poster text that reads as another app; 22 px is about the
// largest that still reads as a terminal on a usual screen, for a guest whose
// own size is already large (a guest's own size over it is kept, never made
// smaller). Smaller in a smaller pane: down to 75% of the guest's size, never
// under 9 px (smaller than that is hard to read on a usual screen; 75% fits a
// host's terminal up to a third wider or taller than the pane, the usual case
// of two windows of a similar size). Only a host's terminal that is still too
// big at that size scrolls in the pane.
//
// The guest's Text size choice for a pane (its menu, on that screen only):
// 'fit' (the above), 'width' (as large as the columns allow in the pane's
// width, within the same limits: when the host's terminal is narrower and
// taller than the pane, its rows then go past the bottom and the pane
// scrolls, following the cursor) or 'normal' (the guest's own size, never
// made larger or smaller: a larger terminal scrolls).
export const LS_MAX_SCALE = 1.6
export const LS_MAX_PX = 22
export const LS_MIN_SCALE = 0.75
export const LS_MIN_PX = 9
export const LS_TEXT_SIZES = ['fit', 'width', 'normal']

// -> { min, max } in px, on half points (what xterm draws well).
export function liveShareFontRange(base, mode = 'fit') {
  const b = Number.isFinite(base) && base > 0 ? base : 14
  if (mode === 'normal') return { min: b, max: b }
  const min = Math.min(b, Math.max(LS_MIN_PX, Math.floor(b * LS_MIN_SCALE * 2) / 2))
  const grown = Math.min(LS_MAX_PX, Math.floor(b * LS_MAX_SCALE * 2) / 2)
  return { min, max: Math.max(b, grown) }
}

// The size to draw at, and whether the pane must scroll. roomAt(size) -> how
// many times the host's terminal fits the pane at that text size: { w, h }
// (the widths' and the heights' ratios), or one number for both (null: not
// measurable now); it may set the size on the terminal to measure it.
// current: the size drawn now.
// -> { size, scroll }: the largest half point that fits (in 'fit', the
// smaller ratio: it never goes past the bottom because it was made larger),
// the same whatever the size drawn now, so a pane resized back and forth
// gets the same size back; or the smallest allowed, scrolling.
export function liveShareFit(base, current, roomAt, mode = 'fit') {
  const { min, max } = liveShareFontRange(base, mode)
  const clamp = (s) => Math.max(min, Math.min(max, s))
  const known = new Map()
  const room = (s) => {
    if (!known.has(s)) known.set(s, roomAt(s))
    return known.get(s)
  }
  const both = (r) => (r == null ? null : typeof r === 'number' ? r : Math.min(r.w, r.h))
  // What the size is chosen by: in 'width', the columns only.
  const fitOf = (r) => (r == null ? null : typeof r === 'number' ? r : mode === 'width' ? r.w : Math.min(r.w, r.h))
  let size = clamp(Number.isFinite(current) && current > 0 ? current : base)
  let scale = fitOf(room(size))
  if (scale == null) return { size, scroll: false }
  // Straight to about the size where it just fits (the cells grow with the
  // text, a little unevenly: whole device pixels)...
  const guess = clamp(Math.floor(size * scale * 2) / 2)
  if (guess !== size && fitOf(room(guess)) != null) {
    size = guess
    scale = fitOf(room(guess))
  }
  // ...then up while the next half point still fits, or down until it fits.
  for (let i = 0; i < 64; i++) {
    const next = scale >= 1 ? Math.min(max, size + 0.5) : Math.max(min, size - 0.5)
    if (next === size) break
    const s = fitOf(room(next))
    if (s == null || (scale >= 1 && s < 1)) break
    size = next
    scale = s
  }
  const all = both(room(size))
  return { size, scroll: all != null && all < 1 }
}

// Where the host's terminal sits in the pane: { left } in whole px (a WebGL
// canvas at a fraction of a pixel draws blurred text). The room left when the
// height is what limits the size is split on both sides, so the pane reads as
// framed rather than cut off on the right; it stays at the top, where a
// terminal's first line is. 0 when it is as wide as the pane or wider (it
// then scrolls).
export function liveShareOffset(roomWidth, termWidth) {
  return { left: roomWidth > termWidth ? Math.floor((roomWidth - termWidth) / 2) : 0 }
}
