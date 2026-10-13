// Live Share, host side: the share server guests connect to.
//
// It listens on 127.0.0.1 only (the Cloudflare tunnel, shareTunnel.js, is
// what reaches it from outside). A connection first trades two random
// nonces in clear, then everything is sealed with keys derived from the
// invite's secret (shareCrypto.js): a guest without the invite code is
// dropped at its first message. A guest with it still waits until the host
// says yes (askApproval), and the host can remove any guest at any time.
//
// Once in, a guest sees the host's screen: the layout of the project shown
// (layout: splits, sizes, the active and fullscreen pane), and each of its
// terminals and agents (listPanes) live: a snapshot of its screen, then its
// output as it comes. When the host switches project, the guests follow. A guest can type in
// those panes, open new terminals and agents on the host, and close panes.
// The panes' size follows the host's window: guests show them at that size.
//
// Tessel itself is reached only through the callbacks below, so this file
// runs (and is tested) without Electron.
import { WebSocketServer } from 'ws'
import { newNonce, sessionKeys, createChannel, NONCE_BYTES } from './shareCrypto.js'

export const SHARE_PROTOCOL = 1
const MAX_GUESTS = 10
const MAX_FRAME = 1024 * 1024 // a guest's message (typing, a paste)
const MAX_WRITE = 256 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024 // a guest this far behind is dropped
const HANDSHAKE_MS = 15000
const PING_MS = 25000 // Cloudflare closes a WebSocket idle for 100 s
const FLUSH_MS = 8

export const cleanName = (name) =>
  String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40) || 'Guest'

