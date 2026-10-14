// Live Share: makes the host's share server reachable from anywhere with a
// Cloudflare quick tunnel (free, no account): cloudflared gives a random
// https://<words>.trycloudflare.com address that forwards to the server on
// 127.0.0.1, and stops forwarding when cloudflared is stopped.
//
// cloudflared is downloaded once, from Cloudflare's GitHub release, at a
// pinned version whose SHA-256 is checked before it is ever run, and kept in
// Tessel's data folder. One already on PATH (winget, choco) is not used: its
// version is unknown. The tunnel only carries ciphertext (shareCrypto.js).
//
// cloudflared runs on its own (detached, its log in a file, no pipe to
// Tessel), so a restart of Tessel does not stop it: the next Tessel takes the
// same tunnel back (liveShare.js resume), and the invite code stays the same.
import fs from 'fs'
import { join } from 'path'
import { spawn, execFile } from 'child_process'
import crypto from 'crypto'
import WebSocket from 'ws'

export const CLOUDFLARED_VERSION = '2026.9.3'
const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`
const CLOUDFLARED_SHA256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
const START_TIMEOUT_MS = 45000
const LOG_POLL_MS = 200

// The address in cloudflared's box ("|  https://a-b-c-d.trycloudflare.com  |"),
// never another trycloudflare.com address it names (api.trycloudflare.com in
// its errors): quick tunnel names are words joined by dashes.
const ADDRESS_RE = /\|\s*(https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com)\/?\s*\|/i

// Why a share could not start (liveShare.js says it in the user's language).
export class TunnelError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code) // i18n-ignore internal: the code is shown translated
    this.code = code
    this.detail = detail
  }
}

export function cloudflaredPath(dataDir) {
  return join(dataDir, 'bin', `cloudflared-${CLOUDFLARED_VERSION}.exe`)
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// The checked cloudflared program, downloaded when missing (or not the
// expected file). onProgress gets 0..1 while it downloads.
export async function ensureCloudflared(dataDir, { fetchImpl = fetch, onProgress } = {}) {
  const exe = cloudflaredPath(dataDir)
  try {
    if (sha256(fs.readFileSync(exe)) === CLOUDFLARED_SHA256) return exe
  } catch {
    /* not downloaded yet */
  }
  const res = await fetchImpl(CLOUDFLARED_URL, { redirect: 'follow' })
  if (!res.ok) throw new TunnelError('download', `HTTP ${res.status}`)
  const total = Number(res.headers?.get?.('content-length')) || 0
  const chunks = []
  let got = 0
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      got += value.length
      if (total && onProgress) onProgress(Math.min(1, got / total))
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()))
  }
  const data = Buffer.concat(chunks)
  if (sha256(data) !== CLOUDFLARED_SHA256) throw new TunnelError('checksum')
  fs.mkdirSync(join(dataDir, 'bin'), { recursive: true })
  const tmp = exe + '.part'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, exe)
  return exe
}

// The tunnel's address in cloudflared's log, as a wss:// URL, or null.
export function parseTunnelAddress(text) {
  const m = ADDRESS_RE.exec(String(text || ''))
  return m ? m[1].replace(/^https:/i, 'wss:') + '/' : null
}

// A new tunnel's address takes a few seconds to resolve everywhere: try it
// (the share server's first message proves it is ours) before the invite
// code is shown, so a guest does not join too early. cancelled(): stop now.
export async function waitReachable(url, { WebSocketImpl = WebSocket, timeoutMs = 60000, everyMs = 2000, cancelled = () => false } = {}) {
  const WS = WebSocketImpl
  const end = Date.now() + timeoutMs
  while (Date.now() < end && !cancelled()) {
    const ok = await new Promise((resolve) => {
      let socket
      const done = (v) => {
        clearTimeout(timer)
        try {
          socket?.terminate?.()
        } catch {
          /* closed */
        }
        resolve(v)
      }
      const timer = setTimeout(() => done(false), 8000)
      try {
        socket = new WS(url, { handshakeTimeout: 8000 })
      } catch {
        done(false)
        return
      }
      socket.on('message', (data) => {
        try {
          done(JSON.parse(data.toString()).app === 'tessel-liveshare')
        } catch {
          done(false)
        }
      })
      socket.on('error', () => done(false))
      socket.on('close', () => done(false))
    })
    if (ok) return true
    if (cancelled()) return false
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

// What cloudflared gets of Tessel's environment: only what any program needs
// to run and reach the internet (Windows' own variables, the proxy settings),
// none of the API keys, tokens or tunnel settings (TUNNEL_*) it may hold.
const TUNNEL_ENV = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMPUTERNAME',
    'USERNAME',
    'USERDOMAIN',
    'OS',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR'
  ].map((k) => k.toUpperCase())
)
export function tunnelEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env || {})) if (TUNNEL_ENV.has(k.toUpperCase())) out[k] = v
  return out
}

const pidFile = (dataDir) => join(dataDir, 'bin', 'cloudflared.pid')
const logFile = (dataDir) => join(dataDir, 'bin', 'cloudflared.log')
// The PIDs of the cloudflared this Tessel started and has not seen end, one
// a line (a new tunnel is added, never written over an old one Windows could
// not tell about yet).
export function readTunnelPids(dataDir) {
  try {
    return [...new Set(fs.readFileSync(pidFile(dataDir), 'utf8').split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
  } catch {
    return []
  }
}
function writeTunnelPids(dataDir, pids) {
  try {
    if (pids.length) fs.writeFileSync(pidFile(dataDir), pids.join('\n'))
    else fs.rmSync(pidFile(dataDir), { force: true })
  } catch {
    /* only cleaning up after a restart is lost */
  }
}
const forgetTunnelPid = (dataDir, pid) => writeTunnelPids(dataDir, readTunnelPids(dataDir).filter((x) => x !== pid))
// The newest one.
export function readTunnelPid(dataDir) {
  const pids = readTunnelPids(dataDir)
  return pids.length ? pids[pids.length - 1] : 0
}

// The program a PID runs: its full path; '' when there is no such process;
// null when Windows could not say (PowerShell failed or took too long, the
// query failed, or the process's path is not given). Written out in UTF-8 (a
// user folder with accents would come back garbled otherwise), any error an
// error.
export function processPath(pid, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve('')
    const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { if ($p.ExecutablePath) { $p.ExecutablePath } else { '?' } } else { '' }`
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (err, stdout) => {
      const out = err ? null : String(stdout).trim()
      resolve(out === '?' ? null : out)
    })
  })
}

