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
// tunnel and every guest's view. A restart of Tessel (an update, a crash, a
// new version in development) does not: the next Tessel takes the share back
// (resumeSharing: the same tunnel and invite code), and guests reconnect.
//
// Guest: Join with the code connects (liveShare/shareGuest.js); the host's
// panes become panes of a Live Share project in the window. They are not
// terminals of this computer: pty:attach/write/kill of their ids come here
// (isGuestPane), their output goes through the window's usual pty:data and
// pty:exit, and they are never saved with the layout. A connection that drops
// is taken up again with this guest's reconnect key (shareGuest.js: it
// signs the new connection; no new question), and a restart of this Tessel
// joins the session again (resumeGuest).
import os from 'os'
import { join } from 'path'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createShareHost, cleanRights } from './liveShare/shareHost.js'
import { createShareGuest } from './liveShare/shareGuest.js'
import { newSecret, encodeInvite, decodeInvite, newSigningKey, exportSigningKey, importSigningKey } from './liveShare/shareCrypto.js'
import { ensureCloudflared, startTunnel, waitReachable, endLeftoverTunnel, tunnelState, stopTunnelPid, processPath, cloudflaredPath } from './liveShare/shareTunnel.js'
import { createSessionFile } from './liveShare/sharePersist.js'
import { pidRunning as pidAlive } from './processTree.js'
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

// Where a full-screen program's screen starts in a serialized screen.
const ALT_SCREEN = '\x1b[?1049h\x1b[H'

// What a guest gets of a pane: its screen as it is now, without the
// scrollback above it (the terminal host's snapshot has thousands of lines of
// history). The snapshot is drawn on an invisible terminal of the pane's size
// that keeps no scrollback, and that screen is written out again. While a
// full-screen program shows (the alternate screen), only its screen: the
// normal screen hidden under it is history too. '' when it can't (the guest
// then sees the output from now on).
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
          const all = ser.serialize({ scrollback: 0 })
          if (vt.buffer.active.type !== 'alternate') return done(all)
          // The addon writes the normal screen, then this switch and the
          // alternate screen (and the modes after it): from the switch on.
          const at = all.lastIndexOf(ALT_SCREEN)
          done(at >= 0 ? all.slice(at) : '')
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

// What a share's start says when cloudflared failed (shareTunnel.js
// TunnelError), in the user's language.
function tunnelErrorText(err) {
  const detail = (err && err.detail) || ''
  switch (err && err.code) {
    case 'download':
      return t('main.liveShare.err.download', 'cloudflared could not be downloaded ({{detail}}).', { detail })
    case 'checksum':
      return t('main.liveShare.err.checksum', 'The cloudflared download does not match its published checksum: it was not used.')
    case 'timeout':
      return t('main.liveShare.err.timeout', 'Cloudflare did not give a tunnel address in time. Try again.')
    case 'stopped':
      return t('main.liveShare.err.stopped', 'cloudflared stopped before giving an address ({{detail}}).', { detail })
    case 'start':
      return t('main.liveShare.err.start', 'cloudflared could not start ({{detail}}).', { detail })
    default:
      return (err && err.message) || String(err)
  }
}

// How a joined session's connection can end and be taken up again (the
// network, the host's Tessel or this one restarting); any other end is final.
const RECONNECT_REASONS = new Set(['closed', 'error', 'timeout', 'unreachable', 'restarting', 'slow', 'busy'])
const RECONNECT_FOR_MS = 3 * 60 * 1000
const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 8000, 10000]
const KEEP_FRESH_MS = 60000

