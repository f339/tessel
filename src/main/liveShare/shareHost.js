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
// guests not in yet under the old one are turned away. Every connection that
// got the host's keys and never got in is counted, whatever its way out:
// past a few, the code lets no new guest in (onInviteBlocked), since someone
// in the middle could be trying to make the verification codes match; and
// handshakes are limited to a few a minute.
//
// A guest let in made a reconnect key of its own (Ed25519) and gave its
// public half when it joined. When its connection drops (its network, its
// Tessel or this one restarting), it comes back by signing the new
// connection's binding with that key, and is in again at once, with its
// rights (and its open / close counts): no new question. Someone in the
// middle can't do that for it: the key never travels, and a signature only
// fits the connection it was made for. A new guest proves it holds its key
// (it signs its first connection too), and a key already known, or a weak
// one, is refused. The host signs every welcome with a key of its own (the
// share's, given to the guest in its first welcome, checked by the code both
// sides compared): a returning guest checks it is the same host. Guests let
// in survive a restart of this Tessel (knownGuests, given back to
// createShareHost), with their open / close counts, and so do the share's
// earlier invite secrets (a guest let in before a new code comes back with
// the one it had: a secret is kept as long as a guest let in needs it) and
// its block (guard). A guest who leaves or is removed can't come back; the
// host can also remove one that is offline (removeKnown), and one offline
// for more than 15 minutes is forgotten.
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
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, commitmentMatches, bindingSigned, signBinding, newSigningKey, NONCE_BYTES, COMMIT_BYTES, KX_BYTES } from './shareCrypto.js'

// 3: the guest commits first (shareCrypto.js), proves its reconnect key and
// the host signs its welcome. A Tessel with protocol 1 (no commitment) is
// told it is out of date; one with protocol 2 reads the hello's version.
export const SHARE_PROTOCOL = 3
const MAX_GUESTS = 10
const MAX_WAITING = 3 // guests waiting for the host's answer at once
const MAX_FRAME = 1024 * 1024 // a guest's message (typing, a paste)
const MAX_WRITE = 256 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024 // a guest this far behind is dropped
const HANDSHAKE_MS = 15000
const COMMIT_MS = 5000 // a connection that says nothing after the hello: gone
// Connections still in their handshake, from one address and in all (they
// never count among the guests).
const HANDSHAKES_PER_ADDRESS = 3
const HANDSHAKES_AT_ONCE = 30
const PING_MS = 25000 // Cloudflare closes a WebSocket idle for 100 s
const FLUSH_MS = 8
const MAX_SECRETS = 8 // earlier invite secrets kept even when no guest needs them
const OFFLINE_KEEP_MS = 15 * 60 * 1000 // a guest offline this long is forgotten
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
// Connections that got the host's keys and never got in, in 10 min, before
// the invite code is blocked; handshakes a minute.
const UNFINISHED_MAX = 8
const UNFINISHED_MEMORY_MS = 10 * 60 * 1000
// Connections a minute, from one address and in all (a guest let in comes
// back past the per-code block, not past these). Addresses: Cloudflare's
// word for the client (IPv6 by its /64); a program on this PC can claim any
// (a known limit: it could connect anyway).
const EXCHANGES_PER_ADDRESS = 20
const EXCHANGES_PER_MINUTE = 200

