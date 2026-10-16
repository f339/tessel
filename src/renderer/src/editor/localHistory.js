// VS Code's Local History from the editor's side: each save keeps the text
// written (src/main/localHistory.js keeps it); the explorer's Timeline shows
// those versions and reads them again when one is kept.
import { reactive } from 'vue'
import { isLsharePath } from '../../../shared/liveSharePath'

// rev: one more each time a version is kept; path: the file it was for.
export const localHistoryState = reactive({ rev: 0, path: null })

export function keepSavedVersion(path, text) {
  const api = typeof window !== 'undefined' && window.shellApi ? window.shellApi.localHistory : null
  if (!api || typeof api.add !== 'function' || !path || typeof text !== 'string') return
  // A Live Share host's file: no copy of it stays on this computer.
  if (isLsharePath(path)) return
  Promise.resolve()
    .then(() => api.add({ path, text }))
    .then((res) => {
      if (res && res.ok && res.id) {
        localHistoryState.path = path
        localHistoryState.rev++
      }
    })
    .catch(() => {})
}
