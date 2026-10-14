import { describe, it, expect } from 'vitest'
import {
  newSecret,
  newNonce,
  encodeInvite,
  decodeInvite,
  sessionKeys,
  createChannel,
  newKeyPair,
  sharedSecret,
  verificationCode,
  commitment,
  commitmentMatches,
  newSigningKey,
  signBinding,
  bindingSigned,
  exportSigningKey,
  importSigningKey
} from '../liveShare/shareCrypto'

// Both sides of one connection: nonces, X25519 keys, the keys each derives.
function handshake(secret = newSecret(), guestSecret = secret) {
  const hostNonce = newNonce()
  const guestNonce = newNonce()
  const h = newKeyPair()
  const g = newKeyPair()
  const hostKx = { dh: sharedSecret(h.privateKey, g.publicRaw), hostKey: h.publicRaw, guestKey: g.publicRaw }
  const guestKx = { dh: sharedSecret(g.privateKey, h.publicRaw), hostKey: h.publicRaw, guestKey: g.publicRaw }
  return { host: sessionKeys(secret, hostNonce, guestNonce, 'host', hostKx), guest: sessionKeys(guestSecret, hostNonce, guestNonce, 'guest', guestKx), hostNonce, guestNonce, h, g }
}
const pair = (secret) => {
  const k = handshake(secret)
  return { host: createChannel(k.host), guest: createChannel(k.guest) }
}

describe('Live Share invite code', () => {
  it('round-trips the address and the secret', () => {
    const secret = newSecret()
    const code = encodeInvite({ url: 'wss://abc-def.trycloudflare.com/', secret })
    expect(code.startsWith('TS1.')).toBe(true)
    const back = decodeInvite('  ' + code + '\n')
    expect(back.url).toBe('wss://abc-def.trycloudflare.com/')
    expect(back.secret.equals(secret)).toBe(true)
  })

  it('refuses codes that are not invites, and unencrypted remote addresses', () => {
    expect(decodeInvite('')).toBe(null)
    expect(decodeInvite('hello')).toBe(null)
    expect(decodeInvite('TS1.x')).toBe(null)
    const short = encodeInvite({ url: 'wss://a.example/', secret: Buffer.alloc(8) })
    expect(decodeInvite(short)).toBe(null)
    expect(decodeInvite(encodeInvite({ url: 'ws://evil.example/', secret: newSecret() }))).toBe(null)
    expect(decodeInvite(encodeInvite({ url: 'http://a.example/', secret: newSecret() }))).toBe(null)
  })

  it('accepts ws:// on this PC and the local network', () => {
    for (const url of ['ws://127.0.0.1:4000/', 'ws://localhost:4000/', 'ws://192.168.1.20:4000/', 'ws://10.0.0.5:4000/']) {
      expect(decodeInvite(encodeInvite({ url, secret: newSecret() }))).not.toBe(null)
    }
  })

  it('drops a query or fragment from the address (they would stop the connection)', () => {
    expect(decodeInvite(encodeInvite({ url: 'wss://a-b.trycloudflare.com/?x=1#frag', secret: newSecret() })).url).toBe('wss://a-b.trycloudflare.com/')
  })
})

describe('Live Share channel', () => {
  it('carries messages both ways, in order', () => {
    const { host, guest } = pair()
    expect(guest.open(host.seal({ t: 'data', data: 'a' }))).toEqual({ t: 'data', data: 'a' })
    expect(guest.open(host.seal({ t: 'data', data: 'b' }))).toEqual({ t: 'data', data: 'b' })
    expect(host.open(guest.seal({ t: 'write', data: 'ls\r' }))).toEqual({ t: 'write', data: 'ls\r' })
  })

  it('does not open with another secret', () => {
    const k = handshake(newSecret(), newSecret())
    expect(createChannel(k.host).open(createChannel(k.guest).seal({ t: 'join', name: 'x' }))).toBe(null)
  })

  it('refuses a replayed, reordered or tampered message', () => {
    const { host, guest } = pair()
    const first = host.seal({ n: 1 })
    const second = host.seal({ n: 2 })
    expect(guest.open(second)).toBe(null) // out of order
    const { host: h2, guest: g2 } = pair()
    const a = h2.seal({ n: 1 })
    expect(g2.open(a)).toEqual({ n: 1 })
    expect(g2.open(a)).toBe(null) // replayed
    const { host: h3, guest: g3 } = pair()
    const b = h3.seal({ n: 1 })
    b[0] ^= 1
    expect(g3.open(b)).toBe(null) // tampered
    expect(first.length).toBeGreaterThan(16)
  })

  it('gives each connection its own keys', () => {
    const secret = newSecret()
    const a = pair(secret)
    const b = pair(secret)
    expect(b.guest.open(a.host.seal({ n: 1 }))).toBe(null)
  })
})

