// Live Share, guest side: the connection to a host's share server.
//
// The invite code (shareCrypto.js) gives the address and the secret. The
// host's first message brings its nonce and X25519 key; the guest answers
// with its own, then everything is sealed with the keys both derive from
// them and the secret. The host sees the guest's name and verification code
// and says yes or no; once in, the guest gets the host's panes (onPanes),
// each pane's screen (onSnapshot) and its output, and what the host lets it
// do (onRights; a host from before rights lets a guest do everything).
//
// Tessel itself is reached only through the callbacks, so this file runs
// (and is tested) without Electron.
import WebSocket from 'ws'
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, NONCE_BYTES } from './shareCrypto.js'

const CONNECT_TIMEOUT_MS = 20000
const MAX_FRAME = 64 * 1024 * 1024 // a snapshot of a screen

// The host closed before the handshake: why (shareHost.js CLOSE_*).
const CLOSE_REASONS = { 4001: 'expired', 4002: 'busy', 1013: 'busy' }

// callbacks: onState(state, info) with 'connecting' | 'waiting' (info:
// { code }) | 'joined' (info: { host }), onPanes(panes, layout),
// onSnapshot(id, data, cols, rows), onData(id, data), onExit(id, exitCode),
// onRights(rights), onNotice(code), onClosed(reason) (once, at the end).
export function createShareGuest({ url, secret, name, callbacks }) {
  let socket = null
  let channel = null
  let code = null
  let closed = false
  let timer = null

  function finish(reason) {
    if (closed) return
    closed = true
    clearTimeout(timer)
    try {
      socket?.close(1000)
    } catch {
      /* already closed */
    }
    callbacks.onClosed?.(reason)
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
        callbacks.onState?.('joined', { host: String(msg.host || '') })
        if (msg.rights) callbacks.onRights?.(rightsOf(msg.rights))
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
      case 'bye':
        finish(String(msg.reason || 'closed'))
        return
      default:
        return
    }
  }

  return {
    connect() {
      callbacks.onState?.('connecting')
      socket = new WebSocket(url, { maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: CONNECT_TIMEOUT_MS })
      // Until the host says yes, a connection that goes nowhere ends here;
      // waiting for the host's answer has no limit (cleared on 'waiting').
      timer = setTimeout(() => finish('timeout'), CONNECT_TIMEOUT_MS)
      socket.on('message', (data, isBinary) => {
        if (closed) return
        if (!channel) {
          let hello
          try {
            hello = isBinary ? null : JSON.parse(data.toString())
          } catch {
            hello = null
          }
          const hostNonce = hello && hello.t === 'hello' && hello.app === 'tessel-liveshare' ? Buffer.from(String(hello.n || ''), 'base64') : null
          if (!hostNonce || hostNonce.length !== NONCE_BYTES) return finish('not-tessel')
          const guestNonce = newNonce()
          // The host's X25519 key (a host from before has none).
          let kx = null
          let mine = null
          if (hello.kx != null) {
            mine = newKeyPair()
            const hostKey = Buffer.from(String(hello.kx), 'base64')
            const dh = sharedSecret(mine.privateKey, hostKey)
            if (!dh) return finish('not-tessel')
            kx = { dh, hostKey, guestKey: mine.publicRaw }
          }
          socket.send(JSON.stringify({ t: 'nonce', n: guestNonce.toString('base64'), ...(mine ? { kx: mine.publicRaw.toString('base64') } : {}) }))
          const session = sessionKeys(secret, hostNonce, guestNonce, 'guest', kx)
          channel = createChannel(session)
          code = session.code
          send({ t: 'join', name })
          return
        }
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
    leave() {
      send({ t: 'leave' })
      finish('left')
    }
  }
}
