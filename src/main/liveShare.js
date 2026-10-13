// Live Share: others join your Tessel from their own Tessel and see what
// you see (the project shown, its layout, its terminals and agents live),
// type in your panes, open new terminals and agents, and close panes.
//
// Host: Share starts a server on 127.0.0.1 (liveShare/shareHost.js) and a
// Cloudflare quick tunnel to it (liveShare/shareTunnel.js), and gives an
// invite code: the address and a secret that encrypts everything
// (liveShare/shareCrypto.js). Each guest still waits for your yes, and then
// only watches the project you share until you let them type, open or close
// (liveShare:rights). Guests get each pane's screen as it is, never its
// scrollback (visibleScreen). Stop sharing (or quitting Tessel) ends the
// tunnel and every guest's view.
//
// Guest: Join with the code connects (liveShare/shareGuest.js); the host's
// panes become panes of a Live Share project in the window. They are not
// terminals of this computer: pty:attach/write/kill of their ids come here
// (isGuestPane), their output goes through the window's usual pty:data and
// pty:exit, and they are never saved with the layout.
import os from 'os'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createShareHost, cleanRights } from './liveShare/shareHost.js'
import { createShareGuest } from './liveShare/shareGuest.js'
import { newSecret, encodeInvite, decodeInvite } from './liveShare/shareCrypto.js'
import { ensureCloudflared, startTunnel, waitReachable, endLeftoverTunnel } from './liveShare/shareTunnel.js'
import { listProcessNames } from './processTree.js'
import { trimBuffer, HOST_BUFFER_BYTES } from './ptyProtocol.js'
import { t } from './i18n'

const ATTACH_WAIT_MS = 20000
const LAYOUT_DEPTH = 16
const LAYOUT_CHILDREN = 32
const LAYOUT_PANES = 64

export const defaultShareName = () => {
  try {
    return os.userInfo().username || os.hostname()
  } catch {
    return os.hostname()
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')

// What the window says it shows, kept to plain, bounded data: a tree of
// splits ({ type: 'split', dir, sizes, children }) and panes ({ type:
// 'leaf', id, view, title, kind, agentId, accent }), the active and the
// fullscreen pane, the project's name. null when it is not that.
export function cleanLayout(layout) {
  if (!layout || typeof layout !== 'object') return null
  let leaves = 0
  const node = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > LAYOUT_DEPTH) return null
    if (n.type === 'split') {
      const children = (Array.isArray(n.children) ? n.children.slice(0, LAYOUT_CHILDREN) : []).map((c) => node(c, depth + 1)).filter(Boolean)
      if (!children.length) return null
      if (children.length === 1) return children[0]
      const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((s) => Number.isFinite(s) && s >= 0) ? n.sizes.map(Number) : children.map(() => 100 / children.length)
      return { type: 'split', dir: n.dir === 'col' ? 'col' : 'row', sizes, children }
    }
    if (n.type !== 'leaf' || typeof n.id !== 'string' || !/^[\w-]{1,80}$/.test(n.id) || ++leaves > LAYOUT_PANES) return null
    return {
      type: 'leaf',
      id: n.id,
      view: ['terminal', 'editor', 'browser', 'chat'].includes(n.view) ? n.view : 'terminal',
      title: str(n.title),
      kind: n.kind === 'agent' ? 'agent' : 'shell',
      agentId: str(n.agentId, 40) || null,
      accent: /^#[0-9a-f]{3,8}$/i.test(n.accent || '') ? n.accent : null
    }
  }
  const tree = node(layout.tree, 0)
  const ids = new Set()
  const walk = (n) => (n.type === 'leaf' ? ids.add(n.id) : n.children.forEach(walk))
  if (tree) walk(tree)
  return {
    project: str(layout.project) || null,
    tree,
    activeId: ids.has(layout.activeId) ? layout.activeId : null,
    maximizedId: ids.has(layout.maximizedId) ? layout.maximizedId : null
  }
}

export function layoutLeaves(layout) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach(walk)
  }
  walk(layout && layout.tree)
  return out
}

