// Live Share: the invite code and the encryption of a shared session.
//
// The host makes a random 32-byte secret when it starts sharing and puts it
// in the invite code with the session's address. The secret never travels
// over the connection: whoever relays it (the Cloudflare tunnel, a proxy)
// only sees the handshake and then ciphertext.
//
// The handshake (shareHost.js, shareGuest.js): the guest first commits to a
// random nonce and a fresh X25519 key (their hash), then the host sends its
// own nonce and X25519 key, then the guest reveals its nonce and key, which
// the host checks against the commitment. Each connection's keys are
// HKDF-SHA256 of the invite's secret and the X25519 shared secret, salted
// with both nonces and both keys, one key per direction: a recording of the
// session stays unreadable even if the invite code leaks later (forward
// secrecy). Every message is sealed with AES-256-GCM under a counter nonce
// (one counter per direction, in order: WebSocket runs over TCP). A message
// that does not open (wrong secret, tampered, replayed, out of order) ends
// the connection, so a guest without the invite code can't get past its
// first message.
//
// A guest let in reconnects with a key of its own (Ed25519, made on its
// computer, never sent): it signs the new connection's binding (a value
// derived from that connection's whole handshake), so someone in the middle,
// who has a different connection with each side, can't reuse it.
//
// Both sides show a six-digit verification code derived from the same keys.
// Someone in the middle with the invite code could only make the two codes
// match by luck, one try per connection to the host (the guest committed
// before seeing the host's values, the host's values come after the
// guest's commitment), and the host counts connections that stop after the
// handshake (shareHost.js).
import crypto from 'crypto'

const PREFIX = 'TS1.'
const SECRET_BYTES = 32
export const NONCE_BYTES = 16
export const KX_BYTES = 32
export const COMMIT_BYTES = 32
const TAG_BYTES = 16
const SALT_LABEL = 'tessel-liveshare-v2'
const COMMIT_LABEL = 'tessel-liveshare-commit-v2'
// The DER header of an X25519 public key (SubjectPublicKeyInfo): the raw 32
// bytes follow it.
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')

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
// tests and a same-network share) are accepted; a query or fragment in the
// address is dropped.
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
  url.hash = ''
  url.search = ''
  return { url: url.toString(), secret }
}

function isLocalHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true
  return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

// A fresh X25519 key pair for one connection: { privateKey, publicRaw }.
export function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKey, publicRaw: Buffer.from(der.subarray(der.length - KX_BYTES)) }
}

// The X25519 shared secret with the other side's raw public key, or null
// when that is not a usable key.
export function sharedSecret(privateKey, peerRaw) {
  if (!Buffer.isBuffer(peerRaw) || peerRaw.length !== KX_BYTES) return null
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, peerRaw]), format: 'der', type: 'spki' })
    const dh = crypto.diffieHellman({ privateKey, publicKey })
    // An all-zero result: a low-order key that fixes the secret.
    return dh.every((b) => b === 0) ? null : dh
  } catch {
    return null
  }
}

// The guest's commitment to its nonce and key (sent before it sees the
// host's), and its check by the host.
export function commitment(nonce, publicRaw) {
  return crypto.createHash('sha256').update(COMMIT_LABEL).update(nonce).update(publicRaw).digest()
}
export function commitmentMatches(commit, nonce, publicRaw) {
  if (!Buffer.isBuffer(commit) || commit.length !== COMMIT_BYTES) return false
  return crypto.timingSafeEqual(commit, commitment(nonce, publicRaw))
}

// "123 456": what both sides show, to compare out loud or in a chat.
export function verificationCode(bytes) {
  const n = Buffer.from(bytes).readUInt32BE(0) % 1000000
  const s = String(n).padStart(6, '0')
  return `${s.slice(0, 3)} ${s.slice(3)}`
}

// The two keys of one connection, named from each side's point of view, and
// its verification code. kx: { dh, hostKey, guestKey } (dh: the X25519
// shared secret; the keys: both raw public keys).
export function sessionKeys(secret, hostNonce, guestNonce, side, kx) {
  if (!Buffer.isBuffer(hostNonce) || hostNonce.length !== NONCE_BYTES) throw new Error('bad host nonce') // i18n-ignore internal
  if (!Buffer.isBuffer(guestNonce) || guestNonce.length !== NONCE_BYTES) throw new Error('bad guest nonce') // i18n-ignore internal
  if (!kx || !Buffer.isBuffer(kx.dh) || !Buffer.isBuffer(kx.hostKey) || !Buffer.isBuffer(kx.guestKey)) throw new Error('no key exchange') // i18n-ignore internal
  const ikm = Buffer.concat([Buffer.from(secret), kx.dh])
  const salt = Buffer.concat([Buffer.from(SALT_LABEL), hostNonce, guestNonce, kx.hostKey, kx.guestKey])
  const key = (info, bytes = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), bytes))
  const toGuest = key('host-to-guest')
  const toHost = key('guest-to-host')
  const code = verificationCode(key('verify-code', 4))
  // What a returning guest signs: this connection, both sides' view of it.
  const binding = key('rejoin-binding')
  return side === 'host' ? { send: toGuest, recv: toHost, code, binding } : { send: toHost, recv: toGuest, code, binding }
}

// A guest's reconnect key: { privateKey, publicRaw } (Ed25519).
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
export function newSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKey, publicRaw: Buffer.from(der.subarray(der.length - KX_BYTES)) }
}
// Kept on the guest's disk across a restart (PKCS8, base64), and back.
export function exportSigningKey(key) {
  return key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
}
export function importSigningKey(text) {
  try {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(String(text), 'base64'), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'ed25519') return null
    const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    return { privateKey, publicRaw: Buffer.from(der.subarray(der.length - KX_BYTES)) }
  } catch {
    return null
  }
}
export function signBinding(key, binding) {
  return crypto.sign(null, binding, key.privateKey)
}
// Ed25519 public keys of small order (libsodium's list, the sign bit aside):
// with one of them, a forged signature can hold for any message. Never
// taken as a guest's or a host's key.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
].map((h) => Buffer.from(h, 'hex'))
export function isWeakSigningKey(publicRaw) {
  if (!Buffer.isBuffer(publicRaw) || publicRaw.length !== KX_BYTES) return true
  return SMALL_ORDER.some((k) => k.subarray(0, 31).equals(publicRaw.subarray(0, 31)) && k[31] === (publicRaw[31] & 0x7f))
}

export function bindingSigned(publicRaw, binding, signature) {
  if (!Buffer.isBuffer(publicRaw) || publicRaw.length !== KX_BYTES || isWeakSigningKey(publicRaw) || !Buffer.isBuffer(signature) || signature.length !== 64) return false
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicRaw]), format: 'der', type: 'spki' })
    return crypto.verify(null, binding, publicKey, signature)
  } catch {
    return false
  }
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

function counterIv(n) {
  const iv = Buffer.alloc(12)
  iv.writeBigUInt64BE(BigInt(n), 4)
  return iv
}