// What a saved PID is now: 'ours' (this exact cloudflared program: the one
// this Tessel's data folder holds), 'other' (another program has that PID
// now), 'gone', or 'unknown' (Windows could not say, or would not give the
// process's path). Only 'ours' is ever stopped.
export async function tunnelState(pid, { exe, queryPath = processPath }) {
  if (!pid) return 'gone'
  const path = await Promise.resolve()
    .then(() => queryPath(pid))
    .catch(() => null)
  if (path == null) return 'unknown'
  if (!path) return 'gone'
  return String(path).toLowerCase() === String(exe).toLowerCase() ? 'ours' : 'other'
}

// The cloudflared this Tessel started and that no share uses (Tessel quit
// without stopping them, and the share was not taken back): ended. Only the
// PIDs it wrote down, and only while each is still this exact cloudflared;
// one Windows could not tell about stays written down for the next try.
export async function endLeftoverTunnel(dataDir, { queryPath, kill, keep = 0 }) {
  let ended = false
  for (const pid of readTunnelPids(dataDir)) {
    if (pid === keep) continue
    const state = await tunnelState(pid, { exe: cloudflaredPath(dataDir), queryPath })
    if (state === 'unknown') continue
    forgetTunnelPid(dataDir, pid)
    if (state !== 'ours') continue
    try {
      kill(pid)
      ended = true
    } catch {
      /* gone meanwhile */
    }
  }
  return ended
}

