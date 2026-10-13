import { describe, it, expect } from 'vitest'
import {
  newSecret,
  newNonce,
  encodeInvite,
  decodeInvite,
  sessionKeys,
  createChannel
} from '../liveShare/shareCrypto'

function pair(secret = newSecret()) {
  const hostNonce = newNonce()
  const guestNonce = newNonce()
  return {
    host: createChannel(sessionKeys(secret, hostNonce, guestNonce, 'host')),
    guest: createChannel(sessionKeys(secret, hostNonce, guestNonce, 'guest')),
    hostNonce,
    guestNonce
  }
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
})

describe('Live Share channel', () => {
  it('carries messages both ways, in order', () => {
    const { host, guest } = pair()
    expect(guest.open(host.seal({ t: 'data', data: 'a' }))).toEqual({ t: 'data', data: 'a' })
    expect(guest.open(host.seal({ t: 'data', data: 'b' }))).toEqual({ t: 'data', data: 'b' })
    expect(host.open(guest.seal({ t: 'write', data: 'ls\r' }))).toEqual({ t: 'write', data: 'ls\r' })
  })

  it('does not open with another secret', () => {
    const secret = newSecret()
    const hostNonce = newNonce()
    const guestNonce = newNonce()
    const host = createChannel(sessionKeys(secret, hostNonce, guestNonce, 'host'))
    const intruder = createChannel(sessionKeys(newSecret(), hostNonce, guestNonce, 'guest'))
    expect(host.open(intruder.seal({ t: 'join', name: 'x' }))).toBe(null)
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
