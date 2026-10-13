// Live Share: the layout the host's window shows, as plain data for its
// guests, and the tree a guest's window builds back from it. The shape is
// the one src/main/liveShare.js keeps (cleanLayout): splits ({ type: 'split',
// dir, sizes, children }) and panes ({ type: 'leaf', id, view, title, kind,
// agentId, accent }). Pure functions: App sends the one and draws the other.
import { reactive } from 'vue'

const VIEWS = ['editor', 'browser', 'chat']

function hasLeaf(node, id) {
  if (!node || !id) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

function layoutNode(node) {
  if (!node) return null
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      view: VIEWS.includes(node.kind) ? node.kind : 'terminal',
      title: node.paneName || node.title || '',
      kind: node.kind === 'agent' ? 'agent' : 'shell',
      agentId: node.agentId || null,
      accent: node.accent || null
    }
  }
  const children = (node.children || []).map(layoutNode).filter(Boolean)
  if (!children.length) return null
  return { type: 'split', dir: node.dir, sizes: (node.sizes || []).slice(), children }
}

// What the host's window shows: the project on screen (a Tessel workspace
// { name, tree, activeId }) and its fullscreen pane.
export function hostLayoutFromWorkspace(ws, maximizedId = null) {
  if (!ws) return null
  const tree = layoutNode(ws.tree)
  return {
    project: ws.name || null,
    tree,
    activeId: hasLeaf(tree, ws.activeId) ? ws.activeId : null,
    maximizedId: hasLeaf(tree, maximizedId) ? maximizedId : null
  }
}

// A guest's tree from the host's layout (its pane ids already this window's).
// getLeaf(layoutLeaf) gives the pane to show there (the same reactive leaf
// each time, so its terminal is not opened again) or null. Only terminals are
// shared: other panes are left out, the panes beside them share their room,
// and a split left with one pane is that pane. A split's id comes from where
// it is in the host's tree, so building again after each change of the host
// gives the same ids and Vue keeps the terminals (SplitNode's :key). null
// when nothing is left.
export function buildGuestTree(layout, getLeaf) {
  const build = (node, path) => {
    if (!node) return null
    if (node.type === 'leaf') return node.view === 'terminal' ? getLeaf(node) || null : null
    const kept = []
    ;(node.children || []).forEach((c, i) => {
      const built = build(c, `${path}-${i}`)
      if (built) kept.push({ node: built, size: Number(node.sizes && node.sizes[i]) || 0 })
    })
    if (!kept.length) return null
    if (kept.length === 1) return kept[0].node
    const total = kept.reduce((sum, k) => sum + k.size, 0)
    const sizes = kept.map((k) => (total > 0 ? (k.size / total) * 100 : 100 / kept.length))
    const id = `ls-split-${path}` // i18n-ignore
    return reactive({ type: 'split', id, dir: node.dir === 'col' ? 'col' : 'row', sizes, children: kept.map((k) => k.node) })
  }
  return build(layout && layout.tree, 'r')
}
