import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { parseTunnelAddress, ensureCloudflared, startTunnel } from '../liveShare/shareTunnel'

describe('Live Share tunnel', () => {
  let dir
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }))

  it('reads the quick tunnel address from cloudflared output', () => {
    const out = '2026-10-13T10:00:00Z INF |  https://gentle-river-quiet-moon.trycloudflare.com                  |\n'
    expect(parseTunnelAddress(out)).toBe('wss://gentle-river-quiet-moon.trycloudflare.com/')
    expect(parseTunnelAddress('INF Starting tunnel')).toBe(null)
    expect(parseTunnelAddress('https://evil.com/?x=.trycloudflare.com')).toBe(null)
  })

  it('refuses a download that does not match the published checksum', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-'))
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('not cloudflared').buffer })
    await expect(ensureCloudflared(dir, { fetchImpl })).rejects.toThrow(/SHA-256/)
    expect(fs.existsSync(join(dir, 'bin'))).toBe(false)
  })

  it('resolves once cloudflared prints the address, and stops it', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-'))
    let child
    const spawnImpl = (exe, args) => {
      child = new EventEmitter()
      child.args = args
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => (child.killed = true)
      setTimeout(() => child.stderr.emit('data', Buffer.from('INF +----+\nINF |  https://a-b-c.trycloudflare.com  |\n')), 5)
      return child
    }
    const t = await startTunnel({ exe: 'cf.exe', port: 4567, dataDir: dir, spawnImpl })
    expect(t.url).toBe('wss://a-b-c.trycloudflare.com/')
    expect(child.args).toContain('http://127.0.0.1:4567')
    t.stop()
    expect(child.killed).toBe(true)
  })

  it('reports why cloudflared stopped before giving an address', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-'))
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('ERR failed to request quick Tunnel: 429 Too Many Requests\n'))
        child.emit('exit', 1)
      }, 5)
      return child
    }
    await expect(startTunnel({ exe: 'cf.exe', port: 1, dataDir: dir, spawnImpl })).rejects.toThrow(/429/)
  })
})
