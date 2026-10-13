// Live Share: the invite code and the encryption of a shared session.
//
// The host makes a random 32-byte secret when it starts sharing and puts it
// in the invite code with the session's address. The secret never travels
// over the connection: whoever relays it (the Cloudflare tunnel, a proxy)
// only sees the two random nonces of the handshake and then ciphertext.
//
// Each connection gets its own keys: HKDF-SHA256 of the secret, salted with
// the host's and the guest's nonces, one key per direction. Every message is
// sealed with AES-256-GCM under a counter nonce (one counter per direction,
// in order: WebSocket runs over TCP). A message that does not open (wrong
// secret, tampered, replayed, out of order) ends the connection, so a guest
// without the invite code can't get past its first message.
import crypto from 'crypto'

const PREFIX = 'TS1.'
const SECRET_BYTES = 32
export const NONCE_BYTES = 16
const TAG_BYTES = 16
const SALT_LABEL = 'tessel-liveshare-v1'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')

export function newSecret() {
  return crypto.randomBytes(SECRET_BYTES)
}

export function newNonce() {
  return crypto.randomBytes(NONCE_BYTES)
}

// "TS1.<address>.<secret>", both base64url: one line to paste in a chat.
export function encodeInvite({ url, secret }) {
  return PREFIX + b64u(Buffer.from(String(url), 'utf8')) + '.' + b64u(secret)
}

// The address and secret of an invite code, or null when it is not one.
// Only wss:// addresses (and ws:// to this PC or the local network, for
// tests and a same-network share) are accepted.
export function decodeInvite(code) {
  const text = String(code || '').trim()
  if (!text.startsWith(PREFIX)) return null
  const parts = text.slice(PREFIX.length).split('.')
  if (parts.length !== 2) return null
  let url
  let secret
  try {
    url = new URL(unb64u(parts[0]).toString('utf8'))
    secret = unb64u(parts[1])
  } catch {
    return null
  }
  if (secret.length !== SECRET_BYTES) return null
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLocalHost(url.hostname))) return null
  return { url: url.toString(), secret }
}

function isLocalHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true
  return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

// The two keys of one connection, named from each side's point of view.
export function sessionKeys(secret, hostNonce, guestNonce, side) {
  if (!Buffer.isBuffer(hostNonce) || hostNonce.length !== NONCE_BYTES) throw new Error('bad host nonce') // i18n-ignore internal
  if (!Buffer.isBuffer(guestNonce) || guestNonce.length !== NONCE_BYTES) throw new Error('bad guest nonce') // i18n-ignore internal
  const salt = Buffer.concat([Buffer.from(SALT_LABEL), hostNonce, guestNonce])
  const key = (info) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(info), 32))
  const toGuest = key('host-to-guest')
  const toHost = key('guest-to-host')
  return side === 'host' ? { send: toGuest, recv: toHost } : { send: toHost, recv: toGuest }
}

function counterIv(n) {
  const iv = Buffer.alloc(12)
  iv.writeBigUInt64BE(BigInt(n), 4)
  return iv
}

// Seals and opens the messages of one connection, in order.
export function createChannel({ send, recv }) {
  let sent = 0
  let received = 0
  return {
    seal(message) {
      const cipher = crypto.createCipheriv('aes-256-gcm', send, counterIv(sent++))
      const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()])
      return Buffer.concat([body, cipher.getAuthTag()])
    },
    // The message, or null when it does not open (the caller then closes).
    open(frame) {
      const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
      if (buf.length < TAG_BYTES) return null
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', recv, counterIv(received))
        decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES))
        const text = Buffer.concat([decipher.update(buf.subarray(0, buf.length - TAG_BYTES)), decipher.final()]).toString('utf8')
        received++
        return JSON.parse(text)
      } catch {
        return null
      }
    }
  }
}
