// Live Share in the window (main side: src/main/liveShare.js).
//
// Host: you share one project (chosen when you start, kept when you switch
// to another project): its layout, its panes' names and its active pane are
// sent to the guests each time they change, so they see it live. A guest
// asking to join waits in `asks` until you answer that guest; each guest
// then only watches until you let them type, open or close (setRights).
// What guests do in your panes (open a terminal or an agent) is done here,
// with a notice; a guest asking to close an agent, or a terminal where a
// program runs, waits in `asks` for your yes too.
//
// Guest: the host's screen becomes a Live Share project in the sidebar. Its
// panes are the host's terminals and agents, attached like terminals kept
// in the terminal host (attachPty gives their screen, pty:data their
// output); its layout follows the host's, fullscreen pane and project
// included. It is never saved with the layout; closing it leaves. What the
// host does not let you do (type, open, close) is not done, with a notice.
import { reactive, watch } from 'vue'
import { t } from './i18n'
import { buildGuestTree, hostLayoutFromWorkspace } from './liveShareLayout'

const REASONS = {
  denied: () => t('liveShare.reason.denied', 'The host said no.'),
  removed: () => t('liveShare.reason.removed', 'The host removed you from the session.'),
  stopped: () => t('liveShare.reason.stopped', 'The host stopped sharing.'),
  closed: () => t('liveShare.reason.closed', 'The connection closed.'),
  refused: () => t('liveShare.reason.refused', 'The invite code is not valid any more.'),
  expired: () => t('liveShare.reason.expired', 'This invite code expired. Ask the host for a new one.'),
  busy: () => t('liveShare.reason.busy', 'The host is not taking new guests right now. Try again in a few minutes.'),
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

// What a guest may do, in words ("type, open terminals and agents").
export function rightsText(rights) {
  if (!rights) return t('liveShare.rights.all', 'The host’s Tessel lets guests type, open and close panes.')
  const parts = []
  if (rights.type) parts.push(t('liveShare.rights.typePart', 'type in its terminals and agents'))
  if (rights.open) parts.push(t('liveShare.rights.openPart', 'open terminals and agents'))
  if (rights.close) parts.push(t('liveShare.rights.closePart', 'ask to close panes'))
  if (!parts.length) return t('liveShare.rights.watch', 'You can watch. The host has not let you type yet.')
  return t('liveShare.rights.can', 'You can watch and {{list}}.', { list: parts.join(', ') })
}

// deps: workspaces() (the array), currentWs(), currentWsId(), maximizedId()
// / setMaximized(id), makeWorkspace(name), selectWorkspace(id),
// removeWorkspace(id, confirmed, editorChecked), findLeaf(id), closeLeaf(id,
// opts), launch(spec, targetId, where), selectedShell(), seedBuffer(id, text),
// dropBuffer(id), showToast(text, opts), isAgentLeaf(leaf),
// probeRunningWork(id) -> Promise<{ running, unknown, names }>.
export function createLiveShareWindow(deps) {
  const api = () => (window.shellApi && window.shellApi.liveShare) || null
  const state = reactive({
    host: { state: 'off', invite: null, expiresAt: null, guests: [], progress: null, error: null },
    guest: { state: 'off', host: null, session: null, panes: [], layout: null, reason: null, rights: null, code: null },
    defaultName: '',
    // The project you share (its id), chosen when you start.
    sharedWsId: null,
    // What waits for your answer, first one shown: { kind: 'join', key,
    // guestId, name, code, forward } or { kind: 'close', key, guestId, name,
    // paneId, paneName, detail }.
    asks: []
  })
  const guestLeaves = new Map() // local pane id -> leaf
  const attaching = new Set()
  const offs = []
  const stops = []

  const isGuestWs = (ws) => !!(ws && ws.liveShare)
  const isGuestLeaf = (leaf) => !!(leaf && leaf.backend === 'liveshare')
  const guestWs = (session) => deps.workspaces().find((w) => w.liveShare && w.liveShare.session === session) || null
  const hostSharing = () => state.host.state === 'sharing'

  // --- Host ----------------------------------------------------------------
  const sharedWs = () => (state.sharedWsId ? deps.workspaces().find((w) => w.id === state.sharedWsId && !isGuestWs(w)) || null : null)

  function layoutNow() {
    const ws = sharedWs()
    if (!ws) return { project: null, tree: null, activeId: null, maximizedId: null }
    // The fullscreen pane is the window's: only when the shared project is the one on screen.
    return hostLayoutFromWorkspace(ws, deps.currentWsId() === ws.id ? deps.maximizedId() : null)
  }

  // Before you start: the project on screen (or your first one when a Live
  // Share project is on screen) is the one offered.
  function prepareShare() {
    if (hostSharing() || ['preparing', 'starting', 'checking'].includes(state.host.state)) return
    if (sharedWs()) return
    const cur = deps.currentWs()
    const ws = cur && !isGuestWs(cur) ? cur : deps.workspaces().find((w) => !isGuestWs(w)) || null
    state.sharedWsId = ws ? ws.id : null
  }

  function shareProject(id) {
    const ws = deps.workspaces().find((w) => w.id === id && !isGuestWs(w))
    if (ws) state.sharedWsId = ws.id
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
    // A guest who is no longer waiting (gone, or answered elsewhere), and the
    // requests of a guest who left.
    const waiting = new Set((s.guests || []).filter((g) => g.state === 'waiting').map((g) => g.id))
    const joined = new Set((s.guests || []).filter((g) => g.state === 'joined').map((g) => g.id))
    for (let i = state.asks.length - 1; i >= 0; i--) {
      const a = state.asks[i]
      if (a.kind === 'join' ? !waiting.has(a.guestId) : !joined.has(a.guestId)) state.asks.splice(i, 1)
    }
  }

  function onAsk(a) {
    if (!a || !a.guestId || state.asks.some((x) => x.key === a.guestId)) return
    state.asks.push({ kind: 'join', key: a.guestId, guestId: a.guestId, name: a.name, code: a.code || null, forward: a.forward !== false })
  }

  // Your answer to one ask (its key): a guest's join or a close request.
  function answerAsk({ key, yes } = {}) {
    const i = state.asks.findIndex((a) => a.key === key)
    if (i < 0) return
    const [a] = state.asks.splice(i, 1)
    if (a.kind === 'join') api()?.approve({ guestId: a.guestId, yes: !!yes })
    else if (a.kind === 'close' && yes && deps.findLeaf(a.paneId)) closeForGuest(a.paneId, a.name)
  }

  function setRights(guestId, rights) {
    return api()?.setRights({ guestId, rights: { type: !!rights.type, open: !!rights.open, close: !!rights.close } })
  }

  function newInvite() {
    return api()?.newInvite()
  }

  function closeForGuest(id, who) {
    const leaf = deps.findLeaf(id)
    if (!leaf) return
    deps.showToast(t('liveShare.toast.closed', '{{name}} closed {{pane}}.', { name: who, pane: leaf.paneName || leaf.title }), { timeout: 5000 })
    deps.closeLeaf(id, { force: true })
  }

  // A guest asks to close one of your panes: an idle terminal closes (with a
  // notice); an agent, or a terminal where a program runs, waits for your yes.
  async function askClose(req, who) {
    const leaf = deps.findLeaf(req.id)
    const key = `close-${req.id}` // i18n-ignore
    if (!leaf || state.asks.some((a) => a.key === key)) return
    const paneName = leaf.paneName || leaf.title
    let detail = null
    if (deps.isAgentLeaf(leaf)) detail = t('liveShare.closeAsk.agent', 'Its agent session ends (it can be resumed later from Agent sessions).')
    else {
      const work = await deps.probeRunningWork(req.id)
      if (!deps.findLeaf(req.id) || !hostSharing()) return
      if (work.unknown) detail = t('liveShare.closeAsk.unknown', 'Tessel could not check whether a command still runs in it. Closing stops anything running.')
      else if (work.running) detail = t('liveShare.closeAsk.running', '{{names}} still runs in it. Closing stops it.', { names: work.names.join(', ') })
    }
    if (!detail) return closeForGuest(req.id, who)
    if (state.asks.some((a) => a.key === key)) return
    state.asks.push({ kind: 'close', key, guestId: req.guest && req.guest.id, name: who, paneId: req.id, paneName, detail })
  }

  function onHostRequest(req) {
    if (!req || !hostSharing()) return
    const who = (req.guest && req.guest.name) || t('liveShare.guest', 'A guest')
    if (req.action === 'open') {
      const agent = req.spec && req.spec.kind === 'agent' ? req.spec.agent : null
      deps.showToast(
        agent ? t('liveShare.toast.openedAgent', '{{name}} opened {{agent}} in your Tessel.', { name: who, agent }) : t('liveShare.toast.openedTerminal', '{{name}} opened a terminal in your Tessel.', { name: who }),
        { timeout: 5000 }
      )
      // It opens in the project you share, beside its active pane (never in
      // a new project, whatever "Open new panes" says); a shared project
      // with no pane left has nowhere to put it.
      const ws = sharedWs()
      const target = ws && (ws.activeId && hasLeaf(ws.tree, ws.activeId) ? ws.activeId : firstLeafId(ws.tree))
      if (!target) return
      deps.launch(agent ? { kind: 'agent', id: agent } : { kind: 'shell', id: deps.selectedShell() }, target, 'right')
    } else if (req.action === 'close') {
      askClose(req, who)
    }
  }

  // --- Guest ---------------------------------------------------------------
  const wsName = (s) => (s.layout && s.layout.project ? `${s.host || '?'} · ${s.layout.project}` : t('liveShare.wsName', '{{host}} · Live Share', { host: s.host || '?' }))
  // What this guest may do (a host from before rights: everything).
  const may = (right) => !state.guest.rights || !!state.guest.rights[right]

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
        // what it runs there, and whether you may type in it.
        liveShare: { session, cols: p.cols || 0, rows: p.rows || 0, kind: p.kind, agentId: p.agentId || null, canType: may('type'), host: state.guest.host || '' },
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
        leaf.liveShare.canType = may('type')
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
    const before = JSON.stringify(state.guest.rights || null)
    Object.assign(state.guest, { rights: null, code: null, ...s })
    if (s.state === 'joined') {
      // The host changed what you may do: said once.
      if (wasJoined && JSON.stringify(s.rights || null) !== before) deps.showToast(`${t('liveShare.toast.rights', '{{host}} changed what you can do.', { host: s.host || '?' })} ${rightsText(s.rights)}`, { timeout: 6000 })
      syncGuest(s)
    } else if (s.state === 'ended' || (s.state === 'off' && wasJoined)) endGuest(s)
  }

  // A new terminal or agent in a Live Share project opens on the host, when
  // the host lets you.
  function openOnHost(spec) {
    if (state.guest.state !== 'joined') return
    if (!may('open')) {
      deps.showToast(t('liveShare.toast.noOpen', '{{host}} has not let you open terminals or agents.', { host: state.guest.host || '?' }), { timeout: 5000 })
      return
    }
    api()?.open(spec)
    deps.showToast(t('liveShare.toast.opening', 'Opening it on {{host}}’s computer…', { host: state.guest.host || '?' }), { timeout: 3000 })
  }

  // Whether you may ask the host to close its panes (else a notice).
  function canClose() {
    if (may('close')) return true
    deps.showToast(t('liveShare.toast.noClose', '{{host}} has not let you close their panes.', { host: state.guest.host || '?' }), { timeout: 5000 })
    return false
  }

  function onNotice(n) {
    if (n && n.code === 'limit') deps.showToast(t('liveShare.toast.limit', '{{host}}’s Tessel limits how often guests open or close panes. Wait a minute.', { host: state.guest.host || '?' }), { timeout: 6000 })
  }

  function leave() {
    api()?.leave()
  }

  async function init() {
    const a = api()
    if (!a) return
    offs.push(a.onHost(onHost), a.onGuest(onGuest), a.onAsk(onAsk), a.onHostRequest(onHostRequest))
    if (a.onNotice) offs.push(a.onNotice(onNotice))
    try {
      const s = await a.state()
      state.defaultName = s.defaultName || ''
      onHost(s.host)
      onGuest(s.guest)
    } catch {
      /* not available */
    }
    stops.push(
      watch(
        () => (hostSharing() ? JSON.stringify(layoutNow()) : ''),
        (text) => {
          if (text) a.setLayout(JSON.parse(text))
        },
        { immediate: true }
      ),
      // The shared project closed: sharing stops (guests never see another one).
      watch(
        () => hostSharing() && !!state.sharedWsId && !sharedWs(),
        (gone) => {
          if (!gone) return
          state.sharedWsId = null
          a.stop()
          deps.showToast(t('liveShare.toast.projectClosed', 'You closed the project you shared: Live Share stopped.'), { timeout: 6000 })
        }
      )
    )
  }

  function dispose() {
    for (const off of offs.splice(0)) if (typeof off === 'function') off()
    for (const stop of stops.splice(0)) stop()
  }

  return { state, init, dispose, isGuestWs, isGuestLeaf, openOnHost, canClose, leave, answerAsk, setRights, newInvite, prepareShare, shareProject, sharedWs }
}

function hasLeaf(node, id) {
  if (!node) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

function firstLeafId(node) {
  if (!node) return null
  if (node.type === 'leaf') return node.id
  for (const c of node.children || []) {
    const id = firstLeafId(c)
    if (id) return id
  }
  return null
}