describe('Live Share key exchange, commitment and verification code', () => {
  it('both sides get the same keys and the same six-digit code', () => {
    const { host, guest } = handshake()
    expect(host.code).toMatch(/^\d{3} \d{3}$/)
    expect(guest.code).toBe(host.code)
    expect(createChannel(guest).open(createChannel(host).seal({ t: 'hi' }))).toEqual({ t: 'hi' })
  })

  it('a wrong invite secret gives other keys and another code', () => {
    const { host, guest } = handshake(newSecret(), newSecret())
    expect(createChannel(guest).open(createChannel(host).seal({ t: 'hi' }))).toBe(null)
    expect(guest.code).not.toBe(host.code)
  })

  it('needs the key exchange (no connection on the invite secret alone)', () => {
    expect(() => sessionKeys(newSecret(), newNonce(), newNonce(), 'host')).toThrow()
    expect(() => sessionKeys(newSecret(), newNonce(), newNonce(), 'host', { dh: null })).toThrow()
  })

  it('every value goes into the code: another nonce or key, another code', () => {
    const secret = newSecret()
    const k = handshake(secret)
    const otherNonce = sessionKeys(secret, k.hostNonce, newNonce(), 'host', { dh: sharedSecret(k.h.privateKey, k.g.publicRaw), hostKey: k.h.publicRaw, guestKey: k.g.publicRaw })
    expect(otherNonce.code).not.toBe(k.host.code)
  })

  it('the guest commits to its nonce and key before it sees the host’s', () => {
    const nonce = newNonce()
    const { publicRaw } = newKeyPair()
    const c = commitment(nonce, publicRaw)
    expect(c).toHaveLength(32)
    expect(commitmentMatches(c, nonce, publicRaw)).toBe(true)
    expect(commitmentMatches(c, newNonce(), publicRaw)).toBe(false)
    expect(commitmentMatches(c, nonce, newKeyPair().publicRaw)).toBe(false)
    expect(commitmentMatches(Buffer.alloc(5), nonce, publicRaw)).toBe(false)
  })

  it('refuses keys that are not X25519 keys', () => {
    const k = newKeyPair()
    expect(sharedSecret(k.privateKey, Buffer.alloc(31))).toBe(null)
    expect(sharedSecret(k.privateKey, Buffer.alloc(32))).toBe(null) // low order: an all-zero secret
    expect(sharedSecret(k.privateKey, 'key')).toBe(null)
  })

  it('writes the code as two groups of three digits', () => {
    expect(verificationCode(Buffer.from([0, 0, 0, 7]))).toBe('000 007')
    expect(verificationCode(Buffer.from([255, 255, 255, 255]))).toMatch(/^\d{3} \d{3}$/)
  })
})

describe('Live Share reconnect key', () => {
  it('a guest signs its connection binding; the host checks it with the public key', () => {
    const { host, guest } = handshake()
    expect(host.binding.equals(guest.binding)).toBe(true)
    const key = newSigningKey()
    const sig = signBinding(key, guest.binding)
    expect(bindingSigned(key.publicRaw, host.binding, sig)).toBe(true)
    // Another key, or another connection: no.
    expect(bindingSigned(newSigningKey().publicRaw, host.binding, sig)).toBe(false)
    expect(bindingSigned(key.publicRaw, handshake().host.binding, sig)).toBe(false)
    expect(bindingSigned(key.publicRaw, host.binding, Buffer.alloc(64))).toBe(false)
    expect(bindingSigned(Buffer.alloc(3), host.binding, sig)).toBe(false)
  })

  it('someone in the middle has a different binding with each side', () => {
    const secret = newSecret()
    const towardGuest = handshake(secret)
    const towardHost = handshake(secret)
    expect(towardGuest.guest.binding.equals(towardHost.host.binding)).toBe(false)
    const key = newSigningKey()
    expect(bindingSigned(key.publicRaw, towardHost.host.binding, signBinding(key, towardGuest.guest.binding))).toBe(false)
  })

  it('is kept across a restart (its private half, on the guest computer)', () => {
    const key = newSigningKey()
    const back = importSigningKey(exportSigningKey(key))
    expect(back.publicRaw.equals(key.publicRaw)).toBe(true)
    const { host, guest } = handshake()
    expect(bindingSigned(key.publicRaw, host.binding, signBinding(back, guest.binding))).toBe(true)
    expect(importSigningKey('not a key')).toBe(null)
  })
})
