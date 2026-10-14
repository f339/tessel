// Live Share, guest side: the connection to a host's share server.
//
// The invite code (shareCrypto.js) gives the address and the secret. The
// host's first message says it is a Tessel Live Share; the guest commits to
// a random nonce and a fresh X25519 key, gets the host's, reveals its own,
// and then everything is sealed with the keys both derive from them and the
// secret. The host sees the guest's name and verification code and says yes
// or no; once in, the guest gets what the host lets it do (onRights), the
// host's panes (onPanes), each pane's screen (onSnapshot) and its output.
// The guest's reconnect key (signingKey, made on this computer): its public
// half goes with the first join; coming back (back), the guest signs this
// connection's binding with it instead of asking again.
// A connection that hears nothing from the host (not even its pings, every
// 25 s) for 70 s is over.
//
// Tessel itself is reached only through the callbacks, so this file runs
// (and is tested) without Electron.
import WebSocket from 'ws'
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, commitment, signBinding, NONCE_BYTES, KX_BYTES } from './shareCrypto.js'

const CONNECT_TIMEOUT_MS = 20000
const SILENCE_MS = 70000
const MAX_FRAME = 64 * 1024 * 1024 // a snapshot of a screen
const PROTOCOL = 2

// The host closed before the handshake: why (shareHost.js CLOSE_*).
const CLOSE_REASONS = { 4001: 'expired', 4002: 'busy', 1013: 'busy', 4003: 'outdated' }

