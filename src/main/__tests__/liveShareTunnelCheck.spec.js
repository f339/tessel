// A new tunnel's address checked before the invite code is shown: only once
// cloudflared connected to Cloudflare, found through public DNS when this
// PC's DNS cannot find it yet, and why it did not answer said each time.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { tunnelLogTail, tunnelRegistered, waitRegistered, waitReachable } from '../liveShare/shareTunnel'
import { fallbackLookup, PUBLIC_DNS } from '../liveShare/shareDns'

const line = (message, extra = {}) => JSON.stringify({ level: 'info', ...extra, message })

describe('the tunnel log', () => {
  let dir
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }))
  const withLog = (lines) => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tcheck-'))
    fs.mkdirSync(join(dir, 'bin'))
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.log'), lines.join('\n') + '\n')
    return dir
  }

  it("its last words, without the pre-check's table and progress (its failures and summary kept)", () => {
    withLog([
      line('Initial protocol quic'),
      line('|  UDP Connectivity  region1.v2.argotunnel.com  PASS    QUIC connection successful    |'),
      line('|  UDP Connectivity  region2.v2.argotunnel.com  FAIL    timeout                       |'),
      line("|  SUMMARY: Environment is degraded. cloudflared will use 'http2' as primary protocol.  |"),
      line('precheck'),
      line('precheck complete'),
      line('Failed to dial a quic connection', { level: 'error' })
    ])
    const tail = tunnelLogTail(dir)
    expect(tail).toContain('Initial protocol quic')
    expect(tail).toContain('FAIL timeout')
    expect(tail).toContain('SUMMARY: Environment is degraded')
    expect(tail).toContain('Failed to dial a quic connection')
    expect(tail).not.toContain('PASS')
    expect(tail).not.toMatch(/\| precheck/)
    expect(tunnelLogTail(join(dir, 'none'))).toBe('')
  })

  it('connected once cloudflared registered its connection', async () => {
    withLog([line('Initial protocol quic')])
    expect(tunnelRegistered(dir)).toBe(false)
    expect(await waitRegistered(dir, { timeoutMs: 60, everyMs: 10 })).toBe(false)
    setTimeout(() => fs.appendFileSync(join(dir, 'bin', 'cloudflared.log'), line('Registered tunnel connection', { location: 'yyz06' }) + '\n'), 30)
    expect(await waitRegistered(dir, { timeoutMs: 2000, everyMs: 10 })).toBe(true)
    let stop = false
    setTimeout(() => (stop = true), 20)
    expect(await waitRegistered(join(dir, 'none'), { timeoutMs: 5000, everyMs: 10, cancelled: () => stop })).toBe(false)
  })
})

describe('the address check', () => {
  // A WebSocket that does what `script` says for each try.
  function fakeWs(script) {
    const made = []
    class WS extends EventEmitter {
      constructor(url, opts) {
        super()
        made.push({ url, opts })
        const step = script[Math.min(made.length - 1, script.length - 1)]
        setTimeout(() => step(this), 1)
      }
      terminate() {}
    }
    return { WS, made }
  }

  it('says why each try failed (no such name, Cloudflare without the share), then gets in', async () => {
    const { WS, made } = fakeWs([
      (s) => s.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
      (s) => s.emit('unexpected-response', {}, { statusCode: 530 }),
      (s) => s.emit('message', Buffer.from(JSON.stringify({ t: 'hello', app: 'other' }))),
      (s) => s.emit('message', Buffer.from(JSON.stringify({ t: 'hello', app: 'tessel-liveshare' })))
    ])
    const fails = []
    const lookup = () => {}
    expect(await waitReachable('wss://a-b.trycloudflare.com/', { WebSocketImpl: WS, everyMs: 1, onFail: (r) => fails.push(r), lookup })).toBe(true)
    expect(fails).toEqual(['ENOTFOUND', 'HTTP 530', 'not this share'])
    // Its name looked up the way given (public DNS when the system's fails).
    expect(made[0].opts.lookup).toBe(lookup)
  })
})

describe('looking up a new name', () => {
  const resolver = (answers) => {
    const r = { servers: null, setServers: (s) => (r.servers = s) }
    r.resolve4 = (_h, cb) => cb(answers.v4 ? null : new Error('ENODATA'), answers.v4 || [])
    r.resolve6 = (_h, cb) => cb(answers.v6 ? null : new Error('ENODATA'), answers.v6 || [])
    return r
  }
  const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
  const look = (lookup, opts) => new Promise((resolve) => lookup('a-b.trycloudflare.com', opts, (err, address, family) => resolve({ err, address, family })))

  it("the system's answer when it has one", async () => {
    const lookup = fallbackLookup({ systemLookup: (_h, _o, cb) => cb(null, '104.16.1.2', 4), makeResolver: () => resolver({}) })
    expect(await look(lookup, {})).toEqual({ err: null, address: '104.16.1.2', family: 4 })
  })

  it("a name this PC's DNS cannot find: through public DNS (one address, or all of them)", async () => {
    let made
    const lookup = fallbackLookup({ systemLookup: (_h, _o, cb) => cb(notFound), makeResolver: () => (made = resolver({ v4: ['104.16.1.2', '104.16.3.4'] })) })
    expect(await look(lookup, {})).toEqual({ err: null, address: '104.16.1.2', family: 4 })
    expect(made.servers).toEqual(PUBLIC_DNS)
    expect((await look(lookup, { all: true })).address).toEqual([
      { address: '104.16.1.2', family: 4 },
      { address: '104.16.3.4', family: 4 }
    ])
    const v6only = fallbackLookup({ systemLookup: (_h, _o, cb) => cb(notFound), makeResolver: () => resolver({ v6: ['2606:4700::1'] }) })
    expect(await look(v6only, {})).toEqual({ err: null, address: '2606:4700::1', family: 6 })
  })

  it('found nowhere: the system error', async () => {
    const lookup = fallbackLookup({ systemLookup: (_h, _o, cb) => cb(notFound), makeResolver: () => resolver({}) })
    expect((await look(lookup, {})).err).toBe(notFound)
  })
})
