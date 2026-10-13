// The editor the explorer's Outline and Timeline follow (VS Code's "active
// editor"): the last editor pane in use, its file, its cursor and the version
// of its text. The Monaco editor itself stays outside Vue's reactivity.
import { reactive, markRaw } from 'vue'

export const activeEditor = reactive({ paneId: null, path: null, version: 0, line: 0, column: 0 })
let current = null

// An editor pane in use shows a file (or a diff: its right side).
export function setActiveEditor({ paneId, editor, path }) {
  if (!paneId || !editor || !path) return
  const same = activeEditor.paneId === paneId && activeEditor.path === path && current === editor
  current = markRaw(editor)
  if (same) return
  activeEditor.paneId = paneId
  activeEditor.path = path
  const pos = typeof editor.getPosition === 'function' ? editor.getPosition() : null
  activeEditor.line = pos ? pos.lineNumber : 0
  activeEditor.column = pos ? pos.column : 0
  activeEditor.version++
}

// Its text changed (the Outline reads its symbols again).
export function noteEdited(paneId) {
  if (paneId && paneId === activeEditor.paneId) activeEditor.version++
}

// Its cursor moved (the Outline's "Follow Cursor").
export function noteCursor(paneId, line, column) {
  if (!paneId || paneId !== activeEditor.paneId) return
  activeEditor.line = line
  activeEditor.column = column
}

// The pane closed or shows no file any more.
export function clearActiveEditor(paneId) {
  if (paneId && paneId !== activeEditor.paneId) return
  current = null
  activeEditor.paneId = null
  activeEditor.path = null
  activeEditor.line = 0
  activeEditor.column = 0
  activeEditor.version++
}

// The Monaco editor itself (its model for symbols, to reveal a symbol).
export function activeMonacoEditor() {
  return current && !(current.getModel && current.getModel() === null) ? current : null
}

// A symbol picked in the Outline: shown and selected in its editor.
export function revealRange(range, { focus = true } = {}) {
  const ed = activeMonacoEditor()
  if (!ed || !range) return false
  ed.setSelection({ startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.startLineNumber, endColumn: range.startColumn })
  ed.revealRangeInCenterIfOutsideViewport(range, 0)
  if (focus) ed.focus()
  return true
}
