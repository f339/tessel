// Live Share in the window (main side: src/main/liveShare.js).
//
// Host: while you share, what the window shows (the current project's
// layout, its panes' names, the active and fullscreen pane) is sent to the
// guests each time it changes, so they see your screen. A guest asking to
// join waits in `asks` until you answer; what guests do in your panes (open
// a terminal or an agent, close a pane) is done here, with a notice.
//
// Guest: the host's screen becomes a Live Share project in the sidebar. Its
// panes are the host's terminals and agents, attached like terminals kept
// in the terminal host (attachPty gives their screen, pty:data their
// output); its layout follows the host's, fullscreen pane and project
// included. It is never saved with the layout; closing it leaves.
import { reactive, watch } from 'vue'
import { t } from './i18n'
import { buildGuestTree, hostLayoutFromWorkspace } from './liveShareLayout'

const REASONS = {
  denied: () => t('liveShare.reason.denied', 'The host said no.'),
  removed: () => t('liveShare.reason.removed', 'The host removed you from the session.'),
  stopped: () => t('liveShare.reason.stopped', 'The host stopped sharing.'),
  closed: () => t('liveShare.reason.closed', 'The connection closed.'),
  refused: () => t('liveShare.reason.refused', 'The invite code is not valid any more.'),
  timeout: () => t('liveShare.reason.timeout', 'The host did not answer in time.'),
  unreachable: () => t('liveShare.reason.unreachable', 'The host could not be reached.'),
  'not-tessel': () => t('liveShare.reason.notTessel', 'This address is not a Tessel Live Share.'),
  slow: () => t('liveShare.reason.slow', 'The connection was too slow to keep up.'),
  tunnel: () => t('liveShare.reason.tunnel', 'The host’s tunnel stopped.'),
  replaced: () => t('liveShare.reason.replaced', 'You joined another session.'),
  left: () => t('liveShare.reason.left', 'You left the session.'),
  error: () => t('liveShare.reason.error', 'The connection failed.')
}
export const endReason = (reason) => (REASONS[reason] ? REASONS[reason]() : t('liveShare.reason.ended', 'The session ended.'))

