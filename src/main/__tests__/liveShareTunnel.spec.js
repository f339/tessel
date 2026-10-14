import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { parseTunnelAddress, ensureCloudflared, startTunnel, tunnelEnv, endLeftoverTunnel, tunnelAlive, stopTunnelPid, readTunnelPid, CLOUDFLARED_VERSION } from '../liveShare/shareTunnel'

const NAME = `cloudflared-${CLOUDFLARED_VERSION}.exe`
const boxLine = (url) => JSON.stringify({ level: 'info', message: `|  ${url}                                |` })

// A cloudflared that writes its log file (its --logfile argument).
function fakeSpawn(behave) {
  const made = {}
  const spawnImpl = (exe, args, opts) => {
    const child = new EventEmitter()
    child.args = args
    child.opts = opts
    child.pid = 4242
    child.unref = () => (child.unrefed = true)
    child.kill = () => (child.killed = true)
    made.child = child
    const log = args[args.indexOf('--logfile') + 1]
    setTimeout(() => behave(child, (lines) => fs.appendFileSync(log, lines.join('\n') + '\n')), 5)
    return child
  }
  return { spawnImpl, made }
}

describe('Live Share tunnel', () => {
  let dir
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }))
  const tmp = () => (dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-')))

  it('reads the quick tunnel address from cloudflared’s box, never another address it names', () => {
    expect(parseTunnelAddress(boxLine('https://gentle-river-quiet-moon.trycloudflare.com'))).toBe('wss://gentle-river-quiet-moon.trycloudflare.com/')
    expect(parseTunnelAddress('INF |  https://a-b-c.trycloudflare.com  |')).toBe('wss://a-b-c.trycloudflare.com/')
    expect(parseTunnelAddress('INF Starting tunnel')).toBe(null)
    expect(parseTunnelAddress('https://evil.com/?x=.trycloudflare.com')).toBe(null)
    // Its error about the quick tunnel service is not an address.
    expect(parseTunnelAddress('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBe(null)
    expect(parseTunnelAddress('|  https://api.trycloudflare.com  |')).toBe(null)
  })

  it('refuses a download that does not match the published checksum', async () => {
    tmp()
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('not cloudflared').buffer })
    await expect(ensureCloudflared(dir, { fetchImpl })).rejects.toMatchObject({ code: 'checksum' })
    expect(fs.existsSync(join(dir, 'bin'))).toBe(false)
  })

  it('starts cloudflared on its own (a restart of Tessel does not stop it), reads the address from its log, and stops it', async () => {
    tmp()
    const { spawnImpl, made } = fakeSpawn((child, log) => log(['{"level":"info","message":"Requesting new quick Tunnel on trycloudflare.com..."}', boxLine('https://a-b-c.trycloudflare.com')]))
    const t = await startTunnel({ exe: 'cf.exe', port: 4567, dataDir: dir, spawnImpl, env: { PATH: 'x' } })
    expect(t.url).toBe('wss://a-b-c.trycloudflare.com/')
    expect(made.child.args).toContain('http://127.0.0.1:4567')
    expect(made.child.args).toContain('--management-diagnostics=false')
    expect(made.child.opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true, env: { PATH: 'x' } })
    expect(made.child.unrefed).toBe(true)
    // Its PID is written down while it runs (for the next Tessel).
    expect(readTunnelPid(dir)).toBe(4242)
    t.stop()
    expect(made.child.killed).toBe(true)
    expect(readTunnelPid(dir)).toBe(0)
  })

  it('gives cloudflared only what a program needs of this environment', () => {
    const env = tunnelEnv({ PATH: 'p', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://proxy', TUNNEL_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 'g', TESSEL_PTYHOST_TOKEN: 's' })
    expect(env).toEqual({ PATH: 'p', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://proxy' })
  })

  it('says why cloudflared stopped before giving an address (its last words)', async () => {
    tmp()
    const { spawnImpl } = fakeSpawn((child, log) => {
      log(['{"level":"error","message":"failed to request quick Tunnel: 429 Too Many Requests"}'])
      child.emit('exit', 1)
    })
    await expect(startTunnel({ exe: 'cf.exe', port: 1, dataDir: dir, spawnImpl })).rejects.toMatchObject({ code: 'stopped', detail: expect.stringContaining('429 Too Many Requests') })
  })

  it('ends a cloudflared no share uses any more, and only that one', async () => {
    tmp()
    fs.mkdirSync(join(dir, 'bin'), { recursive: true })
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
    expect(await endLeftoverTunnel(dir, { listNames: async () => [{ pid: 701, name: NAME.toUpperCase() }], kill })).toBe(true)
    // A listing that fails: left alone.
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '702')
    expect(await endLeftoverTunnel(dir, { listNames: async () => null, kill })).toBe(false)
    expect(killed).toEqual([701])
  })

  it('tells whether a PID is still its cloudflared, and stops one by its PID', async () => {
    tmp()
    expect(await tunnelAlive(9, { listNames: async () => [{ pid: 9, name: NAME }] })).toBe(true)
    expect(await tunnelAlive(9, { listNames: async () => [{ pid: 9, name: 'node.exe' }] })).toBe(false)
    expect(await tunnelAlive(0, { listNames: async () => [] })).toBe(false)
    fs.mkdirSync(join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '9')
    const killed = []
    stopTunnelPid(dir, 9, (pid) => killed.push(pid))
    expect(killed).toEqual([9])
    expect(readTunnelPid(dir)).toBe(0)
  })
})
