// Live Share, host side: the share server guests connect to.
//
// It listens on 127.0.0.1 only (the Cloudflare tunnel, shareTunnel.js, is
// what reaches it from outside), and refuses browsers (any Origin header). A
// connection first runs the handshake of shareCrypto.js in clear (the
// guest's commitment, the host's nonce and X25519 key, the guest's), then
// everything is sealed with keys derived from them and the invite's secret:
// a guest without the invite code is dropped at its first message. A guest
// with it still waits until the host says yes (askApproval) to that guest
// (its id, and the verification code both sides show), and the host can
// remove any guest at any time. After a no (or a guest who left while
// waiting, or one removed), new guests wait a while before they can ask
// again. An invite code works for an hour; rotate() makes a new one, and
// guests not in yet under the old one are turned away. Connections that stop
// after the handshake without joining are counted: past a few, the code
// stops working (onInviteBlocked), since someone in the middle could be
// trying to make the verification codes match.
//
// A guest let in gets a reconnect key (welcome's token). When its connection
// drops (its network, its Tessel or this one restarting), it comes back with
// that key and is in again at once, with the rights it had: no new question.
// The keys (their hashes, the names, the rights) survive a restart of this
// Tessel (knownGuests, given back to createShareHost). A guest who leaves or
// is removed loses its key.
//
// Once in, a guest sees the host's screen: the layout of the project shared
// (layout: splits, sizes, the active and fullscreen pane), and each of its
// terminals and agents (listPanes) live: the screen as it is (no scrollback),
// then its output as it comes. A guest starts view only: the host gives each
// one the right to type in those panes, to open terminals and agents (a few
// a minute), and to ask to close panes (setRights). What a guest's terminal
// answers by itself to a program's questions (cursor position, colours...)
// is never typed in the host's: the host's own terminal answers.
//
// Tessel itself is reached only through the callbacks below, so this file
// runs (and is tested) without Electron.
import crypto from 'crypto'
import { WebSocketServer } from 'ws'
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, commitmentMatches, NONCE_BYTES, COMMIT_BYTES } from './shareCrypto.js'

// 2: the guest commits first (shareCrypto.js). A Tessel with protocol 1
// (no commitment) is told it is out of date.
export const SHARE_PROTOCOL = 2
const MAX_GUESTS = 10
const MAX_WAITING = 3 // guests waiting for the host's answer at once
const MAX_FRAME = 1024 * 1024 // a guest's message (typing, a paste)
const MAX_WRITE = 256 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024 // a guest this far behind is dropped
const HANDSHAKE_MS = 15000
const PING_MS = 25000 // Cloudflare closes a WebSocket idle for 100 s
const FLUSH_MS = 8
export const INVITE_TTL_MS = 60 * 60 * 1000
// After a no: new guests wait 15 s, doubled by each no of the last 10 min,
// up to 5 min.
const DENY_WAIT_MS = 15000
const DENY_WAIT_MAX_MS = 5 * 60 * 1000
const DENY_MEMORY_MS = 10 * 60 * 1000
// What one guest may ask in a minute, and in all.
const OPENS_PER_MINUTE = 3
const OPENS_IN_ALL = 12
const CLOSES_PER_MINUTE = 6
const RESYNCS_PER_MINUTE = 30
// Connections that stopped after the handshake without joining, in 10 min,
// before the invite code is blocked.
const UNFINISHED_MAX = 8
const UNFINISHED_MEMORY_MS = 10 * 60 * 1000
// How a connection the guest's side stopped ends (not the host's doing).
const EARLY_STOPS = new Set(['closed', 'timeout', 'refused', 'protocol'])
// WebSocket close codes a guest reads as a reason (shareGuest.js).
export const CLOSE_EXPIRED = 4001
export const CLOSE_BUSY = 4002
export const CLOSE_OUTDATED = 4003

export const NO_RIGHTS = Object.freeze({ type: false, open: false, close: false })
export const cleanRights = (r) => ({ type: !!(r && r.type), open: !!(r && r.open), close: !!(r && r.close) })

// A guest's name as given ('' when none: the window says "A guest").
export const cleanName = (name) =>
  String(name || '')
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)