// callbacks:
//   listPanes()            -> [{ id, title, kind, cols, rows }]
//   layout()               -> what the host's window shows (sent as is)
//   snapshot(id)           -> Promise<{ data, cols, rows } | null>, then live
//                             output comes through sendData (see subscribe)
//   write(id, data)
//   openPane(spec, guest)  -> spec: { kind: 'terminal' | 'agent', agent? }
//   closePane(id, guest)
//   askApproval(guest)     -> Promise<boolean>; guest: { id, name }
//   onGuests(list)         -> the guest list changed
export function createShareHost({ secret, hostName, callbacks, log = () => {} }) {
  const guests = new Map() // id -> guest
  let wss = null
  let pingTimer = null
  let nextGuest = 1
  let stopped = false

  const publicGuest = (g) => ({ id: g.id, name: g.name, state: g.state, since: g.since })
  const notifyGuests = () => callbacks.onGuests?.([...guests.values()].filter((g) => g.state !== 'handshake').map(publicGuest))

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
    if (g.state !== 'handshake') log(`guest ${g.name} left (${reason})`)
    notifyGuests()
  }

  function flush(g) {
    clearTimeout(g.flushTimer)
    g.flushTimer = null
    if (!guests.has(g.id)) return
    for (const [id, data] of g.pending) send(g, { t: 'data', id, data })
    g.pending.clear()
  }

  const sharedIds = () => new Set(callbacks.listPanes().map((p) => p.id))

  // A pane's screen, then its output from there on. Output that came before
  // the snapshot is in it and is not sent again; output after it is. The
  // terminal host holds new output while it takes the snapshot, and its
  // answer and the output after it can arrive in one read: so the caller
  // calls ready(snapshot) the moment the answer is read (before that output
  // is passed on), or resolves snapshot()'s promise when order can't matter.
  function subscribe(g, id) {
    if (g.subscribed.has(id)) return
    g.subscribed.set(id, 'loading')
    let done = false
    const ready = (snap) => {
      if (done) return
      done = true
      if (!guests.has(g.id) || g.subscribed.get(id) !== 'loading') return
      g.subscribed.set(id, 'live')
      send(g, { t: 'snapshot', id, data: snap?.data || '', cols: snap?.cols || 0, rows: snap?.rows || 0 })
    }
    Promise.resolve()
      .then(() => callbacks.snapshot(id, ready))
      .then(ready, () => ready(null))
  }

  function welcome(g) {
    g.state = 'joined'
    g.since = Date.now()
    log(`guest ${g.name} joined`)
    notifyGuests()
    const panes = callbacks.listPanes()
    send(g, { t: 'welcome', host: hostName, protocol: SHARE_PROTOCOL, panes, layout: callbacks.layout?.() || null })
    for (const p of panes) subscribe(g, p.id)
  }

  async function onJoin(g, msg) {
    g.name = cleanName(msg.name)
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
      drop(g, 'denied')
      return
    }
    welcome(g)
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
      case 'write':
        if (typeof msg.data === 'string' && msg.data.length <= MAX_WRITE && sharedIds().has(msg.id)) callbacks.write(msg.id, msg.data)
        return
      case 'open':
        if (msg.spec && (msg.spec.kind === 'terminal' || msg.spec.kind === 'agent')) {
          callbacks.openPane({ kind: msg.spec.kind, agent: typeof msg.spec.agent === 'string' ? msg.spec.agent.slice(0, 40) : undefined }, publicGuest(g))
        }
        return
      case 'close':
        if (sharedIds().has(msg.id)) callbacks.closePane(msg.id, publicGuest(g))
        return
      default:
        return
    }
  }

  function onConnection(socket) {
    if (stopped || guests.size >= MAX_GUESTS) {
      socket.close(1013)
      return
    }
    const g = { id: `g${nextGuest++}`, name: 'Guest', state: 'handshake', socket, channel: null, subscribed: new Map(), pending: new Map(), flushTimer: null, since: 0 }
    guests.set(g.id, g)
    const hostNonce = newNonce()
    const timer = setTimeout(() => {
      if (g.state === 'handshake' || g.state === 'secured') drop(g, 'timeout')
    }, HANDSHAKE_MS)
    socket.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL, n: hostNonce.toString('base64') }))
    socket.on('message', (data, isBinary) => {
      if (!guests.has(g.id)) return
      if (g.state === 'handshake') {
        let msg = null
        try {
          msg = isBinary ? null : JSON.parse(data.toString())
        } catch {
          msg = null
        }
        const guestNonce = msg && msg.t === 'nonce' ? Buffer.from(String(msg.n || ''), 'base64') : null
        if (!guestNonce || guestNonce.length !== NONCE_BYTES) return drop(g, 'protocol')
        g.channel = createChannel(sessionKeys(secret, hostNonce, guestNonce, 'host'))
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
        wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_FRAME, perMessageDeflate: false })
        wss.once('error', reject)
        wss.once('listening', () => {
          wss.off('error', reject)
          wss.on('error', (err) => log(`share server: ${err.message}`))
          resolve(wss.address().port)
        })
        wss.on('connection', onConnection)
        pingTimer = setInterval(() => {
          for (const g of guests.values()) {
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
      for (const g of guests.values()) {
        if (g.state !== 'joined' || g.subscribed.get(id) !== 'live') continue
        g.pending.set(id, (g.pending.get(id) || '') + data)
        if (!g.flushTimer) g.flushTimer = setTimeout(() => flush(g), FLUSH_MS)
      }
    },
    sendExit(id, exitCode) {
      for (const g of guests.values()) {
        if (g.state !== 'joined' || !g.subscribed.has(id)) continue
        flush(g)
        send(g, { t: 'exit', id, exitCode })
      }
    },
    // The host's screen changed (a pane opened, closed, renamed or resized,
    // another project shown, the layout changed).
    panesChanged() {
      const panes = callbacks.listPanes()
      const layout = callbacks.layout?.() || null
      const ids = new Set(panes.map((p) => p.id))
      for (const g of guests.values()) {
        if (g.state !== 'joined') continue
        for (const id of [...g.subscribed.keys()]) if (!ids.has(id)) g.subscribed.delete(id)
        send(g, { t: 'panes', panes, layout })
        for (const p of panes) subscribe(g, p.id)
      }
    },
    approve(guestId, yes) {
      guests.get(guestId)?.resolveApproval?.(!!yes)
    },
    removeGuest(guestId) {
      const g = guests.get(guestId)
      if (g) drop(g, 'removed')
    },
    guests: () => [...guests.values()].filter((g) => g.state !== 'handshake').map(publicGuest)
  }
}