// deps: ipcMain, send(channel, payload) to the window, host (the terminal
// host client), dataDir (cloudflared goes in its bin folder, the sessions
// kept across a restart in its files), queueData(id, data) and sendExit(id,
// exitCode) (the window's own pty:data / pty:exit), log. queryPath, kill,
// pidRunning: the process helpers (tests give their own). resume: take back a share or
// a session at once (Tessel calls resume() itself, once it is the only copy
// running: a second copy starting must not take them).
export function registerLiveShare({ ipcMain, send, host, dataDir, queueData, sendExit, log, queryPath = processPath, kill = (pid) => process.kill(pid), pidRunning = pidAlive, resume = true }) {
  const info = (msg) => log?.info?.('liveshare', msg)
  const hostFile = createSessionFile(join(dataDir, 'liveshare-host.json'))
  const guestFile = createSessionFile(join(dataDir, 'liveshare-guest.json'))
  let suspended = false

  // --- Host --------------------------------------------------------------
  let sharing = null // { state, server, tunnel: { url, pid, stop }, secret, invite, guests, hostName, port, progress, error, blocked }
  let layout = null // cleaned, from the window (liveShare:layout)
  let shared = new Set() // its terminal panes: what guests may see
  let sharedProjectId = null // the project shared (the window's id), kept across a restart
  const sizes = new Map() // pane id -> { cols, rows }, of every terminal
  const asks = new Map() // guest id -> resolve(yes)
  let changedTimer = null
  let hostTimer = null // keeps the saved share fresh, watches an adopted tunnel

  const hostStatus = () =>
    sharing
      ? {
          state: sharing.state,
          invite: sharing.state === 'sharing' ? sharing.invite : null,
          expiresAt: sharing.state === 'sharing' ? sharing.server?.inviteExpires() || null : null,
          inviteBlocked: !!(sharing.server && sharing.server.inviteBlocked && sharing.server.inviteBlocked()),
          projectId: sharedProjectId,
          guests: sharing.guests,
          // Guests let in who are not connected now (they come back by
          // themselves; Remove keeps them out).
          offline: sharing.server && sharing.server.offlineGuests ? sharing.server.offlineGuests() : [],
          progress: sharing.progress ?? null,
          error: sharing.error || null
        }
      : { state: 'off', invite: null, expiresAt: null, inviteBlocked: false, projectId: null, guests: [], offline: [], progress: null, error: null }
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

  // What the next Tessel needs to take this share back after a restart.
  function saveHost() {
    const s = sharing
    if (!s || s.state !== 'sharing' || !s.tunnel || !s.server) return
    hostFile.write({
      secret: Buffer.from(s.secret).toString('base64'),
      url: s.tunnel.url,
      port: s.port,
      pid: s.tunnel.pid || 0,
      hostName: s.hostName,
      hostKey: exportSigningKey(s.hostKey),
      expiresAt: s.server.inviteExpires(),
      projectId: sharedProjectId,
      known: s.server.knownGuests(),
      secrets: s.server.earlierSecrets().map((x) => Buffer.from(x).toString('base64')),
      guard: s.server.guardState()
    })
  }

  function makeServer(s, secret, extra = {}) {
    return createShareHost({
      secret,
      hostName: s.hostName,
      hostKey: s.hostKey,
      log: info,
      ...extra,
      callbacks: {
        listPanes: sharedPanes,
        isShared: (id) => shared.has(id),
        layout: () => layout,
        snapshot,
        write: (id, data) => host.send('write', { id, data }),
        openPane: (spec, guest) => send('liveShare:hostRequest', { action: 'open', spec, guest }),
        closePane: (id, guest) => send('liveShare:hostRequest', { action: 'close', id, guest }),
        askApproval: (guest) =>
          new Promise((resolve) => {
            asks.set(guest.id, resolve)
            send('liveShare:ask', { guestId: guest.id, name: guest.name, code: guest.code || null })
          }),
        onGuests: (list) => {
          s.guests = list
          for (const id of [...asks.keys()]) if (!list.some((g) => g.id === id && g.state === 'waiting')) asks.delete(id)
          pushHost()
        },
        onInviteBlocked: () => {
          info('invite code blocked: too many connections stopped after the handshake')
          saveHost()
          pushHost()
        },
        onKnownChanged: () => {
          saveHost()
          pushHost()
        }
      }
    })
  }

  // Stop sharing (or quitting: now, nothing waited for). A share being taken
  // back after a restart is stopped too (stopRun).
  function stopSharing(reason = 'stopped', error = null, { now = false } = {}) {
    stopRun++
    const s = sharing
    if (!s) return
    s.cancelled = true
    clearInterval(hostTimer)
    hostTimer = null
    try {
      s.server?.stop(reason)
    } catch {
      /* already stopped */
    }
    try {
      if (now && s.tunnel?.stopNow) s.tunnel.stopNow()
      else s.tunnel?.stop()
    } catch {
      /* already stopped */
    }
    for (const resolve of asks.values()) resolve(false)
    asks.clear()
    hostFile.clear()
    sharedProjectId = null
    sharing = error ? { state: 'error', error, guests: [] } : null
    info(`sharing stopped (${reason})`)
    pushHost()
    if (error) sharing = null
  }

  // While sharing: the saved share kept fresh; a tunnel taken back after a
  // restart (not this Tessel's child) watched by its PID (cheap: its program
  // was checked when it was taken back).
  function watchHost(s) {
    clearInterval(hostTimer)
    hostTimer = setInterval(() => {
      if (sharing !== s) return
      if (s.adopted && !pidRunning(s.tunnel.pid)) {
        stopSharing('tunnel', t('main.liveShare.tunnelGone', 'The Cloudflare tunnel stopped. Sharing ended.'))
        return
      }
      saveHost()
    }, KEEP_FRESH_MS)
    hostTimer.unref?.()
  }

  async function startSharing({ name } = {}) {
    if (sharing && sharing.state !== 'error') return { ok: true, ...hostStatus() }
    const s = { state: 'preparing', guests: [], progress: null, cancelled: false, hostName: str(name, 40) || defaultShareName(), hostKey: newSigningKey() }
    sharing = s
    pushHost()
    try {
      // A tunnel left running by a Tessel that did not take its share back.
      await endLeftoverTunnel(dataDir, { queryPath, kill }).catch(() => false)
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
      s.secret = newSecret()
      s.server = makeServer(s, s.secret)
      s.port = await s.server.start()
      if (s.cancelled) return { ok: false }
      s.tunnel = await startTunnel({
        exe,
        port: s.port,
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
      if (!(await waitReachable(s.tunnel.url, { cancelled: () => s.cancelled }))) {
        if (s.cancelled) return { ok: false }
        throw new Error(t('main.liveShare.unreachable', 'The tunnel address could not be reached. Check your internet connection and try again.'))
      }
      if (s.cancelled) return { ok: false }
      s.invite = encodeInvite({ url: s.tunnel.url, secret: s.secret })
      s.state = 'sharing'
      info(`sharing at ${s.tunnel.url}`)
      saveHost()
      watchHost(s)
      pushHost()
      return { ok: true, ...hostStatus() }
    } catch (err) {
      const message = tunnelErrorText(err)
      if (sharing === s) stopSharing('error', message)
      return { ok: false, error: message }
    }
  }

  // After a restart: the share the last Tessel left (its tunnel still runs,
  // with the same address), taken back with the same invite code, its keys,
  // its earlier secrets, its block and the guests it let in. Guests reconnect
  // by themselves. Anything missing (too old, the tunnel gone or not ours,
  // its port taken): no share, and a tunnel left running is ended (only if it
  // is still this cloudflared). Stop sharing or quitting meanwhile (stopRun)
  // ends it too; another taking-back or a suspend meanwhile (resumeRun) only
  // lets it go, the tunnel and the saved share kept.
  let resumeRun = 0
  let stopRun = 0
  async function resumeSharing() {
    const run = ++resumeRun
    const stops = stopRun
    const saved = hostFile.read()
    if (!saved) {
      await endLeftoverTunnel(dataDir, { queryPath, kill }).catch(() => false)
      return false
    }
    const pid = Number(saved.pid) || 0
    // Ended for good: the tunnel (if still ours) and the saved share (if it is
    // still this one: a new share may have saved its own meanwhile).
    const fail = async (why) => {
      info(`share not taken back: ${why}`)
      if (pid) await stopTunnelPid(dataDir, pid, { queryPath, kill }).catch(() => false)
      hostFile.clearIf((x) => x && Number(x.pid) === pid && x.url === saved.url)
      return false
    }
    // Still the one to take it back? Stopped meanwhile: ended; superseded or
    // suspended: let go quietly.
    const check = () => {
      if (stopRun !== stops) return 'stopped'
      if (run !== resumeRun || suspended || sharing) return 'superseded'
      return 'ok'
    }
    // Is that PID still this cloudflared? Windows may not say at once.
    let state = 'unknown'
    for (let i = 0; i < 3 && state === 'unknown'; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500))
      state = await tunnelState(pid, { exe: cloudflaredPath(dataDir), queryPath })
    }
    if (check() === 'stopped') return fail('stopped meanwhile')
    if (check() !== 'ok') return false
    if (state === 'gone' || state === 'other' || (state === 'unknown' && !pidRunning(pid))) return fail('its tunnel stopped')
    let secret
    let hostKey
    try {
      secret = Buffer.from(String(saved.secret), 'base64')
      hostKey = importSigningKey(saved.hostKey)
    } catch {
      return fail('unreadable')
    }
    if (secret.length !== 32 || !hostKey || !/^wss?:\/\//.test(String(saved.url)) || !(saved.port > 0)) return fail('unreadable')
    const earlier = (Array.isArray(saved.secrets) ? saved.secrets : []).map((x) => Buffer.from(String(x), 'base64')).filter((x) => x.length === 32)
    const s = { state: 'starting', guests: [], progress: null, cancelled: false, hostName: str(saved.hostName, 40) || defaultShareName(), secret, hostKey, adopted: true }
    const server = makeServer(s, secret, { known: saved.known, secrets: earlier, guard: saved.guard, inviteExpires: Number(saved.expiresAt) || undefined })
    s.server = server
    // Its port: the last Tessel may take a moment to let it go.
    let port = 0
    for (let i = 0; i < 6 && !port && check() === 'ok'; i++) {
      try {
        port = await server.start(saved.port)
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (check() !== 'ok' || !port) {
      try {
        server.stop('stopped')
      } catch {
        /* not started */
      }
      if (check() === 'superseded') return false
      return fail(port ? 'stopped meanwhile' : `port ${saved.port} taken`)
    }
    s.port = port
    s.tunnel = {
      url: String(saved.url),
      pid,
      // Stop sharing: only while it is still this cloudflared.
      stop: () => stopTunnelPid(dataDir, pid, { queryPath, kill }).catch(() => false),
      // Quitting (nothing can be waited for): its program was checked when it
      // was taken back; only while that PID still runs.
      stopNow: () => {
        if (state === 'ours' && pidRunning(pid)) {
          try {
            kill(pid)
          } catch {
            /* already stopped */
          }
        }
      }
    }
    s.invite = encodeInvite({ url: s.tunnel.url, secret })
    sharedProjectId = typeof saved.projectId === 'string' ? saved.projectId.slice(0, 80) : null
    s.state = 'sharing'
    sharing = s
    info(`sharing taken back after a restart (${s.tunnel.url})`)
    saveHost()
    watchHost(s)
    pushHost()
    return true
  }

  // A new invite code: the old one stops letting anyone in (guests already
  // in stay, guests waiting under it are turned away); good for an hour.
  function newInvite() {
    const s = sharing
    if (!s || s.state !== 'sharing' || !s.server || !s.tunnel) return { ok: false }
    s.secret = newSecret()
    s.server.rotate(s.secret)
    s.invite = encodeInvite({ url: s.tunnel.url, secret: s.secret })
    info('new invite code')
    saveHost()
    pushHost()
    return { ok: true, ...hostStatus() }
  }

  // --- Guest -------------------------------------------------------------
  // joined: { client, session, host, state, panes: Map(remoteId -> pane),
  // byLocal, layout, rights, code, url, secret, invite, name, signingKey
  // (this guest's reconnect key), admitted, leaving, retry: { timer, since,
  // tries } }
  let joined = null
  let sessions = 0
  let guestTimer = null

  const guestPanesList = (g) =>
    [...g.panes.values()].map((p) => ({ id: p.localId, title: p.title, kind: p.kind, agentId: p.agentId, accent: p.accent, cols: p.cols, rows: p.rows, gen: p.gen }))
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
          // What the host lets this guest do, and the code to tell the host.
          rights: joined.rights,
          code: joined.code
        }
      : { state: 'off', host: null, session: null, panes: [], layout: null, reason: null, rights: null, code: null }
  const pushGuest = () => send('liveShare:guest', guestStatus())

  function saveGuest(g) {
    if (joined !== g || !g.admitted || !g.hostKey) return
    guestFile.write({ invite: g.invite, name: g.name, key: exportSigningKey(g.signingKey), hostKey: g.hostKey.toString('base64') })
  }

  // A pane whose terminal starts again here (the host restarted it, or the
  // connection came back): its next screen is waited for, and the window
  // opens its terminal anew (gen).
  function resetPane(pane) {
    pane.ready = false
    pane.fresh = false
    pane.attached = false
    pane.screen = ''
    pane.exited = false
    pane.exitCode = null
    pane.gen = (pane.gen || 0) + 1
  }

  function onPanes(g, panes, rawLayout) {
    const seen = new Set()
    for (const p of panes.slice(0, LAYOUT_PANES)) {
      if (!p || typeof p.id !== 'string' || !/^[\w-]{1,80}$/.test(p.id)) continue
      seen.add(p.id)
      let pane = g.panes.get(p.id)
      if (!pane) {
        pane = { remoteId: p.id, localId: guestPaneId(g.session, p.id), screen: '', ready: false, fresh: false, attached: false, exited: false, exitCode: null, waiters: [], gen: 0 }
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

  function endGuest(g, reason) {
    if (joined !== g) return
    clearTimeout(g.retry && g.retry.timer)
    clearInterval(guestTimer)
    guestTimer = null
    g.state = 'ended'
    g.reason = reason
    for (const pane of g.panes.values()) for (const w of pane.waiters.splice(0)) w(false)
    guestFile.clear()
    info(`left the session of ${g.host || '?'} (${reason})`)
    pushGuest()
    joined = null
  }

  // The connection dropped: taken up again with the reconnect key, every few
  // seconds for 3 minutes; the Live Share project stays meanwhile.
  function reconnectLater(g) {
    if (joined !== g) return
    const r = g.retry || (g.retry = { since: Date.now(), tries: 0, timer: null })
    if (Date.now() - r.since > RECONNECT_FOR_MS) return endGuest(g, 'lost')
    const delay = RECONNECT_DELAYS[Math.min(r.tries, RECONNECT_DELAYS.length - 1)]
    r.tries++
    clearTimeout(r.timer)
    r.timer = setTimeout(() => {
      if (joined === g && g.state === 'reconnecting') connectGuest(g)
    }, delay)
  }

  function connectGuest(g) {
    const client = createShareGuest({
      url: g.url,
      secret: g.secret,
      name: g.name,
      signingKey: g.signingKey,
      back: g.admitted,
      hostKey: g.hostKey,
      callbacks: {
        onHostKey: (key) => {
          if (joined === g && g.client === client) g.hostKey = key
        },
        onState: (state, extra) => {
          if (joined !== g || g.client !== client) return
          if (extra?.host) g.host = str(extra.host, 40)
          if (extra?.code) g.code = str(extra.code, 12)
          // Back in: every pane's screen comes again.
          if (state === 'joined' && g.admitted) for (const pane of g.panes.values()) resetPane(pane)
          if (state === 'joined') {
            g.admitted = true
            g.retry = null
            g.reason = null
            saveGuest(g)
          }
          // While reconnecting, the handshake's steps are not shown.
          if (g.state === 'reconnecting' && state !== 'joined') return
          g.state = state
          pushGuest()
        },
        onRights: (rights) => {
          if (joined !== g || g.client !== client || !rights) return
          g.rights = cleanRights(rights)
          pushGuest()
        },
        onNotice: (code) => joined === g && g.client === client && send('liveShare:notice', { code: str(code, 40) }),
        onPanes: (panes, rawLayout) => joined === g && g.client === client && onPanes(g, panes, rawLayout),
        onSnapshot: (remoteId, data, cols, rows) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.screen = data
          if (cols > 0 && rows > 0) {
            pane.cols = cols
            pane.rows = rows
          }
          pane.ready = true
          pane.fresh = true
          for (const w of pane.waiters.splice(0)) w(true)
        },
        onData: (remoteId, data) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          if (pane.attached) queueData(pane.localId, data)
          else pane.screen = trimBuffer(pane.screen + data, HOST_BUFFER_BYTES)
        },
        onExit: (remoteId, exitCode) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.exited = true
          pane.exitCode = exitCode
          if (pane.attached) sendExit(pane.localId, exitCode)
        },
        onRestart: (remoteId) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          resetPane(pane)
          pushGuest()
        },
        onClosed: (reason) => {
          if (joined !== g || g.client !== client) return
          if (!g.leaving && g.admitted && RECONNECT_REASONS.has(reason)) {
            if (g.state !== 'reconnecting') info(`connection to ${g.host || '?'} lost (${reason}): reconnecting`)
            g.state = 'reconnecting'
            g.reason = reason
            pushGuest()
            reconnectLater(g)
            return
          }
          endGuest(g, reason)
        }
      }
    })
    g.client = client
    client.connect()
  }

  function joinSession({ invite, name, signingKey = null, hostKey = null } = {}) {
    const code = decodeInvite(invite)
    if (!code) return { ok: false, error: t('main.liveShare.badInvite', 'This is not a Tessel Live Share invite code.') }
    if (joined) leaveSession('replaced')
    const g = {
      session: ++sessions,
      host: null,
      state: 'connecting',
      panes: new Map(),
      byLocal: new Map(),
      layout: null,
      reason: null,
      client: null,
      rights: null,
      code: null,
      url: code.url,
      secret: code.secret,
      invite: String(invite).trim(),
      name: str(name, 40) || defaultShareName(),
      // This guest's reconnect key: made now, or the one of a session taken
      // back after a restart (as good as admitted: a refused key ends it).
      signingKey: signingKey || newSigningKey(),
      // The host's key (from its first welcome): a returning guest checks the
      // host signs with it.
      hostKey: signingKey ? hostKey : null,
      admitted: !!(signingKey && hostKey),
      leaving: false,
      retry: null
    }
    joined = g
    connectGuest(g)
    clearInterval(guestTimer)
    guestTimer = setInterval(() => saveGuest(g), KEEP_FRESH_MS)
    guestTimer.unref?.()
    pushGuest()
    return { ok: true }
  }

  function leaveSession(reason = 'left') {
    const g = joined
    if (!g) return
    g.leaving = true
    g.reason = reason
    clearTimeout(g.retry && g.retry.timer)
    g.client.leave() // -> onClosed: the window closes the Live Share project
    if (joined === g) endGuest(g, reason)
  }

  // After a restart of this Tessel: the session it was in, joined again with
  // its reconnect key (no new question for the host).
  function resumeGuest(stops = stopRun) {
    // Quitting meanwhile (stopAll): not joined again, and nothing to take back.
    if (stopRun !== stops) {
      guestFile.clear()
      return false
    }
    const saved = guestFile.read()
    const signingKey = saved && typeof saved.invite === 'string' ? importSigningKey(saved.key) : null
    const hostKey = saved && typeof saved.hostKey === 'string' ? Buffer.from(saved.hostKey, 'base64') : null
    if (!signingKey || !hostKey || hostKey.length !== 32 || suspended || joined) {
      if (!joined) guestFile.clear()
      return false
    }
    info('joining again the session left by a restart')
    return joinSession({ invite: saved.invite, name: saved.name, signingKey, hostKey }).ok
  }

  // --- The window's pty calls for a guest pane ----------------------------
  const isGuestPane = (id) => !!(joined && joined.byLocal.has(id))

  // A pane's terminal opening here: the screen that came for it. One already
  // shown (this window reloaded): the host sends it again (resync).
  async function guestAttach(id) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane) return { ok: false }
    if (pane.ready && !pane.fresh && g.state === 'joined') {
      pane.ready = false
      pane.attached = false
      pane.screen = ''
      g.client.resync(pane.remoteId)
    }
    if (!pane.ready) {
      const ok = await new Promise((resolve) => {
        pane.waiters.push(resolve)
        setTimeout(() => resolve(false), ATTACH_WAIT_MS)
      })
      if (!ok || joined !== g || !g.byLocal.has(id)) return { ok: false }
    }
    const buffer = pane.screen
    pane.screen = ''
    pane.fresh = false
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

  // Typing, opening and closing need the host's yes (the host checks too),
  // and a connection.
  const may = (g, right) => g.state === 'joined' && (!g.rights || g.rights[right])

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
    if (may(g, 'close')) g.client.close(pane.remoteId)
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
    const before = shared
    shared = new Set(layoutLeaves(layout).filter((l) => l.view === 'terminal').map((l) => l.id))
    // A pane taken out: nothing more of it goes out from now (shareHost
    // checks isShared), and guests drop it now rather than after the pause.
    if ([...before].some((id) => !shared.has(id)) && sharing?.server) {
      clearTimeout(changedTimer)
      changedTimer = null
      sharing.server.panesChanged()
    } else screenChanged()
  })
  // The project shared (the window's id): said again after a restart.
  ipcMain.on('liveShare:project', (_evt, id) => {
    const next = typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? id : null
    if (next === sharedProjectId) return
    sharedProjectId = next
    saveHost()
    pushHost()
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
  // A guest let in who is offline: it can't come back.
  ipcMain.handle('liveShare:removeKnown', (_evt, { id } = {}) => {
    const ok = !!sharing?.server?.removeKnown(String(id || ''))
    if (ok) pushHost()
    return { ok }
  })
  ipcMain.handle('liveShare:join', (_evt, opts) => joinSession({ invite: opts && opts.invite, name: opts && opts.name }))
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

  // A share or a session the last Tessel left (a restart, an update, a
  // crash): taken back, once.
  let resumed = null
  const takeBack = () => {
    if (resumed) return resumed
    const stops = stopRun
    resumed = Promise.all([resumeSharing().catch(() => false), Promise.resolve().then(() => resumeGuest(stops)).catch(() => false)])
    return resumed
  }
  if (resume) takeBack()

  return {
    get resumed() {
      return resumed || Promise.resolve([false, false])
    },
    resume: takeBack,
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
    // A terminal started under this id (a new pane, or one restarted in
    // place): guests that had it get its new screen.
    paneStarted: (id) => sharing?.server?.paneRestarted(id),
    forgetPane: (id) => sizes.delete(id),
    // Guest panes (the host's, shown here).
    isGuestPane,
    guestAttach,
    guestWrite,
    guestKill,
    // Tessel restarting on purpose (an update): the share and the session
    // carry on with the next Tessel (guests are told to reconnect; the
    // tunnel keeps running); nothing is ended.
    suspend() {
      if (suspended) return
      suspended = true
      const s = sharing
      if (s && s.state === 'sharing') {
        saveHost()
        clearInterval(hostTimer)
        try {
          s.server?.stop('restarting')
        } catch {
          /* already stopped */
        }
        sharing = null
        info('sharing kept for the next Tessel')
      } else if (s) stopSharing('stopped')
      // (A share still being taken back lets go by itself: suspended.)
      const g = joined
      if (g && g.admitted) {
        saveGuest(g)
        clearTimeout(g.retry && g.retry.timer)
        clearInterval(guestTimer)
        g.leaving = true
        joined = null
        g.client.disconnect()
      } else leaveSession('left')
    },
    // The update did not install after all: this Tessel carries on, and
    // takes the share and the session back at once.
    unsuspend() {
      if (!suspended) return
      suspended = false
      const stops = stopRun
      resumeSharing().catch(() => false)
      Promise.resolve()
        .then(() => resumeGuest(stops))
        .catch(() => false)
    },
    // Quitting Tessel: the share and the session end.
    stopAll() {
      if (suspended) return
      // Quitting: nothing can be waited for (a tunnel taken back is stopped
      // at once), and a session not yet joined again never will be.
      stopSharing('stopped', null, { now: true })
      stopRun++
      leaveSession('left')
    }
  }
}