// What a guest gets of a pane: its screen as it is now, without the
// scrollback above it (the terminal host's snapshot has thousands of lines of
// history). The snapshot is drawn on an invisible terminal of the pane's size
// that keeps no scrollback, and that screen is written out again. '' when it
// can't (the guest then sees the output from now on).
export function visibleScreen(data, cols, rows) {
  const text = typeof data === 'string' ? data : ''
  if (!text) return Promise.resolve('')
  return new Promise((resolve) => {
    let vt = null
    const done = (out) => {
      try {
        vt?.dispose()
      } catch {
        /* gone */
      }
      resolve(out)
    }
    try {
      vt = new HeadlessTerminal({
        cols: Math.max(2, Math.min(1000, cols | 0 || 80)),
        rows: Math.max(1, Math.min(500, rows | 0 || 24)),
        scrollback: 0,
        allowProposedApi: true
      })
      const ser = new SerializeAddon()
      vt.loadAddon(ser)
      vt.write(text, () => {
        try {
          done(ser.serialize({ scrollback: 0 }))
        } catch {
          done('')
        }
      })
    } catch {
      done('')
    }
  })
}

// A host pane's id in this window: unique per joined session, and a valid
// pane id (pane-..., [\w-], at most 80).
export function guestPaneId(session, remoteId) {
  return `pane-ls${session}-${String(remoteId).replace(/^pane-/, '').replace(/[^\w-]/g, '_')}`.slice(0, 80)
}

