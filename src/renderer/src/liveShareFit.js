// Live Share, as a guest: the text size a host's terminal is drawn at in a
// guest's pane (TerminalPane.vue fitLiveShareFont). The host's terminal keeps
// its columns and rows (it is never resized for a guest); the guest's pane
// shows it at the guest's own text size, made larger to fill a larger pane
// (up to twice), or smaller to fit a smaller one: down to 75% of the guest's
// size, never under 9 px (smaller than that is hard to read on a usual
// screen; 75% fits a host's terminal up to a third wider or taller than the
// pane, the usual case of two windows of a similar size). Only a host's
// terminal that is still too big at that size scrolls in the pane.
export const LS_MAX_SCALE = 2
export const LS_MIN_SCALE = 0.75
export const LS_MIN_PX = 9

// -> { min, max } in px, on half points (what xterm draws well).
export function liveShareFontRange(base) {
  const b = Number.isFinite(base) && base > 0 ? base : 14
  const min = Math.min(b, Math.max(LS_MIN_PX, Math.floor(b * LS_MIN_SCALE * 2) / 2))
  return { min, max: b * LS_MAX_SCALE }
}

// The size to draw at, and whether the pane must scroll. roomAt(size) -> how
// many times the host's terminal fits the pane at that text size (the smaller
// of the widths' and the heights' ratios; null: not measurable now); it may
// set the size on the terminal to measure it. current: the size drawn now.
// -> { size, scroll }
export function liveShareFit(base, current, roomAt) {
  const { min, max } = liveShareFontRange(base)
  let size = Math.max(min, Math.min(max, Number.isFinite(current) && current > 0 ? current : base))
  let scale = roomAt(size)
  // Toward the size where it just fits (the cells grow with the text).
  for (let i = 0; i < 4; i++) {
    if (scale == null || (scale >= 1 && scale < 1.06) || (scale >= 1 && size >= max)) break
    const next = Math.max(min, Math.min(max, Math.floor(size * scale * 2) / 2))
    if (next === size) break
    size = next
    scale = roomAt(size)
  }
  // Then a half point at a time until nothing is cut, not below `min`.
  for (let i = 0; i < 16; i++) {
    if (scale == null || scale >= 1 || size <= min) break
    size = Math.max(min, size - 0.5)
    scale = roomAt(size)
  }
  return { size, scroll: scale != null && scale < 1 }
}
