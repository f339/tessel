// Live Share in the window (main side: src/main/liveShare.js).
//
// Host: you share one project (chosen when you start, kept when you switch
// to another project): its layout, its panes' names and its active pane are
// sent to the guests each time they change, so they see it live. A guest
// asking to join waits in `asks` until you answer that guest; each guest
// then only watches until you let them type, open or close (setRights).
// What guests do in your panes (open a terminal or an agent) is done here,
// with a notice; a guest asking to close an agent, or a terminal where a
// program runs, waits in `asks` for your yes too. A request is checked again
// when it is done: the same sharing, the guest still in with that right, the
// pane still in the project you share.
//
// Guest: the host's screen becomes a Live Share project in the sidebar. Its
// panes are the host's terminals and agents, attached like terminals kept
// in the terminal host (attachPty gives their screen, pty:data their
// output); its layout follows the host's, fullscreen pane and project
// included. It is never saved with the layout; closing it leaves. What the
// host does not let you do (type, open, close) is not done, with a notice;
// closing one of its panes only asks the host (the pane goes when the host
// closed it). Panes of this computer never mix with the host's: none moves in
// or out, and one that opened there anyway (a page, a file) comes back to a
// project of yours when the session ends.
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
  error: () => t('liveShare.reason.error', 'The connection failed.'),
  lost: () => t('liveShare.reason.lost', 'The connection to the host was lost and did not come back.'),
  'rejoin-refused': () => t('liveShare.reason.rejoinRefused', 'The host no longer knows this Tessel: join again with an invite code.'),
  outdated: () => t('liveShare.reason.outdated', 'Your Tessel is too old for the host’s Live Share: update Tessel and join again.'),
  'outdated-host': () => t('liveShare.reason.outdatedHost', 'The host’s Tessel is too old for this Live Share: the host needs to update Tessel.')
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
// probeRunningWork(id) -> Promise<{ running, unknown, names }>, killPty(id),
// adoptLeaves(leaves) (panes of this computer, put in a project of yours),
// hasAgent(id).
export function createLiveShareWindow(deps) {
  const api = () => (window.shellApi && window.shellApi.liveShare) || null
  const state = reactive({
    host: { state: 'off', invite: null, expiresAt: null, inviteBlocked: false, projectId: null, guests: [], progress: null, error: null },
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
  const nameOf = (g) => (g && g.name) || t('liveShare.guest', 'A guest')
  // The host's fullscreen pane last followed (only its changes are), and
  // whether the host's active pane is still to be taken (once, at the start).
  let hostMaximized = null
  let takeHostActive = true
  // Each time you start sharing: a request from an earlier sharing is stale.
  let generation = 0
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
    const wasBlocked = !!state.host.inviteBlocked
    if (s.state === 'sharing' && state.host.state !== 'sharing') generation++
    Object.assign(state.host, s)
    // The share taken back after a restart: its project (the window does not
    // remember it).
    if (s.state === 'sharing' && s.projectId && !sharedWs()) shareProject(s.projectId)
    if (s.inviteBlocked && !wasBlocked) deps.showToast(t('liveShare.toast.blocked', 'Several connections used your invite code without joining: it no longer lets anyone in. Make a new code in Live Share.'), { kind: 'error', timeout: 12000 })
    for (const g of s.guests || []) {
      const was = before.get(g.id)
      if (g.state === 'joined' && (!was || was.state !== 'joined')) deps.showToast(t('liveShare.toast.joined', '{{name}} joined your Live Share.', { name: nameOf(g) }), { timeout: 5000 })
      before.delete(g.id)
    }
    for (const g of before.values()) if (g.state === 'joined') deps.showToast(t('liveShare.toast.left', '{{name}} left your Live Share.', { name: nameOf(g) }), { timeout: 5000 })
    // A guest who is no longer waiting (gone, or answered elsewhere), and the
    // close requests that no longer stand (the guest left or lost the right,
    // sharing stopped).
    const waiting = new Set((s.guests || []).filter((g) => g.state === 'waiting').map((g) => g.id))
    for (let i = state.asks.length - 1; i >= 0; i--) {
      const a = state.asks[i]
      if (a.kind === 'join' ? !waiting.has(a.guestId) : !closeStands(a)) state.asks.splice(i, 1)
    }
  }

  // The guest is in, with this right, in this sharing.
  const guestMay = (guestId, right) => !!guestId && (state.host.guests || []).some((g) => g.id === guestId && g.state === 'joined' && g.rights && g.rights[right])
  const inShared = (id) => {
    const ws = sharedWs()
    return !!(ws && hasLeaf(ws.tree, id))
  }
  // A guest's close request still stands: same sharing, the guest still in
  // with the right, the pane still in the project you share.
  const closeStands = (a) => hostSharing() && a.generation === generation && guestMay(a.guestId, 'close') && inShared(a.paneId) && !!deps.findLeaf(a.paneId)

  function onAsk(a) {
    if (!a || !a.guestId || state.asks.some((x) => x.key === a.guestId)) return
    state.asks.push({ kind: 'join', key: a.guestId, guestId: a.guestId, name: a.name, code: a.code || null })
  }

  // Your answer to one ask (its key): a guest's join or a close request.
  function answerAsk({ key, yes } = {}) {
    const i = state.asks.findIndex((a) => a.key === key)
    if (i < 0) return
    const [a] = state.asks.splice(i, 1)
    if (a.kind === 'join') api()?.approve({ guestId: a.guestId, yes: !!yes })
    else if (a.kind === 'close' && yes && closeStands(a)) closeForGuest(a.paneId, a.name)
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
    const ask = { kind: 'close', key, guestId: (req.guest && req.guest.id) || null, name: who, paneId: req.id, paneName: leaf ? leaf.paneName || leaf.title : '', detail: null, generation }
    if (!leaf || state.asks.some((a) => a.key === key) || !closeStands(ask)) return
    if (deps.isAgentLeaf(leaf)) ask.detail = t('liveShare.closeAsk.agent', 'Its agent session ends (it can be resumed later from Agent sessions).')
    // A pane on an SSH host or in WSL: what runs there is out of Windows'
    // sight, so Tessel can't tell; you are asked.
    else if (leaf.remoteHostId || leaf.shellId === 'wsl' || leaf.backend === 'ssh') ask.detail = t('liveShare.closeAsk.remote', 'It runs on another system (an SSH host or WSL): Tessel can’t see what runs in it. Closing stops anything running.')
    else {
      const work = await deps.probeRunningWork(req.id)
      // Things changed while it checked (the guest left or lost the right,
      // sharing stopped, the pane closed or moved): nothing is done.
      if (!closeStands(ask)) return
      if (work.unknown) ask.detail = t('liveShare.closeAsk.unknown', 'Tessel could not check whether a command still runs in it. Closing stops anything running.')
      else if (work.running) ask.detail = t('liveShare.closeAsk.running', '{{names}} still runs in it. Closing stops it.', { names: work.names.join(', ') })
    }
    if (!ask.detail) return closeForGuest(req.id, who)
    if (state.asks.some((a) => a.key === key)) return
    state.asks.push(ask)
  }

  function onHostRequest(req) {
    if (!req || !hostSharing()) return
    const who = (req.guest && req.guest.name) || t('liveShare.guest', 'A guest')
    if (req.action === 'open') {
      const agent = req.spec && req.spec.kind === 'agent' ? req.spec.agent : null
      // It opens in the project you share, beside its active pane (never in
      // a new project, whatever "Open new panes" says); a shared project
      // with no pane left has nowhere to put it, and an agent you don't have
      // is not opened.
      const ws = sharedWs()
      const target = ws && (ws.activeId && hasLeaf(ws.tree, ws.activeId) ? ws.activeId : firstLeafId(ws.tree))
      if (!target || (agent && !deps.hasAgent(agent))) return
      deps.showToast(
        agent ? t('liveShare.toast.openedAgent', '{{name}} opened {{agent}} in your Tessel.', { name: who, agent }) : t('liveShare.toast.openedTerminal', '{{name}} opened a terminal in your Tessel.', { name: who }),
        { timeout: 5000 }
      )
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
    const built = buildGuestTree(s.layout, (l) => guestLeaves.get(l.id) || null)
    // Panes of this computer that opened here (a page, a file) stay, beside
    // the host's.
    const local = localLeaves(ws.tree)
    if (!local.length) ws.tree = built
    else {
      const children = built ? [built, ...local] : local
      ws.tree = children.length === 1 ? children[0] : reactive({ type: 'split', id: 'ls-split-local', dir: 'row', sizes: children.map(() => 100 / children.length), children })
    }
    // Your own active pane stays yours (the keyboard never jumps to the
    // host's pane while you type): the host's is taken once, when it is
    // there; after that only when yours is gone.
    const hostActive = s.layout && s.layout.activeId && guestLeaves.has(s.layout.activeId) ? s.layout.activeId : null
    if (takeHostActive && hostActive) {
      ws.activeId = hostActive
      takeHostActive = false
    } else if (!ws.activeId || !hasLeaf(ws.tree, ws.activeId)) ws.activeId = hostActive || (guestLeaves.size ? [...guestLeaves.keys()].find((id) => hasLeaf(ws.tree, id)) || null : null)
    // The host's fullscreen pane: followed when the host changes it (you can
    // leave it meanwhile).
    const max = s.layout && s.layout.maximizedId && guestLeaves.has(s.layout.maximizedId) ? s.layout.maximizedId : null
    if (max !== hostMaximized) {
      hostMaximized = max
      if (deps.currentWsId() === ws.id && deps.maximizedId() !== max) deps.setMaximized(max)
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
        // A new terminal here each time the host's pane starts again (or the
        // connection came back): SplitNode's key.
        gen: p.gen || 0,
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
        if ((p.gen || 0) !== (leaf.gen || 0)) leaf.gen = p.gen || 0
      } else if (!attaching.has(p.id)) attachGuestPane(p, s.session)
    }
    applyLayout(ws)
  }

  function endGuest(s) {
    for (const id of guestLeaves.keys()) deps.dropBuffer(id)
    guestLeaves.clear()
    hostMaximized = null
    takeHostActive = true
    // Its panes are not terminals of this computer: nothing to stop here.
    // Panes of this computer that opened in it go to a project of yours.
    for (const ws of deps.workspaces().filter((w) => w.liveShare)) {
      const local = localLeaves(ws.tree)
      ws.tree = null
      if (local.length) deps.adoptLeaves(local)
      ws.activeId = null
      deps.removeWorkspace(ws.id, true, true)
    }
    if (s.reason && s.reason !== 'left') deps.showToast(t('liveShare.toast.ended', 'Live Share with {{host}} ended: {{reason}}', { host: s.host || '?', reason: endReason(s.reason) }), { kind: 'error', timeout: 9000 })
  }

  function onGuest(s) {
    if (!s) return
    const was = state.guest.state
    const wasIn = was === 'joined' || was === 'reconnecting'
    const before = JSON.stringify(state.guest.rights || null)
    Object.assign(state.guest, { rights: null, code: null, ...s })
    if (s.state === 'joined') {
      // The host changed what you may do (not the first word on it): said once.
      if (was === 'joined' && before !== 'null' && JSON.stringify(s.rights || null) !== before) deps.showToast(`${t('liveShare.toast.rights', '{{host}} changed what you can do.', { host: s.host || '?' })} ${rightsText(s.rights)}`, { timeout: 6000 })
      if (was === 'reconnecting') deps.showToast(t('liveShare.toast.reconnected', 'Back in {{host}}’s Live Share.', { host: s.host || '?' }), { timeout: 4000 })
      syncGuest(s)
    } else if (s.state === 'reconnecting') {
      // The project stays, its panes view only, until the connection is back.
      if (was !== 'reconnecting') deps.showToast(t('liveShare.toast.reconnecting', 'Connection to {{host}} lost: reconnecting…', { host: s.host || '?' }), { timeout: 6000 })
      for (const leaf of guestLeaves.values()) leaf.liveShare.canType = false
    } else if (s.state === 'ended' || (s.state === 'off' && wasIn)) endGuest(s)
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

  // Something this computer would run (a tool, a session, an SSH connection)
  // asked for in a Live Share project: not there.
  function notHere() {
    deps.showToast(t('liveShare.notHere', 'This runs on your computer: open it in one of your projects (a Live Share project shows the host’s panes).'), { timeout: 6000 })
  }

  // Whether you may ask the host to close its panes (else a notice).
  function canClose() {
    if (may('close')) return true
    deps.showToast(t('liveShare.toast.noClose', '{{host}} has not let you close their panes.', { host: state.guest.host || '?' }), { timeout: 5000 })
    return false
  }

  // Asks the host to close one of its panes (main: guestKill). Nothing goes
  // here: the pane leaves when the host closed it (the host may keep it).
  function requestClose(id, name) {
    if (state.guest.state !== 'joined' || !guestLeaves.has(id) || !canClose()) return
    deps.killPty(id)
    deps.showToast(t('liveShare.toast.closeAsked', 'Asked {{host}} to close {{pane}}.', { host: state.guest.host || '?', pane: name || '?' }), { timeout: 4000 })
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
      // Guests waiting for your answer before this window (re)loaded.
      for (const g of (s.host && s.host.guests) || []) if (g.state === 'waiting') onAsk({ guestId: g.id, name: g.name, code: g.code })
      onGuest(s.guest)
    } catch {
      /* not available */
    }
    stops.push(
      watch(
        // (A share taken back after a restart waits for its project to be
        // found again: guests never see it empty meanwhile.)
        () => (hostSharing() && (state.sharedWsId || !state.host.projectId) ? JSON.stringify(layoutNow()) : ''),
        (text) => {
          if (text) a.setLayout(JSON.parse(text))
        },
        { immediate: true }
      ),
      // A share taken back after a restart: its project once the window has
      // its projects again.
      watch(
        () => (hostSharing() && state.host.projectId && !state.sharedWsId ? deps.workspaces().some((w) => w.id === state.host.projectId) : false),
        (found) => {
          if (found) shareProject(state.host.projectId)
        },
        { immediate: true }
      ),
      // The project shared, told to main (kept across a restart).
      watch(
        () => (hostSharing() || ['preparing', 'starting', 'checking'].includes(state.host.state) ? state.sharedWsId : null),
        (id) => {
          if (id && a.setProject) a.setProject(id)
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

  return { state, init, dispose, isGuestWs, isGuestLeaf, openOnHost, notHere, canClose, requestClose, leave, answerAsk, setRights, newInvite, prepareShare, shareProject, sharedWs }
}

function hasLeaf(node, id) {
  if (!node) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

// The panes of this computer in a tree (not a Live Share host's).
function localLeaves(node, out = []) {
  if (!node) return out
  if (node.type === 'leaf') {
    if (node.backend !== 'liveshare') out.push(node)
  } else for (const c of node.children || []) localLeaves(c, out)
  return out
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