// Quitting Tessel with a tunnel taken back after a restart (nothing can be
// waited for): Windows' own taskkill ends it after Tessel is gone, only if
// that PID still runs this cloudflared program (its name: its path was
// checked when it was taken back).
export function stopTunnelLater(dataDir, pid, { spawnImpl = spawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    const child = spawnImpl('taskkill.exe', ['/F', '/PID', String(pid), '/FI', `IMAGENAME eq cloudflared-${CLOUDFLARED_VERSION}.exe`], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.on?.('error', () => {})
    child.unref?.()
  } catch {
    /* the next Tessel ends it (endLeftoverTunnel) */
  }
}

// Stops a tunnel by its PID (one this Tessel took back after a restart),
// only while that PID is still this exact cloudflared, and forgets it.
export async function stopTunnelPid(dataDir, pid, { queryPath, kill = (p) => process.kill(p) }) {
  const state = await tunnelState(pid, { exe: cloudflaredPath(dataDir), queryPath })
  let stopped = false
  if (state === 'ours') {
    try {
      kill(pid)
      stopped = true
    } catch {
      /* already stopped */
    }
  }
  if (state !== 'unknown') forgetTunnelPid(dataDir, pid)
  return stopped
}

// Starts a quick tunnel to 127.0.0.1:port. Resolves { url, stop, pid } once
// Cloudflare gave the address; onExit(code) is called if it stops by itself
// (while this Tessel runs).
export function startTunnel({ exe, port, dataDir, spawnImpl = spawn, onExit, timeoutMs = START_TIMEOUT_MS, env = tunnelEnv() }) {
  // An empty config of its own: a quick tunnel refuses to start when the
  // user's ~/.cloudflared/config.yml exists (a named tunnel of theirs).
  const config = join(dataDir, 'bin', 'cloudflared-quick.yml')
  const log = logFile(dataDir)
  try {
    fs.mkdirSync(join(dataDir, 'bin'), { recursive: true })
    fs.writeFileSync(config, '')
    fs.rmSync(log, { force: true })
  } catch {
    /* cloudflared then reports what is wrong */
  }
  const args = ['tunnel', '--no-autoupdate', '--config', config, '--logfile', log, '--management-diagnostics=false', '--url', `http://127.0.0.1:${port}`]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(exe, args, { windowsHide: true, detached: true, stdio: 'ignore', env })
    } catch (err) {
      reject(new TunnelError('start', (err && err.message) || ''))
      return
    }
    child.unref?.()
    // Its PID, for the next Tessel (to take the tunnel back, or end it),
    // added to the ones not yet seen ending.
    if (child.pid) writeTunnelPids(dataDir, [...readTunnelPids(dataDir).filter((x) => x !== child.pid), child.pid])
    const forgetPid = () => {
      if (child.pid) forgetTunnelPid(dataDir, child.pid)
    }
    let settled = false
    let poll = null
    const finish = () => {
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
    }
    const stop = () => {
      try {
        child.kill()
      } catch {
        /* already stopped */
      }
      forgetPid()
    }
    // Its last words (the log's lines are JSON: their messages).
    const lastLines = () => {
      try {
        const message = (line) => {
          try {
            return String(JSON.parse(line).message || line)
          } catch {
            return line
          }
        }
        return fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-3).map(message).join(' | ')
      } catch {
        return ''
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      finish()
      stop()
      reject(new TunnelError('timeout'))
    }, timeoutMs)
    poll = setInterval(() => {
      if (settled) return
      let text
      try {
        text = fs.readFileSync(log, 'utf8')
      } catch {
        return
      }
      const url = parseTunnelAddress(text)
      if (!url) return
      finish()
      resolve({ url, stop, pid: child.pid })
    }, LOG_POLL_MS)
    child.on('error', (err) => {
      if (settled) return
      finish()
      reject(new TunnelError('start', (err && err.message) || ''))
    })
    child.on('exit', (code) => {
      forgetPid()
      if (!settled) {
        finish()
        reject(new TunnelError('stopped', `${code}${lastLines() ? ': ' + lastLines() : ''}`))
        return
      }
      onExit?.(code)
    })
  })
}
