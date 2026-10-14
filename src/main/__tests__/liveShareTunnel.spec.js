import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { parseTunnelAddress, ensureCloudflared, startTunnel, tunnelEnv, endLeftoverTunnel, tunnelState, stopTunnelPid, stopTunnelLater, processState, readTunnelPid, readTunnelPids } from '../liveShare/shareTunnel'

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
    const write = (pid) => fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), String(pid))
    // No PID written: nothing to do.
    expect(await endLeftoverTunnel(dir, { queryState: async () => 'gone', kill })).toBe(false)
    // The PID is now another program: left alone, forgotten.
    write(700)
    expect(await endLeftoverTunnel(dir, { queryState: async () => 'other', kill })).toBe(false)
    expect(readTunnelPid(dir)).toBe(0)
    // Windows could not say: left alone, kept for the next try.
    write(702)
    expect(await endLeftoverTunnel(dir, { queryState: async () => null, kill })).toBe(false)
    expect(readTunnelPid(dir)).toBe(702)
    // Still a cloudflared of this data folder: ended.
    write(701)
    const asked = []
    expect(await endLeftoverTunnel(dir, { queryState: async (pid, dataDir) => (asked.push([pid, dataDir]), 'ours'), kill })).toBe(true)
    expect(killed).toEqual([701])
    expect(asked).toEqual([[701, dir]])
  })

  it('tells what a saved PID is now: ours, another program, gone, or unknown', async () => {
    tmp()
    for (const state of ['ours', 'other', 'gone']) expect(await tunnelState(9, { dataDir: dir, queryState: async () => state })).toBe(state)
    expect(await tunnelState(9, { dataDir: dir, queryState: async () => null })).toBe('unknown')
    expect(await tunnelState(9, { dataDir: dir, queryState: async () => Promise.reject(new Error('x')) })).toBe('unknown')
    expect(await tunnelState(0, { dataDir: dir })).toBe('gone')
  })

  it('stops a tunnel by its PID only while it is still a cloudflared of this data folder', async () => {
    tmp()
    fs.mkdirSync(join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '9')
    const killed = []
    const kill = (pid) => killed.push(pid)
    // Windows could not say: nothing done, nothing forgotten.
    expect(await stopTunnelPid(dir, 9, { queryState: async () => null, kill })).toBe(false)
    expect(readTunnelPid(dir)).toBe(9)
    // Another program now: left alone.
    expect(await stopTunnelPid(dir, 9, { queryState: async () => 'other', kill })).toBe(false)
    expect(killed).toEqual([])
    expect(readTunnelPid(dir)).toBe(0)
    // Ours: stopped.
    expect(await stopTunnelPid(dir, 9, { queryState: async () => 'ours', kill })).toBe(true)
    expect(killed).toEqual([9])
  })
})

