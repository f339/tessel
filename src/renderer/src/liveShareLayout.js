// Live Share: the layout the host's window shows, as plain data for its
// guests, and the tree a guest's window builds back from it. The shape is
// the one src/main/liveShare.js keeps (cleanLayout): splits ({ type: 'split',
// dir, sizes, children }) and panes ({ type: 'leaf', id, view, title, kind,
// agentId, accent }). Pure functions: App sends the one and draws the other.
//
// The host's agent panes whose conversation guests can look at as a chat
// (hostChatsFromWorkspace: where it is, for the host's main only, which never
// sends it to guests), and the guest's own leaves for them: a pane the host
// has in chat mode (no terminal) is kept in a guest's tree like a terminal
// when the guest's window has a leaf for it.
import { reactive } from 'vue'
import { workspaceViews } from './paneViews'
import { isRemotePath } from '../../shared/remotePath.js'

const VIEWS = ['editor', 'browser', 'chat']

function hasLeaf(node, id) {
  if (!node || !id) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

function layoutNode(node) {
  if (!node) return null
  if (node.type === 'leaf') {
    const view = VIEWS.includes(node.kind) ? node.kind : 'terminal'
    return {
      type: 'leaf',
      id: node.id,
      view,
      // Only terminals are shared: the others' names (a file, a page) are not
      // sent, their place is.
      title: view === 'terminal' ? node.paneName || node.title || '' : '',
      kind: node.kind === 'agent' ? 'agent' : 'shell',
      agentId: node.agentId || null,
      accent: node.accent || null
    }
  }
  const children = (node.children || []).map(layoutNode).filter(Boolean)
  if (!children.length) return null
  return { type: 'split', dir: node.dir, sizes: (node.sizes || []).slice(), children }
}

// What the host's window shows: the project shared (a Tessel workspace
// { name, tree, activeId }), the view of it on screen (a project's task
// copies each have their own, paneViews.js: only that one), and its
// fullscreen pane.
function shownTree(ws) {
  const views = workspaceViews(ws)
  const onScreen = views.find((v) => v.active) || views[0]
  return onScreen ? onScreen.tree : ws.tree
}

export function hostLayoutFromWorkspace(ws, maximizedId = null) {
  if (!ws) return null
  const tree = layoutNode(shownTree(ws))
  return {
    project: ws.name || null,
    tree,
    activeId: hasLeaf(tree, ws.activeId) ? ws.activeId : null,
    maximizedId: hasLeaf(tree, maximizedId) ? maximizedId : null
  }
}

// The agents whose conversation file Tessel reads (src/main/chat/
// transcriptView.js TRANSCRIPT_VIEW_AGENTS): their panes' conversations can
// be shown to guests.
export const GUEST_CHAT_AGENTS = ['claude', 'openclaude', 'codex', 'cursor', 'antigravity', 'grok', 'omp']
const isLocalDir = (p) => typeof p === 'string' && !!p && !isRemotePath(p)

// The agent panes of the project's view on screen whose conversation guests
// can look at as a chat: a terminal agent, or a pane in chat mode (terminal:
// false), of this computer, whose conversation is known. Where it is (the
// agent, its session, its account) and the project's folders (paths outside
// them are hidden from guests) are for the host's main only.
export function hostChatsFromWorkspace(ws) {
  if (!ws) return []
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type !== 'leaf') return (n.children || []).forEach(walk)
    const chat = n.kind === 'chat'
    if (!(n.kind === 'agent' || chat) || !GUEST_CHAT_AGENTS.includes(n.agentId) || typeof n.sessionId !== 'string' || !n.sessionId) return
    // An agent on an SSH host: its conversation is the host's, not shown.
    if (n.remoteHostId || (typeof n.cwd === 'string' && isRemotePath(n.cwd))) return
    const roots = [n.startDir, n.cwd, n.projectDir, n.worktree && n.worktree.path, ws.cwd].filter(isLocalDir)
    out.push({
      id: n.id,
      agentId: n.agentId,
      sessionId: n.sessionId,
      ...(typeof n.accountId === 'string' || n.accountId === null ? { accountId: n.accountId } : {}),
      terminal: !chat,
      // A pane in chat mode has no name in the layout (only terminals do).
      title: chat ? n.paneName || n.title || '' : '',
      roots: [...new Set(roots)]
    })
  }
  walk(shownTree(ws))
  return out
}

// A guest's tree from the host's layout (its pane ids already this window's).
// getLeaf(layoutLeaf) gives the pane to show there (the same reactive leaf
// each time, so its terminal is not opened again) or null. Only terminals are
// shared: other panes are left out, the panes beside them share their room,
// and a split left with one pane is that pane. A split's id comes from where
// it is in the host's tree, so building again after each change of the host
// gives the same ids and Vue keeps the terminals (SplitNode's :key). null
// when nothing is left. pages: the guest may see the host's browser pages
// (its "See my browser pages"): a browser pane is kept too (getLeaf gives
// its page view, phase 2c).
export function buildGuestTree(layout, getLeaf, { pages = false } = {}) {
  const build = (node, path) => {
    if (!node) return null
    // A terminal, or a pane in chat mode the guest's window shows as a chat.
    if (node.type === 'leaf') return node.view === 'terminal' || node.view === 'chat' || (pages && node.view === 'browser') ? getLeaf(node) || null : null
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
