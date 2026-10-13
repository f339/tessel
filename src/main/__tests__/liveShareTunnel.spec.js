import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { parseTunnelAddress, ensureCloudflared, startTunnel, tunnelEnv, endLeftoverTunnel, CLOUDFLARED_VERSION } from '../liveShare/shareTunnel'

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
    const spawnImpl = (exe, args, opts) => {
      child = new EventEmitter()
      child.args = args
      child.opts = opts
      child.pid = 4242
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => (child.killed = true)
      setTimeout(() => child.stderr.emit('data', Buffer.from('INF +----+\nINF |  https://a-b-c.trycloudflare.com  |\n')), 5)
      return child
    }
    const t = await startTunnel({ exe: 'cf.exe', port: 4567, dataDir: dir, spawnImpl, env: { PATH: 'x' } })
    expect(t.url).toBe('wss://a-b-c.trycloudflare.com/')
    expect(child.args).toContain('http://127.0.0.1:4567')
    expect(child.opts.env).toEqual({ PATH: 'x' })
    // Its PID is written down while it runs (for a clean-up after a crash).
    expect(fs.readFileSync(join(dir, 'bin', 'cloudflared.pid'), 'utf8')).toBe('4242')
    t.stop()
    expect(child.killed).toBe(true)
    expect(fs.existsSync(join(dir, 'bin', 'cloudflared.pid'))).toBe(false)
  })

  it('gives cloudflared none of the tunnel settings or secrets of this environment', () => {
    const env = tunnelEnv({ PATH: 'p', HTTPS_PROXY: 'http://proxy', TUNNEL_TOKEN: 'tok', TUNNEL_ORIGIN_CERT: 'c', CLOUDFLARED_X: '1', TESSEL_PTYHOST_TOKEN: 's', CLAUDE_CODE_SESSION_ID: 'id', ELECTRON_RUN_AS_NODE: '1' })
    expect(env).toEqual({ PATH: 'p', HTTPS_PROXY: 'http://proxy' })
  })

  it('ends a cloudflared left running by a crash, and only that one', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-'))
    fs.mkdirSync(join(dir, 'bin'), { recursive: true })
    const name = `cloudflared-${CLOUDFLARED_VERSION}.exe`
    const killed = []
    const kill = (pid) => killed.push(pid)
    // No PID written: nothing to do.
    expect(await endLeftoverTunnel(dir, { listNames: async () => [], kill })).toBe(false)
    // The PID is now another program: left alone.
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '700')
    expect(await endLeftoverTunnel(dir, { listNames: async () => [{ pid: 700, name: 'chrome.exe' }], kill })).toBe(false)
    expect(fs.existsSync(join(dir, 'bin', 'cloudflared.pid'))).toBe(false)
    // Still our cloudflared: ended.
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '701')
    expect(await endLeftoverTunnel(dir, { listNames: async () => [{ pid: 701, name: name.toUpperCase() }], kill })).toBe(true)
    // A listing that fails: left alone.
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '702')
    expect(await endLeftoverTunnel(dir, { listNames: async () => null, kill })).toBe(false)
    expect(killed).toEqual([701])
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
