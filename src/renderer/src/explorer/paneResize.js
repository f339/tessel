// The height of an explorer section at the bottom (Outline, Timeline), set by
// dragging the sash above it (VS Code's pane sashes) and kept in Settings.
import { ref, watch } from 'vue'
import { settings } from '../settings'

export const PANE_MIN = 44 // two rows
export const PANE_DEFAULT = 220
export const PANE_MAX = 2000
const HEADS = 28 * 3 // the other sections' headers

export function paneHeight(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(v))) : PANE_DEFAULT
}

// key: its Settings key; sectionEl: the section (its explorer bounds the height).
export function usePaneResize({ key, sectionEl }) {
  const height = ref(paneHeight(settings[key]))
  let dragging = false
  watch(
    () => settings[key],
    (v) => {
      if (!dragging) height.value = paneHeight(v)
    }
  )
  function startResize(ev) {
    if (ev.button !== undefined && ev.button !== 0) return
    ev.preventDefault()
    const startY = ev.clientY
    const startH = height.value
    const explorer = sectionEl && sectionEl.value && sectionEl.value.closest ? sectionEl.value.closest('.explorer') : null
    const room = explorer && explorer.clientHeight ? explorer.clientHeight - HEADS - 66 : PANE_MAX
    const max = Math.max(PANE_MIN, Math.min(PANE_MAX, room))
    dragging = true
    if (typeof document !== 'undefined') document.body.classList.add('explorer-sash-dragging')
    const move = (e) => {
      height.value = Math.min(max, Math.max(PANE_MIN, Math.round(startH + (startY - e.clientY))))
    }
    const up = () => {
      dragging = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (typeof document !== 'undefined') document.body.classList.remove('explorer-sash-dragging')
      settings[key] = height.value
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return { height, startResize }
}