// deps: workspaces() (the array), currentWs(), currentWsId(), maximizedId()
// / setMaximized(id), makeWorkspace(name), selectWorkspace(id),
// removeWorkspace(id, confirmed, editorChecked), findLeaf(id), closeLeaf(id,
// opts), launch(spec), selectedShell(), seedBuffer(id, text), dropBuffer(id),
// showToast(text, opts).
export function createLiveShareWindow(deps) {
  const api = () => (window.shellApi && window.shellApi.liveShare) || null
  const state = reactive({
    host: { state: 'off', invite: null, guests: [], progress: null, error: null },
    guest: { state: 'off', host: null, session: null, panes: [], layout: null, reason: null },
    defaultName: '',
    asks: []
  })
  const guestLeaves = new Map() // local pane id -> leaf
  const attaching = new Set()
  const offs = []
  let stopWatch = null

  const isGuestWs = (ws) => !!(ws && ws.liveShare)
  const isGuestLeaf = (leaf) => !!(leaf && leaf.backend === 'liveshare')
  const guestWs = (session) => deps.workspaces().find((w) => w.liveShare && w.liveShare.session === session) || null

  // --- Host ----------------------------------------------------------------
  function layoutNow() {
    const ws = deps.currentWs()
    if (!ws || isGuestWs(ws)) return { project: null, tree: null, activeId: null, maximizedId: null }
    return hostLayoutFromWorkspace(ws, deps.maximizedId())
  }

  function onHost(s) {
    const before = new Map(state.host.guests.map((g) => [g.id, g]))
    Object.assign(state.host, s)
    for (const g of s.guests || []) {
      const was = before.get(g.id)
      if (g.state === 'joined' && (!was || was.state !== 'joined')) deps.showToast(t('liveShare.toast.joined', '{{name}} joined your Live Share.', { name: g.name }), { timeout: 5000 })
      before.delete(g.id)
    }
    for (const g of before.values()) if (g.state === 'joined') deps.showToast(t('liveShare.toast.left', '{{name}} left your Live Share.', { name: g.name }), { timeout: 5000 })
    // A guest who is no longer waiting (gone, or answered elsewhere).
    const waiting = new Set((s.guests || []).filter((g) => g.state === 'waiting').map((g) => g.id))
    for (let i = state.asks.length - 1; i >= 0; i--) if (!waiting.has(state.asks[i].guestId)) state.asks.splice(i, 1)
  }

  function onAsk(a) {
    if (a && a.guestId && !state.asks.some((x) => x.guestId === a.guestId)) state.asks.push({ guestId: a.guestId, name: a.name })
  }

  function answerAsk(yes) {
    const a = state.asks.shift()
    if (a) api()?.approve({ guestId: a.guestId, yes: !!yes })
  }

  function onHostRequest(req) {
    if (!req || state.host.state !== 'sharing') return
    const who = (req.guest && req.guest.name) || t('liveShare.guest', 'A guest')
    if (req.action === 'open') {
      const agent = req.spec && req.spec.kind === 'agent' ? req.spec.agent : null
      deps.showToast(
        agent ? t('liveShare.toast.openedAgent', '{{name}} opened {{agent}} in your Tessel.', { name: who, agent }) : t('liveShare.toast.openedTerminal', '{{name}} opened a terminal in your Tessel.', { name: who }),
        { timeout: 5000 }
      )
      deps.launch(agent ? { kind: 'agent', id: agent } : { kind: 'shell', id: deps.selectedShell() })
    } else if (req.action === 'close') {
      const leaf = deps.findLeaf(req.id)
      if (!leaf) return
      deps.showToast(t('liveShare.toast.closed', '{{name}} closed {{pane}}.', { name: who, pane: leaf.paneName || leaf.title }), { timeout: 5000 })
      deps.closeLeaf(req.id, { force: true })
    }
  }

  // --- Guest ---------------------------------------------------------------
  const wsName = (s) => (s.layout && s.layout.project ? `${s.host || '?'} · ${s.layout.project}` : t('liveShare.wsName', '{{host}} · Live Share', { host: s.host || '?' }))

  function applyLayout(ws) {
    const s = state.guest
    ws.tree = buildGuestTree(s.layout, (l) => guestLeaves.get(l.id) || null)
    const active = s.layout && s.layout.activeId && guestLeaves.has(s.layout.activeId) ? s.layout.activeId : null
    if (active) ws.activeId = active
    else if (!ws.activeId || !guestLeaves.has(ws.activeId)) ws.activeId = guestLeaves.size ? [...guestLeaves.keys()].find((id) => hasLeaf(ws.tree, id)) || null : null
    if (deps.currentWsId() === ws.id) {
      const max = s.layout && s.layout.maximizedId && guestLeaves.has(s.layout.maximizedId) ? s.layout.maximizedId : null
      if (deps.maximizedId() !== max) deps.setMaximized(max)
    }
  }

  async function attachGuestPane(p, session) {
    attaching.add(p.id)
    try {
      const a = await window.shellApi.attachPty(p.id).catch(() => null)
      if (!a || !a.ok || state.guest.session !== session || state.guest.state !== 'joined') return
      deps.seedBuffer(p.id, a.buffer)
      const leaf = reactive({
        type: 'leaf',
        id: p.id,
        shellId: 'liveshare',
        shellName: (a.shell && a.shell.name) || t('liveShare.title', 'Live Share'),
        title: p.title || (a.shell && a.shell.name) || t('liveShare.title', 'Live Share'),
        kind: 'shell',
        agentId: null,
        agentCommand: null,
        accent: p.accent || null,
        worktree: null,
        backend: 'liveshare',
        pid: null,
        startDir: null,
        sessionId: null,
        // The host's pane: its size (the terminal shows it at that size),
        // and what it runs there.
        liveShare: { session, cols: p.cols || 0, rows: p.rows || 0, kind: p.kind, agentId: p.agentId || null },
        launchedAt: Date.now(),
        exitedAtStart: !!a.exited,
        restoredText: '',
        broadcast: false
      })
      leaf.attached = true
      guestLeaves.set(p.id, leaf)
      const ws = guestWs(session)
      if (ws) applyLayout(ws)
    } finally {
      attaching.delete(p.id)
    }
  }

  function syncGuest(s) {
    let ws = guestWs(s.session)
    if (!ws) {
      ws = deps.makeWorkspace(wsName(s))
      ws.liveShare = { session: s.session, host: s.host }
      deps.workspaces().push(ws)
      deps.selectWorkspace(ws.id)
    }
    ws.name = wsName(s)
    const ids = new Set(s.panes.map((p) => p.id))
    for (const [id, leaf] of [...guestLeaves]) {
      if (ids.has(id) && leaf.liveShare.session === s.session) continue
      guestLeaves.delete(id)
      deps.dropBuffer(id)
    }
    for (const p of s.panes) {
      const leaf = guestLeaves.get(p.id)
      if (leaf) {
        if (p.title) leaf.title = p.title
        leaf.accent = p.accent || null
        if (p.cols > 0 && p.rows > 0) {
          leaf.liveShare.cols = p.cols
          leaf.liveShare.rows = p.rows
        }
      } else if (!attaching.has(p.id)) attachGuestPane(p, s.session)
    }
    applyLayout(ws)
  }

  function endGuest(s) {
    for (const id of guestLeaves.keys()) deps.dropBuffer(id)
    guestLeaves.clear()
    // Its panes are not terminals of this computer: nothing to stop here.
    for (const ws of deps.workspaces().filter((w) => w.liveShare)) {
      ws.tree = null
      ws.activeId = null
      deps.removeWorkspace(ws.id, true, true)
    }
    if (s.reason && s.reason !== 'left') deps.showToast(t('liveShare.toast.ended', 'Live Share with {{host}} ended: {{reason}}', { host: s.host || '?', reason: endReason(s.reason) }), { kind: 'error', timeout: 9000 })
  }

  function onGuest(s) {
    if (!s) return
    const wasJoined = state.guest.state === 'joined'
    Object.assign(state.guest, s)
    if (s.state === 'joined') syncGuest(s)
    else if (s.state === 'ended' || (s.state === 'off' && wasJoined)) endGuest(s)
  }

  // A new terminal or agent in a Live Share project opens on the host.
  function openOnHost(spec) {
    if (state.guest.state !== 'joined') return
    api()?.open(spec)
    deps.showToast(t('liveShare.toast.opening', 'Opening it on {{host}}’s computer…', { host: state.guest.host || '?' }), { timeout: 3000 })
  }

  function leave() {
    api()?.leave()
  }

  async function init() {
    const a = api()
    if (!a) return
    offs.push(a.onHost(onHost), a.onGuest(onGuest), a.onAsk(onAsk), a.onHostRequest(onHostRequest))
    try {
      const s = await a.state()
      state.defaultName = s.defaultName || ''
      onHost(s.host)
      onGuest(s.guest)
    } catch {
      /* not available */
    }
    stopWatch = watch(
      () => (state.host.state === 'sharing' ? JSON.stringify(layoutNow()) : ''),
      (text) => {
        if (text) a.setLayout(JSON.parse(text))
      },
      { immediate: true }
    )
  }

  function dispose() {
    for (const off of offs.splice(0)) if (typeof off === 'function') off()
    if (stopWatch) stopWatch()
  }

  return { state, init, dispose, isGuestWs, isGuestLeaf, openOnHost, leave, answerAsk }
}

function hasLeaf(node, id) {
  if (!node) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}
