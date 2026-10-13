// Live Share, guest side: the connection to a host's share server.
//
// The invite code (shareCrypto.js) gives the address and the secret. The
// host's first message brings its nonce; the guest answers with its own,
// then everything is sealed with the keys both derive from the secret. The
// host sees the guest's name and says yes or no; once in, the guest gets the
// host's panes (onPanes), each pane's screen (onSnapshot) and its output.
//
// Tessel itself is reached only through the callbacks, so this file runs
// (and is tested) without Electron.
import WebSocket from 'ws'
import { newNonce, sessionKeys, createChannel, NONCE_BYTES } from './shareCrypto.js'

const CONNECT_TIMEOUT_MS = 20000
const MAX_FRAME = 64 * 1024 * 1024 // a snapshot with its scrollback

// callbacks: onState(state, info) with 'connecting' | 'waiting' | 'joined',
// onPanes(panes, layout), onSnapshot(id, data, cols, rows), onData(id, data),
// onExit(id, exitCode), onClosed(reason) (once, at the end).
export function createShareGuest({ url, secret, name, callbacks }) {
  let socket = null
  let channel = null
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

  function onMessage(msg) {
    switch (msg.t) {
      case 'waiting':
        callbacks.onState?.('waiting')
        return
      case 'welcome':
        clearTimeout(timer)
        callbacks.onState?.('joined', { host: String(msg.host || '') })
        callbacks.onPanes?.(Array.isArray(msg.panes) ? msg.panes : [], msg.layout || null)
        return
      case 'panes':
        callbacks.onPanes?.(Array.isArray(msg.panes) ? msg.panes : [], msg.layout || null)
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
          let hello = null
          try {
            hello = isBinary ? null : JSON.parse(data.toString())
          } catch {
            hello = null
          }
          const hostNonce = hello && hello.t === 'hello' && hello.app === 'tessel-liveshare' ? Buffer.from(String(hello.n || ''), 'base64') : null
          if (!hostNonce || hostNonce.length !== NONCE_BYTES) return finish('not-tessel')
          const guestNonce = newNonce()
          socket.send(JSON.stringify({ t: 'nonce', n: guestNonce.toString('base64') }))
          channel = createChannel(sessionKeys(secret, hostNonce, guestNonce, 'guest'))
          send({ t: 'join', name })
          return
        }
        const msg = isBinary ? channel.open(data) : null
        if (!msg) return finish('refused')
        if (msg.t === 'waiting') clearTimeout(timer)
        onMessage(msg)
      })
      socket.on('close', () => finish('closed'))
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