// callbacks: onState(state, info) with 'connecting' | 'waiting' (info:
// { code }) | 'joined' (info: { host }), onPanes(panes, layout),
// onSnapshot(id, data, cols, rows), onData(id, data), onExit(id, exitCode),
// onRestart(id) (the pane restarted on the host: a new screen follows),
// onRights(rights), onNotice(code), onClosed(reason) (once, at the end).
// signingKey: { privateKey, publicRaw } (shareCrypto.js newSigningKey);
// back: coming back with it (shareHost.js rejoin), no question.
export function createShareGuest({ url, secret, name, signingKey, back = false, callbacks }) {
  let socket = null
  let channel = null
  let code = null
  let closed = false
  let timer = null
  let silence = null
  let mine = null // { nonce, keys } until the host's keys came

  function finish(reason) {
    if (closed) return
    closed = true
    clearTimeout(timer)
    clearTimeout(silence)
    try {
      socket?.close(1000)
    } catch {
      /* already closed */
    }
    callbacks.onClosed?.(reason)
  }

  // Anything from the host (a message, a ping) shows the connection lives.
  function heard() {
    clearTimeout(silence)
    silence = setTimeout(() => finish('timeout'), SILENCE_MS)
  }

  function send(message) {
    if (!channel || !socket || socket.readyState !== 1) return
    socket.send(channel.seal(message))
  }

  const rightsOf = (r) => (r && typeof r === 'object' ? { type: !!r.type, open: !!r.open, close: !!r.close } : null)

  function onMessage(msg) {
    switch (msg.t) {
      case 'waiting':
        callbacks.onState?.('waiting', { code })
        return
      case 'welcome':
        clearTimeout(timer)
        // What it may do first: the window takes it as the starting point.
        if (msg.rights) callbacks.onRights?.(rightsOf(msg.rights))
        callbacks.onState?.('joined', { host: String(msg.host || '') })
        callbacks.onPanes?.(Array.isArray(msg.panes) ? msg.panes : [], msg.layout || null)
        return
      case 'panes':
        callbacks.onPanes?.(Array.isArray(msg.panes) ? msg.panes : [], msg.layout || null)
        return
      case 'rights':
        callbacks.onRights?.(rightsOf(msg.rights))
        return
      case 'notice':
        callbacks.onNotice?.(String(msg.code || ''))
        return
      case 'snapshot':
        callbacks.onSnapshot?.(msg.id, String(msg.data || ''), msg.cols | 0, msg.rows | 0)
        return
      case 'data':
        callbacks.onData?.(msg.id, String(msg.data || ''))
        return
      case 'exit':
        callbacks.onExit?.(msg.id, msg.exitCode)
        return
      case 'restart':
        callbacks.onRestart?.(msg.id)
        return
      case 'bye':
        finish(String(msg.reason || 'closed'))
        return
      default:
        return
    }
  }

  const parse = (data, isBinary) => {
    try {
      return isBinary ? null : JSON.parse(data.toString())
    } catch {
      return null
    }
  }

  // The handshake, before the channel: the host's hello (commit), then its
  // keys (reveal and join).
  function onHandshake(msg) {
    if (!mine) {
      if (!msg || msg.t !== 'hello' || msg.app !== 'tessel-liveshare') return finish('not-tessel')
      // A host with a newer protocol than this Tessel, or an older one (the
      // first had its nonce in the hello).
      if (Number(msg.v) > PROTOCOL) return finish('outdated')
      if (msg.v !== PROTOCOL || msg.n != null) return finish('outdated-host')
      mine = { nonce: newNonce(), keys: newKeyPair() }
      socket.send(JSON.stringify({ t: 'commit', c: commitment(mine.nonce, mine.keys.publicRaw).toString('base64') }))
      return
    }
    const hostNonce = msg && msg.t === 'keys' ? Buffer.from(String(msg.n || ''), 'base64') : null
    const hostKey = msg && msg.t === 'keys' ? Buffer.from(String(msg.kx || ''), 'base64') : null
    if (!hostNonce || hostNonce.length !== NONCE_BYTES || !hostKey || hostKey.length !== KX_BYTES) return finish('not-tessel')
    const dh = sharedSecret(mine.keys.privateKey, hostKey)
    if (!dh) return finish('not-tessel')
    socket.send(JSON.stringify({ t: 'reveal', n: mine.nonce.toString('base64'), kx: mine.keys.publicRaw.toString('base64') }))
    const session = sessionKeys(secret, hostNonce, mine.nonce, 'guest', { dh, hostKey, guestKey: mine.keys.publicRaw })
    mine = null
    channel = createChannel(session)
    code = session.code
    const key = signingKey.publicRaw.toString('base64')
    if (back) send({ t: 'join', name, rejoin: { key, sig: signBinding(signingKey, session.binding).toString('base64') } })
    else send({ t: 'join', name, key })
  }

  return {
    connect() {
      callbacks.onState?.('connecting')
      try {
        socket = new WebSocket(url, { maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: CONNECT_TIMEOUT_MS })
      } catch {
        finish('error')
        return
      }
      // Until the host says yes, a connection that goes nowhere ends here;
      // waiting for the host's answer has no limit (cleared on 'waiting').
      timer = setTimeout(() => finish('timeout'), CONNECT_TIMEOUT_MS)
      heard()
      socket.on('ping', heard)
      socket.on('message', (data, isBinary) => {
        if (closed) return
        heard()
        if (!channel) return onHandshake(parse(data, isBinary))
        const msg = isBinary ? channel.open(data) : null
        if (!msg) return finish('refused')
        if (msg.t === 'waiting') clearTimeout(timer)
        onMessage(msg)
      })
      socket.on('close', (closeCode) => finish(CLOSE_REASONS[closeCode] || 'closed'))
      socket.on('error', (err) => finish(err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' ? 'unreachable' : 'error'))
    },
    write(id, data) {
      send({ t: 'write', id, data })
    },
    open(spec) {
      send({ t: 'open', spec })
    },
    close(id) {
      send({ t: 'close', id })
    },
    // The pane's screen again (this window reloaded).
    resync(id) {
      send({ t: 'resync', id })
    },
    leave() {
      send({ t: 'leave' })
      finish('left')
    },
    // Gone without leaving (this Tessel restarting): the host keeps the
    // reconnect key, and the next Tessel comes back with it.
    disconnect() {
      finish('suspended')
    }
  }
}