// What a terminal sends by itself when a program asks (xterm's reports), not
// what someone types: the cursor position, the terminal's identity and
// version, mode and status reports, colour and window answers, focus in and
// out. A guest's terminal answers too: dropped, the host's answers already.
/* eslint-disable no-control-regex -- terminal escape sequences */
const TERMINAL_REPLIES = [
  /\x1b\[\d+;\d+R/g, // cursor position (also Shift+F3 and the like: not sent)
  /\x1b\[[?>][\d;]*c/g, // device attributes
  /\x1b\[[03]n/g, // status
  /\x1b\[\??[\d;]*\$y/g, // mode reports
  /\x1b\[\?\d*u/g, // keyboard protocol flags
  /\x1b\[\d+;\d+;\d+t/g, // window size reports
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC answers (colours)
  /\x1bP[^\x1b]*\x1b\\/g // DCS answers (version, settings)
]
/* eslint-enable no-control-regex */
export function stripTerminalReplies(data) {
  let out = String(data || '')
  for (const re of TERMINAL_REPLIES) out = out.replace(re, '')
  return out
}

// callbacks:
//   listPanes()            -> [{ id, title, kind, cols, rows }]
//   isShared(id)           -> whether a pane is shared right now (optional:
//                             listPanes otherwise); checked for every output,
//                             screen and exit, so a pane taken out of the
//                             shared project sends nothing more at once
//   layout()               -> what the host's window shares (sent as is)
//   snapshot(id, ready)    -> Promise<{ data, cols, rows } | null>, then live
//                             output comes through sendData (see subscribe);
//                             data may be a Promise of the text
//   write(id, data)
//   openPane(spec, guest)  -> spec: { kind: 'terminal' | 'agent', agent? }
//   closePane(id, guest)
//   askApproval(guest)     -> Promise<boolean>; guest: { id, name, code }
//   onGuests(list)         -> the guest list changed
//   onInviteBlocked()      -> too many connections stopped after the
//                             handshake: the code lets no one in until rotate()
//   onKnownChanged()       -> the reconnect keys changed (knownGuests())
// known: the reconnect keys of a share taken back after a restart;
// inviteExpires: that share's invite code's end.
export function createShareHost({ secret, hostName, callbacks, log = () => {}, now = Date.now, known = [], inviteExpires: expiresAt = null }) {
  const guests = new Map() // id -> guest
  let wss = null
  let pingTimer = null
  let nextGuest = 1
  let stopped = false
  let inviteSecret = secret
  let inviteExpires = Number.isFinite(expiresAt) ? expiresAt : now() + INVITE_TTL_MS
  // Reconnect keys: sha256 of the token -> { name, rights }.
  const keys = new Map()
  for (const k of Array.isArray(known) ? known : []) {
    if (k && typeof k.hash === 'string' && /^[0-9a-f]{64}$/.test(k.hash)) keys.set(k.hash, { name: cleanName(k.name), rights: cleanRights(k.rights) })
  }
  const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
  const keysChanged = () => callbacks.onKnownChanged?.()
  let epoch = 0 // the invite code's: rotate() makes a new one
  let denials = [] // times of the host's no
  let waitUntil = 0
  let unfinished = [] // times of connections that stopped after the handshake
  let blocked = false

  const inHandshake = (g) => g.state === 'handshake' || g.state === 'committed' || g.state === 'secured'
  const publicGuest = (g) => ({ id: g.id, name: g.name, state: g.state, since: g.since, code: g.code, rights: { ...g.rights } })
  const notifyGuests = () => callbacks.onGuests?.([...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest))

  function send(g, message) {
    if (g.socket.readyState !== 1) return
    if (g.socket.bufferedAmount > MAX_BUFFERED) {
      drop(g, 'slow')
      return
    }
    g.socket.send(g.channel.seal(message))
  }

  function drop(g, reason) {
    if (!guests.has(g.id)) return
    guests.delete(g.id)
    clearTimeout(g.flushTimer)
    try {
      if (g.channel && g.socket.readyState === 1) g.socket.send(g.channel.seal({ t: 'bye', reason }))
    } catch {
      /* closing anyway */
    }
    try {
      g.socket.close(1000)
    } catch {
      /* already closed */
    }
    g.resolveApproval?.(false)
    // Past the host's values without joining, by its own doing: counted (see
    // onInviteBlocked).
    if ((g.state === 'committed' || g.state === 'secured') && EARLY_STOPS.has(reason)) stoppedEarly()
    // A guest who left while waiting, or one removed: new guests wait as
    // after a no (asking again and again costs something).
    if ((g.state === 'waiting' && (reason === 'left' || reason === 'closed')) || reason === 'removed') denied()
    // Left on purpose, or removed: its reconnect key goes with it.
    if (g.keyHash && (reason === 'left' || reason === 'removed') && keys.delete(g.keyHash)) keysChanged()
    if (!inHandshake(g)) log(`guest ${g.name || '?'} left (${reason})`)
    notifyGuests()
  }

  function stoppedEarly() {
    const t = now()
    unfinished = [...unfinished.filter((x) => t - x < UNFINISHED_MEMORY_MS), t]
    if (unfinished.length < UNFINISHED_MAX || blocked) return
    blocked = true
    log('invite code blocked: connections stopped after the handshake')
    callbacks.onInviteBlocked?.()
  }

  // Output waiting for a guest; a pane whose screen is still being prepared
  // (held) keeps its output until that screen went out first.
  function flush(g) {
    clearTimeout(g.flushTimer)
    g.flushTimer = null
    if (!guests.has(g.id)) return
    for (const [id, data] of [...g.pending]) {
      const sub = g.subscribed.get(id)
      if (sub && sub.held) continue
      g.pending.delete(id)
      if (sub && isShared(id)) send(g, { t: 'data', id, data })
      else forget(g, id)
    }
  }

  const sharedIds = () => new Set(callbacks.listPanes().map((p) => p.id))
  const isShared = (id) => (callbacks.isShared ? !!callbacks.isShared(id) : sharedIds().has(id))

  // A pane no longer shared: what was waiting for it goes, and its screen
  // is taken again if it comes back (a new subscription: what the old one
  // still had coming is ignored).
  function forget(g, id) {
    g.subscribed.delete(id)
    g.pending.delete(id)
  }

  // A pane's screen, then its output from there on. Output that came before
  // the snapshot is in it and is not sent again; output after it is. The
  // terminal host holds new output while it takes the snapshot, and its
  // answer and the output after it can arrive in one read: so the caller
  // calls ready(snapshot) the moment the answer is read (before that output
  // is passed on), or resolves snapshot()'s promise when order can't matter.
  // The screen's text can take a moment more (snap.data a promise): output
  // from then on waits for it (held), and so does the pane's exit.
  // Each subscription is its own object: a screen that comes back for one
  // already forgotten (the pane left the project, maybe came back) does
  // nothing.
  function subscribe(g, id) {
    if (g.subscribed.has(id)) return
    const sub = { state: 'loading', held: false, exit: undefined }
    g.subscribed.set(id, sub)
    const current = () => guests.has(g.id) && g.subscribed.get(id) === sub
    let done = false
    const ready = (snap) => {
      if (done) return
      done = true
      if (!current() || sub.state !== 'loading') return
      if (!isShared(id)) return forget(g, id)
      sub.state = 'live'
      const cols = snap?.cols || 0
      const rows = snap?.rows || 0
      const data = snap?.data
      if (!data || typeof data.then !== 'function') {
        send(g, { t: 'snapshot', id, data: typeof data === 'string' ? data : '', cols, rows })
        return
      }
      sub.held = true
      Promise.resolve(data)
        .catch(() => '')
        .then((text) => {
          if (!current() || !sub.held) return
          sub.held = false
          if (!isShared(id)) return forget(g, id)
          send(g, { t: 'snapshot', id, data: typeof text === 'string' ? text : '', cols, rows })
          const exit = sub.exit
          sub.exit = undefined
          flush(g)
          if (exit !== undefined) send(g, { t: 'exit', id, exitCode: exit })
        })
    }
    Promise.resolve()
      .then(() => callbacks.snapshot(id, ready))
      .then(ready, () => ready(null))
  }

  // In: a new guest gets its reconnect key; a returning one keeps its own.
  function welcome(g, back = false) {
    g.state = 'joined'
    g.since = now()
    let token
    if (!g.keyHash) {
      token = crypto.randomBytes(32).toString('base64url')
      g.keyHash = tokenHash(token)
    }
    keys.set(g.keyHash, { name: g.name, rights: { ...g.rights } })
    keysChanged()
    log(`guest ${g.name || '?'} ${back ? 'came back' : 'joined'}`)
    notifyGuests()
    const panes = callbacks.listPanes()
    send(g, { t: 'welcome', host: hostName, protocol: SHARE_PROTOCOL, panes, layout: callbacks.layout?.() || null, rights: { ...g.rights }, ...(token ? { token } : {}) })
    for (const p of panes) subscribe(g, p.id)
  }

  // A guest coming back with its reconnect key: in at once, as it was (the
  // connection it had, if any, ends). An unknown key: turned away, no question.
  function rejoin(g, token) {
    const hash = tokenHash(token)
    const known = keys.get(hash)
    if (!known) return drop(g, 'rejoin-refused')
    for (const other of [...guests.values()]) if (other !== g && other.keyHash === hash) drop(other, 'replaced')
    g.keyHash = hash
    g.name = known.name || cleanName(g.name)
    g.rights = { ...known.rights }
    welcome(g, true)
  }

  // The pane's screen again, then its output (a guest's window reloaded, a
  // pane restarted on the host).
  function resubscribe(g, id) {
    forget(g, id)
    subscribe(g, id)
  }

  function denied() {
    const t = now()
    denials = [...denials.filter((d) => t - d < DENY_MEMORY_MS), t]
    waitUntil = t + Math.min(DENY_WAIT_MAX_MS, DENY_WAIT_MS * 2 ** (denials.length - 1))
  }

  async function onJoin(g, msg) {
    g.name = cleanName(msg.name)
    if (typeof msg.token === 'string' && msg.token) return rejoin(g, msg.token.slice(0, 100))
    if (blocked || g.epoch !== epoch || now() > inviteExpires) return drop(g, 'expired')
    if (now() < waitUntil || [...guests.values()].filter((x) => x.state === 'waiting').length >= MAX_WAITING) return drop(g, 'busy')
    g.state = 'waiting'
    notifyGuests()
    send(g, { t: 'waiting' })
    const approved = await new Promise((resolve) => {
      g.resolveApproval = resolve
      Promise.resolve(callbacks.askApproval(publicGuest(g))).then(resolve, () => resolve(false))
    })
    g.resolveApproval = null
    if (!guests.has(g.id)) return
    if (!approved) {
      denied()
      drop(g, 'denied')
      return
    }
    welcome(g)
  }

  // Under its limit (times of its last asks, kept in `list`), or tells the
  // guest it asked too often.
  function allowed(g, list, perMinute, inAll = Infinity) {
    const t = now()
    const recent = list.filter((x) => t - x < 60000)
    list.splice(0, list.length, ...recent)
    if (recent.length >= perMinute || g.opened >= inAll) {
      send(g, { t: 'notice', code: 'limit' })
      return false
    }
    list.push(t)
    return true
  }

  function onMessage(g, msg) {
    if (!msg || typeof msg.t !== 'string') return drop(g, 'protocol')
    if (g.state === 'secured') {
      if (msg.t !== 'join') return drop(g, 'protocol')
      onJoin(g, msg)
      return
    }
    if (msg.t === 'leave') return drop(g, 'left')
    if (g.state !== 'joined') return
    switch (msg.t) {
      case 'resync':
        if (!isShared(msg.id) || !g.subscribed.has(msg.id)) return
        if (!allowed(g, g.resyncs, RESYNCS_PER_MINUTE)) return
        resubscribe(g, msg.id)
        return
      case 'write': {
        if (!g.rights.type || typeof msg.data !== 'string' || msg.data.length > MAX_WRITE || !isShared(msg.id)) return
        const data = stripTerminalReplies(msg.data)
        if (data) callbacks.write(msg.id, data)
        return
      }
      case 'open':
        if (!g.rights.open || !msg.spec || (msg.spec.kind !== 'terminal' && msg.spec.kind !== 'agent')) return
        if (!allowed(g, g.opens, OPENS_PER_MINUTE, OPENS_IN_ALL)) return
        g.opened++
        callbacks.openPane({ kind: msg.spec.kind, agent: typeof msg.spec.agent === 'string' ? msg.spec.agent.slice(0, 40) : undefined }, publicGuest(g))
        return
      case 'close':
        if (!g.rights.close || !isShared(msg.id)) return
        if (!allowed(g, g.closes, CLOSES_PER_MINUTE)) return
        callbacks.closePane(msg.id, publicGuest(g))
        return
      default:
        return
    }
  }

  // Guests not in yet when the code changed or expired: turned away.
  function dropNotJoined(reason) {
    for (const g of [...guests.values()]) if (g.state !== 'joined' && (g.epoch !== epoch || now() > inviteExpires || blocked)) drop(g, reason)
  }

  const parse = (data, isBinary) => {
    try {
      return isBinary ? null : JSON.parse(data.toString())
    } catch {
      return null
    }
  }

  function onConnection(socket) {
    if (stopped || guests.size >= MAX_GUESTS || now() < waitUntil) {
      socket.close(CLOSE_BUSY)
      return
    }
    // (An expired code still lets guests with a reconnect key back in: the
    // check is at join.)
    if (blocked) {
      socket.close(CLOSE_EXPIRED)
      return
    }
    const g = {
      id: `g${nextGuest++}`,
      name: '',
      state: 'handshake',
      epoch,
      socket,
      channel: null,
      code: null,
      rights: { ...NO_RIGHTS },
      subscribed: new Map(), // pane id -> { state: 'loading' | 'live', held, exit }
      pending: new Map(),
      flushTimer: null,
      since: 0,
      alive: true,
      opens: [],
      opened: 0,
      closes: [],
      resyncs: []
    }
    guests.set(g.id, g)
    const hostNonce = newNonce()
    const pair = newKeyPair()
    const secretNow = inviteSecret
    let commit = null
    const timer = setTimeout(() => {
      if (inHandshake(g)) drop(g, 'timeout')
    }, HANDSHAKE_MS)
    socket.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL }))
    socket.on('pong', () => (g.alive = true))
    socket.on('message', (data, isBinary) => {
      if (!guests.has(g.id)) return
      // 1. The guest's commitment; then the host's nonce and key.
      if (g.state === 'handshake') {
        const msg = parse(data, isBinary)
        // A Tessel with the first protocol sends its nonce right away.
        if (msg && msg.t === 'nonce') {
          socket.close(CLOSE_OUTDATED)
          return drop(g, 'outdated')
        }
        commit = msg && msg.t === 'commit' ? Buffer.from(String(msg.c || ''), 'base64') : null
        if (!commit || commit.length !== COMMIT_BYTES) return drop(g, 'protocol')
        g.state = 'committed'
        socket.send(JSON.stringify({ t: 'keys', n: hostNonce.toString('base64'), kx: pair.publicRaw.toString('base64') }))
        return
      }
      // 2. The guest's nonce and key, as committed.
      if (g.state === 'committed') {
        const msg = parse(data, isBinary)
        const guestNonce = msg && msg.t === 'reveal' ? Buffer.from(String(msg.n || ''), 'base64') : null
        const guestKey = msg && msg.t === 'reveal' ? Buffer.from(String(msg.kx || ''), 'base64') : null
        if (!guestNonce || guestNonce.length !== NONCE_BYTES || !commitmentMatches(commit, guestNonce, guestKey)) return drop(g, 'protocol')
        const dh = sharedSecret(pair.privateKey, guestKey)
        if (!dh) return drop(g, 'protocol')
        const session = sessionKeys(secretNow, hostNonce, guestNonce, 'host', { dh, hostKey: pair.publicRaw, guestKey })
        g.channel = createChannel(session)
        g.code = session.code
        g.state = 'secured'
        return
      }
      if (!isBinary) return drop(g, 'protocol')
      const msg = g.channel.open(data)
      if (!msg) return drop(g, 'refused') // not sealed with the invite's secret
      if (g.state === 'secured') clearTimeout(timer)
      onMessage(g, msg)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      drop(g, 'closed')
    })
    socket.on('error', () => {})
  }

  return {
    // Listens on 127.0.0.1 (port 0: any free port). Resolves the port.
    start(port = 0) {
      return new Promise((resolve, reject) => {
        wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          maxPayload: MAX_FRAME,
          perMessageDeflate: false,
          // Tessel never sends an Origin; a web page always does.
          verifyClient: ({ req }) => !req.headers.origin
        })
        wss.once('error', reject)
        wss.once('listening', () => {
          wss.off('error', reject)
          wss.on('error', (err) => log(`share server: ${err.message}`))
          resolve(wss.address().port)
        })
        wss.on('connection', onConnection)
        // A guest that did not answer the last ping is gone (a dead tunnel
        // or computer): dropped.
        pingTimer = setInterval(() => {
          // An expired code: guests still waiting under it are turned away.
          if (now() > inviteExpires) dropNotJoined('expired')
          for (const g of [...guests.values()]) {
            if (!guests.has(g.id)) continue
            if (!g.alive) {
              drop(g, 'timeout')
              continue
            }
            g.alive = false
            try {
              g.socket.ping()
            } catch {
              /* closes by itself */
            }
          }
        }, PING_MS)
      })
    },
    stop(reason = 'stopped') {
      stopped = true
      clearInterval(pingTimer)
      for (const g of [...guests.values()]) drop(g, reason)
      try {
        wss?.close()
      } catch {
        /* already closed */
      }
      wss = null
    },
    // Output of a pane, as the terminal host sends it (not batched yet: a
    // guest whose snapshot is being taken must skip exactly what came before
    // it), to every guest that has the pane; sent in batches.
    sendData(id, data) {
      if (!isShared(id)) return
      for (const g of guests.values()) {
        if (g.state !== 'joined' || g.subscribed.get(id)?.state !== 'live') continue
        g.pending.set(id, (g.pending.get(id) || '') + data)
        if (!g.flushTimer) g.flushTimer = setTimeout(() => flush(g), FLUSH_MS)
      }
    },
    sendExit(id, exitCode) {
      if (!isShared(id)) return
      for (const g of guests.values()) {
        const sub = g.subscribed.get(id)
        if (g.state !== 'joined' || !sub) continue
        if (sub.held) {
          sub.exit = exitCode
          continue
        }
        flush(g)
        send(g, { t: 'exit', id, exitCode })
      }
    },
    // The host's screen changed (a pane opened, closed, renamed or resized,
    // another project shared, the layout changed).
    panesChanged() {
      const panes = callbacks.listPanes()
      const layout = callbacks.layout?.() || null
      const ids = new Set(panes.map((p) => p.id))
      for (const g of guests.values()) {
        if (g.state !== 'joined') continue
        for (const id of [...g.subscribed.keys()]) if (!ids.has(id)) forget(g, id)
        send(g, { t: 'panes', panes, layout })
        for (const p of panes) subscribe(g, p.id)
      }
    },
    approve(guestId, yes) {
      guests.get(guestId)?.resolveApproval?.(!!yes)
    },
    // A pane restarted on the host (same id, a new terminal): guests are told,
    // then get its new screen.
    paneRestarted(id) {
      if (!isShared(id)) return
      for (const g of guests.values()) {
        if (g.state !== 'joined' || !g.subscribed.has(id)) continue
        flush(g)
        send(g, { t: 'restart', id })
        resubscribe(g, id)
      }
    },
    // What a guest may do (type, open, close); it is told.
    setRights(guestId, rights) {
      const g = guests.get(guestId)
      if (!g || g.state !== 'joined') return false
      g.rights = cleanRights(rights)
      if (g.keyHash && keys.has(g.keyHash)) {
        keys.set(g.keyHash, { name: g.name, rights: { ...g.rights } })
        keysChanged()
      }
      send(g, { t: 'rights', rights: { ...g.rights } })
      log(`guest ${g.name || '?'} may ${Object.keys(g.rights).filter((k) => g.rights[k]).join(', ') || 'only watch'}`)
      notifyGuests()
      return true
    },
    removeGuest(guestId) {
      const g = guests.get(guestId)
      if (g) drop(g, 'removed')
    },
    // A new invite code's secret: the old code stops letting anyone in, and
    // guests not in yet under it (waiting for your answer, or connecting)
    // are turned away; guests already in stay. Good for INVITE_TTL_MS from
    // now, and unblocks a blocked code.
    rotate(newSecret) {
      inviteSecret = newSecret
      inviteExpires = now() + INVITE_TTL_MS
      epoch++
      blocked = false
      unfinished = []
      dropNotJoined('expired')
      return inviteExpires
    },
    inviteExpires: () => inviteExpires,
    inviteBlocked: () => blocked,
    // The reconnect keys, to keep across a restart of this Tessel.
    knownGuests: () => [...keys].map(([hash, k]) => ({ hash, name: k.name, rights: { ...k.rights } })),
    guests: () => [...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest)
  }
}