// deps: ipcMain, send(channel, payload) to the window, host (the terminal
// host client), dataDir (cloudflared goes in its bin folder), queueData(id,
// data) and sendExit(id, exitCode) (the window's own pty:data / pty:exit), log.
export function registerLiveShare({ ipcMain, send, host, dataDir, queueData, sendExit, log }) {
  const info = (msg) => log?.info?.('liveshare', msg)

  // --- Host --------------------------------------------------------------
  let sharing = null // { server, tunnel, invite, state, guests, error }
  let layout = null // cleaned, from the window (liveShare:layout)
  const sizes = new Map() // pane id -> { cols, rows }, of every terminal
  const asks = new Map() // guest id -> resolve(yes)
  let changedTimer = null

  const hostStatus = () =>
    sharing
      ? {
          state: sharing.state,
          invite: sharing.state === 'sharing' ? sharing.invite : null,
          expiresAt: sharing.state === 'sharing' ? sharing.server?.inviteExpires() || null : null,
          guests: sharing.guests,
          progress: sharing.progress ?? null,
          error: sharing.error || null
        }
      : { state: 'off', invite: null, expiresAt: null, guests: [], progress: null, error: null }
  const pushHost = () => send('liveShare:host', hostStatus())

  const sharedPanes = () =>
    layoutLeaves(layout)
      .filter((l) => l.view === 'terminal')
      .map((l) => ({ id: l.id, title: l.title, kind: l.kind, agentId: l.agentId, accent: l.accent, ...(sizes.get(l.id) || { cols: 0, rows: 0 }) }))

  function screenChanged() {
    if (!sharing?.server || changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      sharing?.server?.panesChanged()
    }, 60)
  }

  // A snapshot of a pane's screen from the terminal host: ready() is called
  // the moment its answer is read, in order with the pane's output. Its text
  // (the screen without the scrollback) follows.
  function snapshot(id, ready) {
    const toSnap = (msg) => {
      if (!(msg && msg.ok)) return null
      const size = sizes.get(id) || { cols: 0, rows: 0 }
      return { data: visibleScreen(msg.buffer || '', size.cols, size.rows), ...size }
    }
    let snap
    const once = (msg) => (snap === undefined ? (snap = toSnap(msg)) : snap)
    return host.request('attach', { id }, undefined, (msg) => ready(once(msg))).then(once)
  }

  function stopSharing(reason = 'stopped', error = null) {
    const s = sharing
    if (!s) return
    s.cancelled = true
    try {
      s.server?.stop(reason)
    } catch {
      /* already stopped */
    }
    try {
      s.tunnel?.stop()
    } catch {
      /* already stopped */
    }
    for (const resolve of asks.values()) resolve(false)
    asks.clear()
    sharing = error ? { state: 'error', error, guests: [] } : null
    info(`sharing stopped (${reason})`)
    pushHost()
    if (error) sharing = null
  }

  async function startSharing({ name } = {}) {
    if (sharing && sharing.state !== 'error') return { ok: true, ...hostStatus() }
    const s = { state: 'preparing', guests: [], progress: null, cancelled: false }
    sharing = s
    pushHost()
    try {
      // A tunnel left running by a crash of this Tessel while it shared.
      await endLeftoverTunnel(dataDir, { listNames: listProcessNames, kill: (pid) => process.kill(pid) }).catch(() => false)
      if (s.cancelled) return { ok: false }
      const exe = await ensureCloudflared(dataDir, {
        onProgress: (p) => {
          s.progress = p
          pushHost()
        }
      })
      if (s.cancelled) return { ok: false }
      s.progress = null
      s.state = 'starting'
      pushHost()
      const secret = newSecret()
      s.server = createShareHost({
        secret,
        hostName: str(name, 40) || defaultShareName(),
        log: info,
        callbacks: {
          listPanes: sharedPanes,
          layout: () => layout,
          snapshot,
          write: (id, data) => host.send('write', { id, data }),
          openPane: (spec, guest) => send('liveShare:hostRequest', { action: 'open', spec, guest }),
          closePane: (id, guest) => send('liveShare:hostRequest', { action: 'close', id, guest }),
          askApproval: (guest) =>
            new Promise((resolve) => {
              asks.set(guest.id, resolve)
              send('liveShare:ask', { guestId: guest.id, name: guest.name, code: guest.code || null, forward: !!guest.forward })
            }),
          onGuests: (list) => {
            s.guests = list
            for (const id of [...asks.keys()]) if (!list.some((g) => g.id === id)) asks.delete(id)
            pushHost()
          }
        }
      })
      const port = await s.server.start()
      if (s.cancelled) return { ok: false }
      s.tunnel = await startTunnel({
        exe,
        port,
        dataDir,
        onExit: (code) => {
          if (sharing === s) stopSharing('tunnel', t('main.liveShare.tunnelStopped', 'The Cloudflare tunnel stopped (code {{code}}). Sharing ended.', { code }))
        }
      })
      if (s.cancelled) {
        s.tunnel.stop()
        return { ok: false }
      }
      s.state = 'checking'
      pushHost()
      if (!(await waitReachable(s.tunnel.url))) throw new Error(t('main.liveShare.unreachable', 'The tunnel address could not be reached. Check your internet connection and try again.'))
      if (s.cancelled) return { ok: false }
      s.invite = encodeInvite({ url: s.tunnel.url, secret })
      s.state = 'sharing'
      info(`sharing at ${s.tunnel.url}`)
      pushHost()
      return { ok: true, ...hostStatus() }
    } catch (err) {
      if (sharing === s) stopSharing('error', (err && err.message) || String(err))
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  // A new invite code: the old one stops letting anyone in (guests already
  // in stay); good for an hour.
  function newInvite() {
    const s = sharing
    if (!s || s.state !== 'sharing' || !s.server || !s.tunnel) return { ok: false }
    const secret = newSecret()
    s.server.rotate(secret)
    s.invite = encodeInvite({ url: s.tunnel.url, secret })
    info('new invite code')
    pushHost()
    return { ok: true, ...hostStatus() }
  }

  // --- Guest -------------------------------------------------------------
  let joined = null // { client, session, host, state, panes: Map(remoteId -> pane), byLocal, layout, rights, code }
  let sessions = 0

  const guestPanesList = (g) =>
    [...g.panes.values()].map((p) => ({ id: p.localId, title: p.title, kind: p.kind, agentId: p.agentId, accent: p.accent, cols: p.cols, rows: p.rows }))
  const localLayout = (g) => {
    if (!g.layout) return null
    const map = (n) => (n.type === 'leaf' ? { ...n, id: n.view === 'terminal' && g.panes.has(n.id) ? g.panes.get(n.id).localId : guestPaneId(g.session, n.id) } : { ...n, children: n.children.map(map) })
    const local = (id) => (id && g.panes.has(id) ? g.panes.get(id).localId : null)
    return { project: g.layout.project, tree: g.layout.tree ? map(g.layout.tree) : null, activeId: local(g.layout.activeId), maximizedId: local(g.layout.maximizedId) }
  }
  const guestStatus = () =>
    joined
      ? {
          state: joined.state,
          host: joined.host,
          session: joined.session,
          panes: guestPanesList(joined),
          layout: localLayout(joined),
          reason: joined.reason || null,
          // What the host lets this guest do (null: a host from before rights,
          // which lets guests do everything), and the code to tell the host.
          rights: joined.rights,
          code: joined.code
        }
      : { state: 'off', host: null, session: null, panes: [], layout: null, reason: null, rights: null, code: null }
  const pushGuest = () => send('liveShare:guest', guestStatus())

  function onPanes(g, panes, rawLayout) {
    const seen = new Set()
    for (const p of panes.slice(0, LAYOUT_PANES)) {
      if (!p || typeof p.id !== 'string' || !/^[\w-]{1,80}$/.test(p.id)) continue
      seen.add(p.id)
      let pane = g.panes.get(p.id)
      if (!pane) {
        pane = { remoteId: p.id, localId: guestPaneId(g.session, p.id), screen: '', ready: false, attached: false, exited: false, exitCode: null, waiters: [] }
        g.panes.set(p.id, pane)
        g.byLocal.set(pane.localId, pane)
      }
      pane.title = str(p.title)
      pane.kind = p.kind === 'agent' ? 'agent' : 'shell'
      pane.agentId = str(p.agentId, 40) || null
      pane.accent = /^#[0-9a-f]{3,8}$/i.test(p.accent || '') ? p.accent : null
      pane.cols = Math.max(0, Math.min(1000, p.cols | 0))
      pane.rows = Math.max(0, Math.min(500, p.rows | 0))
    }
    // Panes the host closed (or no longer shows): they end here too.
    for (const [remoteId, pane] of [...g.panes]) {
      if (seen.has(remoteId)) continue
      g.panes.delete(remoteId)
      g.byLocal.delete(pane.localId)
      for (const w of pane.waiters.splice(0)) w(false)
      if (pane.attached) sendExit(pane.localId, 0)
    }
    g.layout = cleanLayout(rawLayout)
    pushGuest()
  }

  function joinSession({ invite, name } = {}) {
    const code = decodeInvite(invite)
    if (!code) return { ok: false, error: t('main.liveShare.badInvite', 'This is not a Tessel Live Share invite code.') }
    if (joined) leaveSession('replaced')
    const g = { session: ++sessions, host: null, state: 'connecting', panes: new Map(), byLocal: new Map(), layout: null, reason: null, client: null, rights: null, code: null }
    joined = g
    g.client = createShareGuest({
      url: code.url,
      secret: code.secret,
      name: str(name, 40) || defaultShareName(),
      callbacks: {
        onState: (state, extra) => {
          if (joined !== g) return
          g.state = state
          if (extra?.host) g.host = str(extra.host, 40)
          if (extra?.code) g.code = str(extra.code, 12)
          pushGuest()
        },
        onRights: (rights) => {
          if (joined !== g || !rights) return
          g.rights = cleanRights(rights)
          pushGuest()
        },
        onNotice: (code) => joined === g && send('liveShare:notice', { code: str(code, 40) }),
        onPanes: (panes, rawLayout) => joined === g && onPanes(g, panes, rawLayout),
        onSnapshot: (remoteId, data, cols, rows) => {
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.screen = data
          if (cols > 0 && rows > 0) {
            pane.cols = cols
            pane.rows = rows
          }
          pane.ready = true
          for (const w of pane.waiters.splice(0)) w(true)
        },
        onData: (remoteId, data) => {
          const pane = g.panes.get(remoteId)
          if (!pane) return
          if (pane.attached) queueData(pane.localId, data)
          else pane.screen = trimBuffer(pane.screen + data, HOST_BUFFER_BYTES)
        },
        onExit: (remoteId, exitCode) => {
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.exited = true
          pane.exitCode = exitCode
          if (pane.attached) sendExit(pane.localId, exitCode)
        },
        onClosed: (reason) => {
          if (joined !== g) return
          g.state = 'ended'
          g.reason = reason
          for (const pane of g.panes.values()) for (const w of pane.waiters.splice(0)) w(false)
          info(`left the session of ${g.host || '?'} (${reason})`)
          pushGuest()
          joined = null
        }
      }
    })
    g.client.connect()
    pushGuest()
    return { ok: true }
  }

  function leaveSession(reason = 'left') {
    const g = joined
    if (!g) return
    g.reason = reason
    g.client.leave() // -> onClosed: the window closes the Live Share project
  }

  // --- The window's pty calls for a guest pane ----------------------------
  const isGuestPane = (id) => !!(joined && joined.byLocal.has(id))

  async function guestAttach(id) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane) return { ok: false }
    if (!pane.ready) {
      const ok = await new Promise((resolve) => {
        pane.waiters.push(resolve)
        setTimeout(() => resolve(false), ATTACH_WAIT_MS)
      })
      if (!ok || joined !== g || !g.byLocal.has(id)) return { ok: false }
    }
    const buffer = pane.screen
    pane.screen = ''
    pane.attached = true
    return {
      ok: true,
      shell: { id: 'liveshare', name: g.host || 'Live Share' },
      backend: 'liveshare',
      pid: null,
      cwd: null,
      exited: pane.exited,
      exitCode: pane.exitCode,
      buffer,
      agentLaunchToken: null,
      remoteHostId: null
    }
  }

  // Typing, opening and closing need the host's yes (the host checks too).
  const may = (g, right) => !g.rights || g.rights[right]

  function guestWrite(id, data) {
    const pane = joined && joined.byLocal.get(id)
    if (pane && typeof data === 'string' && may(joined, 'type')) joined.client.write(pane.remoteId, data)
  }

  // Closing a host's pane here asks the host to close it (for everyone).
  // Once the session ended (or while leaving), it only forgets it.
  function guestKill(id) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane) return
    if (g.state === 'joined' && may(g, 'close')) g.client.close(pane.remoteId)
  }

  // --- IPC -----------------------------------------------------------------
  ipcMain.handle('liveShare:state', () => ({ host: hostStatus(), guest: guestStatus(), defaultName: defaultShareName() }))
  ipcMain.handle('liveShare:start', (_evt, opts) => startSharing(opts || {}))
  ipcMain.handle('liveShare:stop', () => {
    stopSharing('stopped')
    return { ok: true }
  })
  ipcMain.on('liveShare:layout', (_evt, raw) => {
    layout = cleanLayout(raw)
    screenChanged()
  })
  ipcMain.handle('liveShare:rights', (_evt, { guestId, rights } = {}) => ({ ok: !!sharing?.server?.setRights(guestId, rights) }))
  ipcMain.handle('liveShare:newInvite', () => newInvite())
  ipcMain.handle('liveShare:approve', (_evt, { guestId, yes } = {}) => {
    const resolve = asks.get(guestId)
    asks.delete(guestId)
    if (resolve) resolve(!!yes)
    return { ok: !!resolve }
  })
  ipcMain.handle('liveShare:removeGuest', (_evt, { guestId } = {}) => {
    sharing?.server?.removeGuest(guestId)
    return { ok: true }
  })
  ipcMain.handle('liveShare:join', (_evt, opts) => joinSession(opts || {}))
  ipcMain.handle('liveShare:leave', () => {
    leaveSession('left')
    return { ok: true }
  })
  ipcMain.handle('liveShare:open', (_evt, spec = {}) => {
    if (!joined || joined.state !== 'joined') return { ok: false }
    if (!may(joined, 'open')) return { ok: false, reason: 'rights' }
    joined.client.open({ kind: spec.kind === 'agent' ? 'agent' : 'terminal', agent: str(spec.agent, 40) || undefined })
    return { ok: true }
  })

  return {
    // Host: every terminal's output, exit and size, as Tessel gets them.
    onPtyData: (id, data) => sharing?.server?.sendData(id, data),
    onPtyExit: (id, exitCode) => sharing?.server?.sendExit(id, exitCode),
    noteSize(id, cols, rows) {
      if (!(cols > 0 && rows > 0)) return
      const old = sizes.get(id)
      if (old && old.cols === cols && old.rows === rows) return
      sizes.set(id, { cols, rows })
      if (sharing?.server && layoutLeaves(layout).some((l) => l.id === id)) screenChanged()
    },
    forgetPane: (id) => sizes.delete(id),
    // Guest panes (the host's, shown here).
    isGuestPane,
    guestAttach,
    guestWrite,
    guestKill,
    stopAll() {
      stopSharing('stopped')
      leaveSession('left')
    }
  }
}