// An address as counted: IPv6 by its first four groups (one network).
export function addressKey(address) {
  const a = String(address || '').trim().toLowerCase().slice(0, 64)
  if (!a.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return a.replace(/^::ffff:/, '')
  const [head, tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const full = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}
// How a connection ends by the host's own doing (not counted above).
const HOST_ENDS = new Set(['stopped', 'restarting', 'denied', 'removed', 'replaced', 'slow'])
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

// A guest's reconnect key, and an invite secret, as the host knows them.
const keyHash = (key) => crypto.createHash('sha256').update(key).digest('hex')
const secretId = (secret) => crypto.createHash('sha256').update('tessel-liveshare-secret').update(secret).digest('hex').slice(0, 16)

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
//   onGuests(list)         -> the guests connected changed (offlineGuests()
//                             gives the others let in)
//   onInviteBlocked()      -> too many connections stopped after the
//                             handshake: the code lets no new guest in until
//                             rotate()
//   onKnownChanged()       -> the guests let in changed (knownGuests())
// A share taken back after a restart: known (knownGuests()), secrets (its
// earlier invite secrets), inviteExpires (its code's end), guard (its block,
// guardState()), hostKey (its signing key, shareCrypto.js newSigningKey).
export function createShareHost({ secret, hostName, callbacks, log = () => {}, now = Date.now, known = [], secrets: earlier = [], inviteExpires: expiresAt = null, guard = null, hostKey = newSigningKey() }) {
  const guests = new Map() // id -> guest
  let wss = null
  let pingTimer = null
  let nextGuest = 1
  let stopped = false
  // The invite secrets of this share, the current one first: a new guest
  // needs the current one, a guest let in comes back with the one it had.
  let secrets = [secret, ...(Array.isArray(earlier) ? earlier : []).filter((s) => Buffer.isBuffer(s) && s.length === 32 && !s.equals(secret))]
  let inviteExpires = Number.isFinite(expiresAt) ? expiresAt : now() + INVITE_TTL_MS
  // Guests let in: sha256 of their reconnect public key -> { key, name,
  // rights, sid (the secret it came in with), opened, lastSeen, opens,
  // closes } (the counters stay with the guest across its reconnects and a
  // restart of this Tessel).
  const keys = new Map()
  const times = (list) => (Array.isArray(list) ? list.filter((x) => Number.isFinite(x) && now() - x < 60000).slice(-20) : [])
  const entry = (key, name, rights, sid, opened = 0, lastSeen = now(), opens = [], closes = []) => ({ key, name: cleanName(name), rights: cleanRights(rights), sid, opened: Math.max(0, opened | 0), lastSeen, opens: times(opens), closes: times(closes) })
  const sids = new Set(secrets.map(secretId))
  // Guests of a share taken back: seen now (they get their full time to come
  // back after the restart), with their counts.
  for (const k of Array.isArray(known) ? known : []) {
    const key = k && typeof k.key === 'string' ? Buffer.from(k.key, 'base64') : null
    if (key && key.length === KX_BYTES && sids.has(k.sid)) keys.set(keyHash(key), entry(key, k.name, k.rights, k.sid, k.opened, now(), k.opens, k.closes))
  }
  // Earlier secrets kept: the recent ones, and any a guest let in needs.
  const pruneSecrets = () => {
    const needed = new Set([...keys.values()].map((k) => k.sid))
    secrets = secrets.filter((x, i) => i <= MAX_SECRETS || needed.has(secretId(x)))
  }
  pruneSecrets()
  const keysChanged = () => callbacks.onKnownChanged?.()
  let denials = [] // times of the host's no
  let waitUntil = 0
  // The block, kept across a restart (guardState).
  let unfinished = Array.isArray(guard && guard.unfinished) ? guard.unfinished.filter((x) => Number.isFinite(x)) : [] // times of connections that stopped after the handshake
  let blocked = !!(guard && guard.blocked)
  let exchanges = [] // times of handshakes: [time, address]

  // A guest offline for more than OFFLINE_KEEP_MS: forgotten.
  function forgetOld() {
    const online = new Set([...guests.values()].filter((g) => g.state === 'joined').map((g) => g.keyHash))
    let changed = false
    for (const [hash, k] of [...keys]) {
      if (!online.has(hash) && now() - k.lastSeen > OFFLINE_KEEP_MS) {
        keys.delete(hash)
        changed = true
      }
    }
    if (changed) {
      pruneSecrets()
      keysChanged()
    }
  }

  const inHandshake = (g) => g.state === 'handshake' || g.state === 'committed' || g.state === 'secured'
  const publicGuest = (g) => ({ id: g.id, name: g.name, state: g.state, since: g.since, code: g.code, rights: { ...g.rights } })
  const notifyGuests = () => callbacks.onGuests?.([...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest))
  const isCurrent = (g) => g.secret === secrets[0]

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
    // Past the host's keys, never in, and not turned away by the host's own
    // doing: counted (see onInviteBlocked), whatever its way out.
    if (g.keysSent && !g.everJoined && !g.byHost && !HOST_ENDS.has(reason)) stoppedEarly()
    // A guest who left while waiting, or one removed: new guests wait as
    // after a no (asking again and again costs something).
    if ((g.state === 'waiting' && (reason === 'left' || reason === 'closed')) || reason === 'removed') denied()
    // Left on purpose, or removed: it can't come back. Otherwise: seen now.
    if (g.keyHash && (reason === 'left' || reason === 'removed')) {
      if (keys.delete(g.keyHash)) {
        pruneSecrets()
        keysChanged()
      }
    } else if (g.keyHash && g.everJoined && keys.has(g.keyHash)) {
      keys.get(g.keyHash).lastSeen = now()
      keysChanged()
    }
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

  // In: the guest's entry (its reconnect key, name, rights and counters).
  function welcome(g, back = false) {
    g.state = 'joined'
    g.everJoined = true
    g.since = now()
    const known = keys.get(g.keyHash)
    known.name = g.name
    known.rights = { ...g.rights }
    known.lastSeen = now()
    keysChanged()
    log(`guest ${g.name || '?'} ${back ? 'came back' : 'joined'}`)
    notifyGuests()
    const panes = callbacks.listPanes()
    // This host's key, and its signature of this connection (a returning
    // guest checks it with the key it got the first time).
    const proof = { hostKey: hostKey.publicRaw.toString('base64'), hostSig: signBinding(hostKey, g.binding).toString('base64') }
    send(g, { t: 'welcome', host: hostName, protocol: SHARE_PROTOCOL, panes, layout: callbacks.layout?.() || null, rights: { ...g.rights }, ...proof })
    for (const p of panes) subscribe(g, p.id)
  }

  // A guest coming back: its key signed this connection's binding. In at
  // once, as it was (the connection it had, if any, ends). Anything else:
  // turned away, no question.
  function rejoin(g, back) {
    const key = Buffer.from(String(back.key || ''), 'base64')
    const signature = Buffer.from(String(back.sig || ''), 'base64')
    const hash = key.length === KX_BYTES ? keyHash(key) : ''
    const known = hash && keys.get(hash)
    if (!known || !bindingSigned(key, g.binding, signature)) return drop(g, 'rejoin-refused')
    for (const other of [...guests.values()]) if (other !== g && other.keyHash === hash) drop(other, 'replaced')
    // At most a few more than the guests' room (it was one of them).
    if ([...guests.values()].filter((x) => x.state === 'joined').length >= MAX_GUESTS + 2) return drop(g, 'busy')
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
    if (msg.rejoin && typeof msg.rejoin === 'object') return rejoin(g, msg.rejoin)
    // A new guest: the current code, not blocked or expired, the host not
    // pausing after a no, and its reconnect key.
    if (blocked || !isCurrent(g) || now() > inviteExpires) return drop(g, 'expired')
    const inOrWaiting = [...guests.values()].filter((x) => x.state === 'joined' || x.state === 'waiting')
    if (now() < waitUntil || inOrWaiting.filter((x) => x.state === 'waiting').length >= MAX_WAITING || inOrWaiting.length >= MAX_GUESTS) return drop(g, 'busy')
    // Its reconnect key: it signed this connection with it (it holds it), not
    // a weak one, and not one already known (another guest's).
    const key = Buffer.from(String(msg.key || ''), 'base64')
    const proof = Buffer.from(String(msg.sig || ''), 'base64')
    if (key.length !== KX_BYTES || !bindingSigned(key, g.binding, proof) || keys.has(keyHash(key))) return drop(g, 'protocol')
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
    g.keyHash = keyHash(key)
    if (keys.has(g.keyHash)) return drop(g, 'protocol')
    keys.set(g.keyHash, entry(key, g.name, g.rights, secretId(g.secret)))
    welcome(g)
  }

  // Under its limit (times of its last asks, kept in its entry's `list`), or
  // tells the guest it asked too often.
  function allowed(g, listName, perMinute, inAll = Infinity) {
    const known = keys.get(g.keyHash)
    if (!known) return false
    const t = now()
    const recent = known[listName].filter((x) => t - x < 60000)
    known[listName] = recent
    if (recent.length >= perMinute || known.opened >= inAll) {
      send(g, { t: 'notice', code: 'limit' })
      return false
    }
    recent.push(t)
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
        if (!g.resyncs) g.resyncs = []
        {
          const t = now()
          g.resyncs = g.resyncs.filter((x) => t - x < 60000)
          if (g.resyncs.length >= RESYNCS_PER_MINUTE) return
          g.resyncs.push(t)
        }
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
        if (!allowed(g, 'opens', OPENS_PER_MINUTE, OPENS_IN_ALL)) return
        keys.get(g.keyHash).opened++
        keysChanged()
        callbacks.openPane({ kind: msg.spec.kind, agent: typeof msg.spec.agent === 'string' ? msg.spec.agent.slice(0, 40) : undefined }, publicGuest(g))
        return
      case 'close':
        if (!g.rights.close || !isShared(msg.id)) return
        if (!allowed(g, 'closes', CLOSES_PER_MINUTE)) return
        keysChanged()
        callbacks.closePane(msg.id, publicGuest(g))
        return
      default:
        return
    }
  }

  // Guests not in yet that can no longer get in (the code changed, expired
  // or got blocked): turned away.
  function dropNotJoined(reason) {
    for (const g of [...guests.values()]) {
      if (g.state !== 'waiting' || (isCurrent(g) && now() <= inviteExpires && !blocked)) continue
      g.byHost = true
      drop(g, reason)
    }
  }

  const parse = (data, isBinary) => {
    try {
      return isBinary ? null : JSON.parse(data.toString())
    } catch {
      return null
    }
  }

  function onConnection(socket, req) {
    const t = now()
    // Where it comes from: Cloudflare says (the tunnel), else the socket.
    const address = addressKey((req && req.headers && req.headers['cf-connecting-ip']) || (req && req.socket && req.socket.remoteAddress) || '')
    exchanges = exchanges.filter(([x]) => t - x < 60000)
    const shaking = [...guests.values()].filter(inHandshake)
    if (
      stopped ||
      exchanges.length >= EXCHANGES_PER_MINUTE ||
      exchanges.filter(([, a]) => a === address).length >= EXCHANGES_PER_ADDRESS ||
      shaking.length >= HANDSHAKES_AT_ONCE ||
      shaking.filter((x) => x.address === address).length >= HANDSHAKES_PER_ADDRESS
    ) {
      socket.close(CLOSE_BUSY)
      return
    }
    // Counted from the moment it connects, whatever it does next.
    exchanges.push([t, address])
    const g = {
      id: `g${nextGuest++}`,
      name: '',
      address,
      state: 'handshake',
      socket,
      channel: null,
      secret: null,
      binding: null,
      code: null,
      keyHash: null,
      keysSent: false,
      everJoined: false,
      rights: { ...NO_RIGHTS },
      subscribed: new Map(), // pane id -> { state: 'loading' | 'live', held, exit }
      pending: new Map(),
      flushTimer: null,
      since: 0,
      alive: true,
      resyncs: []
    }
    guests.set(g.id, g)
    const hostNonce = newNonce()
    const pair = newKeyPair()
    let commit = null
    // The keys of this connection under each of the share's secrets: the
    // first message tells which one the guest has.
    let candidates = null
    const timer = setTimeout(() => {
      if (inHandshake(g)) drop(g, 'timeout')
    }, HANDSHAKE_MS)
    // Silent after the hello (no commitment): gone soon.
    const quiet = setTimeout(() => {
      if (g.state === 'handshake') drop(g, 'timeout')
    }, COMMIT_MS)
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
        g.keysSent = true
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
        candidates = secrets.map((s) => ({ secret: s, session: sessionKeys(s, hostNonce, guestNonce, 'host', { dh, hostKey: pair.publicRaw, guestKey }) }))
        g.state = 'secured'
        return
      }
      if (!isBinary) return drop(g, 'protocol')
      // 3. Its first sealed message: under which of the share's secrets.
      if (!g.channel) {
        for (const c of candidates) {
          const channel = createChannel(c.session)
          const msg = channel.open(data)
          if (!msg) continue
          g.channel = channel
          g.secret = c.secret
          g.code = c.session.code
          g.binding = c.session.binding
          candidates = null
          clearTimeout(timer)
          return onMessage(g, msg)
        }
        return drop(g, 'refused') // not sealed with this share's secrets
      }
      const msg = g.channel.open(data)
      if (!msg) return drop(g, 'refused')
      onMessage(g, msg)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      clearTimeout(quiet)
      drop(g, 'closed')
    })
    socket.on('error', () => {})
  }

  // A guest that did not answer the last ping is gone (a dead tunnel or
  // computer): dropped. Started once the server listens.
  function startPings() {
    clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      // An expired code: guests still waiting under it are turned away.
      if (now() > inviteExpires) dropNotJoined('expired')
      forgetOld()
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
  }

  return {
    // Listens on 127.0.0.1 (port 0: any free port). Resolves the port.
    start(port = 0) {
      clearInterval(pingTimer)
      pingTimer = null
      return new Promise((resolve, reject) => {
        wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          maxPayload: MAX_FRAME,
          perMessageDeflate: false,
          // Tessel never sends an Origin; a web page always does.
          verifyClient: ({ req }) => !req.headers.origin
        })
        const failed = (err) => {
          try {
            wss.close()
          } catch {
            /* not listening */
          }
          wss = null
          reject(err)
        }
        wss.once('error', failed)
        wss.once('listening', () => {
          wss.off('error', failed)
          wss.on('error', (err) => log(`share server: ${err.message}`))
          startPings()
          resolve(wss.address().port)
        })
        wss.on('connection', onConnection)
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
      const known = keys.get(g.keyHash)
      if (known) {
        known.rights = { ...g.rights }
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
    // Guests let in who are not connected now (their connection dropped, or
    // they are coming back after a restart): { id: 'k-<key hash>', name, rights }.
    offlineGuests() {
      forgetOld()
      const online = new Set([...guests.values()].filter((g) => g.state === 'joined').map((g) => g.keyHash))
      return [...keys].filter(([hash]) => !online.has(hash)).map(([hash, k]) => ({ id: `k-${hash.slice(0, 24)}`, name: k.name, rights: { ...k.rights } }))
    },
    // Removes a guest let in, connected or not (its id from offlineGuests):
    // it can't come back.
    removeKnown(id) {
      const hash = [...keys.keys()].find((h) => `k-${h.slice(0, 24)}` === id)
      if (!hash) return false
      const g = [...guests.values()].find((x) => x.keyHash === hash)
      if (g) drop(g, 'removed')
      if (keys.delete(hash)) {
        pruneSecrets()
        keysChanged()
      }
      return true
    },
    // A new invite code's secret: the old code lets no new guest in, and
    // guests waiting under it are turned away; guests let in stay, and come
    // back with the secret they had. Good for INVITE_TTL_MS from now, and
    // unblocks a blocked code.
    rotate(newSecret) {
      secrets = [newSecret, ...secrets]
      pruneSecrets()
      inviteExpires = now() + INVITE_TTL_MS
      blocked = false
      unfinished = []
      dropNotJoined('expired')
      return inviteExpires
    },
    inviteExpires: () => inviteExpires,
    inviteBlocked: () => blocked,
    // To keep across a restart of this Tessel: the guests let in (their
    // public keys, names, rights) and the share's earlier secrets.
    knownGuests: () => {
      const online = new Set([...guests.values()].filter((g) => g.state === 'joined').map((g) => g.keyHash))
      return [...keys].map(([hash, k]) => ({ key: k.key.toString('base64'), name: k.name, rights: { ...k.rights }, sid: k.sid, opened: k.opened, lastSeen: online.has(hash) ? now() : k.lastSeen, opens: [...k.opens], closes: [...k.closes] }))
    },
    earlierSecrets: () => secrets.slice(1),
    // The block, to keep across a restart.
    guardState: () => ({ blocked, unfinished: [...unfinished] }),
    guests: () => [...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest)
  }
}
