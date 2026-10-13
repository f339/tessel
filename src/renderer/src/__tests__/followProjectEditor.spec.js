import { describe, it, expect } from 'vitest'
import { editorPaneToFollow } from '../editor/activeEditor'

// A tiny split tree like App's: { type: 'split', children } / { type: 'leaf', id, kind }.
const leaf = (id, kind) => ({ type: 'leaf', id, kind })
const split = (...children) => ({ type: 'split', children })
function forEachLeaf(n, fn) {
  if (!n) return
  if (n.type === 'leaf') fn(n)
  else n.children.forEach((c) => forEachLeaf(c, fn))
}
function findLeafIn(n, id) {
  let hit = null
  forEachLeaf(n, (l) => {
    if (l.id === id) hit = l
  })
  return hit
}
const deps = { findLeafIn, forEachLeaf }

describe('the Outline and Timeline follow the project on screen', () => {
  it("another project's editor is dropped; this project's active editor is taken", () => {
    const ws = { activeId: 'e2', tree: split(leaf('t1', 'shell'), leaf('e2', 'editor')) }
    expect(editorPaneToFollow(ws, 'other-project-editor', deps)).toEqual({ keep: false, pick: ws.tree.children[1] })
  })
  it('its active pane is a terminal: its first editor pane; none: nothing to follow', () => {
    const ws = { activeId: 't1', tree: split(leaf('t1', 'shell'), leaf('e3', 'editor'), leaf('e4', 'editor')) }
    expect(editorPaneToFollow(ws, null, deps).pick.id).toBe('e3')
    const noEditor = { activeId: 't1', tree: split(leaf('t1', 'shell')) }
    expect(editorPaneToFollow(noEditor, 'x', deps)).toEqual({ keep: false, pick: null })
  })
  it('the editor followed is in this project: kept', () => {
    const ws = { activeId: 't1', tree: split(leaf('t1', 'shell'), leaf('e3', 'editor')) }
    expect(editorPaneToFollow(ws, 'e3', deps).keep).toBe(true)
  })
})