describe('Live Share tunnel: round 5', () => {
  let dir
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }))
  const tmp = () => (dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tunnel-')))

  it('asks Windows for a plain word (works in a restricted PowerShell), the PID and folder as variables; anything else is unknown', async () => {
    const calls = []
    const fake = (out, err = null) => (cmd, args, opts, cb) => {
      calls.push({ cmd, script: args[args.length - 1], opts })
      cb(err, out)
    }
    expect(await processState(42, 'C:\\Users\\Frédéric\\AppData\\Roaming\\tessel', { env: { SystemRoot: 'C:\\Windows' }, execFileImpl: fake('ours\r\n') })).toBe('ours')
    expect(calls[0].cmd).toBe('powershell.exe')
    expect(calls[0].script).toContain("$ErrorActionPreference = 'Stop'")
    expect(calls[0].script).toContain("-like 'cloudflared-*.exe'")
    // Nothing that a restricted PowerShell refuses, and no PID or path in the text.
    expect(calls[0].script).not.toContain('OutputEncoding')
    expect(calls[0].script).not.toContain('42')
    expect(calls[0].opts).toMatchObject({ windowsHide: true, env: { SystemRoot: 'C:\\Windows', TESSEL_TUNNEL_PID: '42', TESSEL_TUNNEL_BIN: 'C:\\Users\\Frédéric\\AppData\\Roaming\\tessel\\bin' } })
    expect(await processState(42, 'C:\\x', { execFileImpl: fake('other') })).toBe('other')
    expect(await processState(42, 'C:\\x', { execFileImpl: fake('gone') })).toBe('gone')
    expect(await processState(42, 'C:\\x', { execFileImpl: fake('C:\\x\\bin\\cloudflared.exe') })).toBe(null)
    expect(await processState(42, 'C:\\x', { execFileImpl: fake('ours', new Error('CLM')) })).toBe(null)
    expect(await processState(-1, 'C:\\x', { execFileImpl: fake('ours') })).toBe('gone')
  })

  it('keeps every tunnel it started written down, and ends each one it can check', async () => {
    tmp()
    let next = 500
    const spawnImpl = (exe, args) => {
      const child = new EventEmitter()
      child.pid = next++
      child.unref = () => {}
      child.kill = () => {}
      const log = args[args.indexOf('--logfile') + 1]
      setTimeout(() => fs.appendFileSync(log, boxLine('https://a-b-c.trycloudflare.com') + '\\n'), 5)
      return child
    }
    await startTunnel({ exe: 'cf.exe', port: 1, dataDir: dir, spawnImpl })
    await startTunnel({ exe: 'cf.exe', port: 2, dataDir: dir, spawnImpl })
    expect(readTunnelPids(dir)).toEqual([500, 501])
    const killed = []
    // 500 can't be told about yet: kept; 501 is ours: ended.
    await endLeftoverTunnel(dir, { queryState: async (pid) => (pid === 500 ? null : 'ours'), kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([501])
    expect(readTunnelPids(dir)).toEqual([500])
  })

  it('quitting: checks and ends a taken-back tunnel at once (only that PID, only a cloudflared of this data folder)', () => {
    tmp()
    fs.mkdirSync(join(dir, 'bin'))
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '4242')
    const ran = []
    const ok = stopTunnelLater(dir, 4242, { env: { SystemRoot: 'C:\\Windows' }, spawnSyncImpl: (cmd, args, opts) => (ran.push({ cmd, args, opts }), { status: 0 }) })
    expect(ok).toBe(true)
    expect(ran[0].cmd).toBe('powershell.exe')
    const script = ran[0].args.at(-1)
    expect(script).toContain('Stop-Process -Id $p.ProcessId -Force')
    expect(script).toContain("-like 'cloudflared-*.exe'")
    expect(script).not.toContain('4242')
    expect(ran[0].opts).toMatchObject({ windowsHide: true, timeout: 3000, env: { SystemRoot: 'C:\\Windows', TESSEL_TUNNEL_PID: '4242', TESSEL_TUNNEL_BIN: join(dir, 'bin') } })
    expect(readTunnelPids(dir)).toEqual([])
  })

  it('quitting: if PowerShell cannot answer in time, nothing weaker runs; the PID stays for the next Tessel to check and end', async () => {
    tmp()
    fs.mkdirSync(join(dir, 'bin'))
    fs.writeFileSync(join(dir, 'bin', 'cloudflared.pid'), '4242')
    const ran = []
    for (const answer of [{ status: null, error: new Error('ETIMEDOUT') }, { status: 1 }, () => { throw new Error('spawn EPERM') }]) {
      const spawnSyncImpl = (cmd) => (ran.push(cmd), typeof answer === 'function' ? answer() : answer)
      expect(stopTunnelLater(dir, 4242, { spawnSyncImpl })).toBe(false)
    }
    expect(ran).toEqual(['powershell.exe', 'powershell.exe', 'powershell.exe'])
    expect(readTunnelPids(dir)).toEqual([4242])
    // The next start: checked by its full path first, ended only while ours.
    const killed = []
    expect(await endLeftoverTunnel(dir, { queryState: async () => 'ours', kill: (p) => killed.push(p) })).toBe(true)
    expect(killed).toEqual([4242])
    expect(readTunnelPids(dir)).toEqual([])
  })
})
