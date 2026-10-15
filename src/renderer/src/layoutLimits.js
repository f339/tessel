// How wide the workspace sidebar may be dragged: 500 px, or more on a wide
// or ultrawide screen (a third of the window at most), never fixed.
export const SIDEBAR_MIN_MAX = 500
export function sidebarMaxWidth(windowWidth = typeof window !== 'undefined' ? window.innerWidth : 0) {
  return Math.max(SIDEBAR_MIN_MAX, Math.round((Number(windowWidth) || 0) * 0.3))
}
