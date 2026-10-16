// A short exchange with Muse Code's own server, `muse serve` (its session
// protocol, MSP: JSON-RPC 2.0, one message per line on its stdin and stdout):
// initialize, initialized, then queries that open no session and run no model
// turn (usage/read, account/read, model/list). Never a prompt.
//
// The binary is started directly (an argument array, never a shell), with a
// stdin pipe Tessel closes at the end (Muse's cue to finish and exit; it is
// stopped 2 s later if it has not), stopped after 20 s or 1 MB of output. Its
// stderr is read and dropped; nothing it answers is logged.
//
// After Muse Code's protocol guides (meta-models.github.io/muse-code-sdk:
// framing and caps, envelope and ids, the handshake) and its installers
// (dev.meta.ai/install.ps1, install.sh and the launcher they install).
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MUSE_SERVE_TIMEOUT_MS = 20000
const MAX_OUTPUT = 1024 * 1024
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// Windows: Muse's installer puts muse.cmd, the PowerShell launcher it runs and
// the binary that launcher starts (muse-bin-<version>.exe, the version named
// in .muse-version) in one folder. The binary itself is run: muse.cmd needs
// cmd.exe, and its launcher checks for updates first. -> its path, or null.
export function museBinaryIn(dir, { exists = isFile, read = readText } = {}) {
  const version = String(read(path.win32.join(dir, '.muse-version')) || '').trim()
  if (!VERSION.test(version)) return null
  const file = path.win32.join(dir, `muse-bin-${version}.exe`)
  return exists(file) ? file : null
}

// The muse to run: on PATH (absolute folders only), then its installer's
// folder (MUSE_INSTALL_DIR, else Windows: %LOCALAPPDATA%\Programs\muse,
// elsewhere ~/.local/bin, where its launcher script is).
export function findMuse({ env = process.env, platform = process.platform, home = os.homedir(), exists = isFile, read = readText } = {}) {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const value = (name) => {
    const key = Object.keys(env || {}).find((k) => (win ? k.toUpperCase() === name : k === name))
    const v = key ? String(env[key] || '').trim() : ''
    return v && p.isAbsolute(v) ? v : ''
  }
  const pathKey = Object.keys(env || {}).find((k) => k.toLowerCase() === 'path')
  const dirs = String((pathKey && env[pathKey]) || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const local = value('LOCALAPPDATA') || p.join(home, 'AppData', 'Local')
  dirs.push(value('MUSE_INSTALL_DIR') || (win ? p.join(local, 'Programs', 'muse') : p.join(home, '.local', 'bin')))
  for (const dir of dirs) {
    if (!p.isAbsolute(dir)) continue
    if (!win) {
      if (exists(p.join(dir, 'muse'))) return p.join(dir, 'muse')
      continue
    }
    if (exists(p.join(dir, 'muse.exe'))) return p.join(dir, 'muse.exe')
    if (exists(p.join(dir, 'muse.cmd'))) {
      const bin = museBinaryIn(dir, { exists, read })
      if (bin) return bin
    }
  }
  return null
}

// requests: [{ method, params? }] (each method once).
// -> { ok: true, results: { [method]: { result } | { error: { code, message } } } }
//  | { ok: false, reason: 'missing' | 'timeout' | 'config' | 'failed' | 'response' }
// 'config': Muse exited with its code 3 before answering (its settings or
// sign-in could not be loaded). experimental: its experimental queries too
// (account/read).
export function museServe(file, requests = [], { spawn = nodeSpawn, env = process.env, cwd = os.homedir(), timeoutMs = MUSE_SERVE_TIMEOUT_MS, version = '0', experimental = false } = {}) {
  return new Promise((done) => {
    let child = null
    let finished = false
    let initialized = false
    let out = ''
    let size = 0
    const results = {}
    const pending = new Map() // request id -> method
    let timer = null
    const finish = (res) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (child) {
        // Its stdin closed: Muse finishes and exits; stopped if it does not.
        try {
          child.stdin.end()
        } catch {
          /* closed */
        }
        const stop = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* gone */
          }
        }, 2000)
        if (stop.unref) stop.unref()
        child.once('exit', () => clearTimeout(stop))
      }
      done(res)
    }
    try {
      child = spawn(file, ['serve'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      child = null
      finish({ ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'failed' })
      return
    }
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      } catch {
        finish({ ok: false, reason: 'failed' })
      }
    }
    child.on('error', (err) => finish({ ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'failed' }))
    child.on('exit', (code) => finish(Object.keys(results).length ? { ok: true, results } : { ok: false, reason: !initialized && code === 3 ? 'config' : 'failed' }))
    if (child.stdin) child.stdin.on('error', () => {})
    if (child.stderr) child.stderr.on('data', () => {}) // read and dropped
    let nextId = 2
    const onLine = (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      // A notification, or a request of its own: nothing to answer here.
      if (!message || typeof message !== 'object' || message.id === undefined || message.method !== undefined) return
      if (message.id === 1) {
        if (!message.result || typeof message.result !== 'object') return finish({ ok: false, reason: 'failed' })
        initialized = true
        send({ method: 'initialized' })
        for (const r of requests) {
          const id = nextId++
          pending.set(id, r.method)
          send({ id, method: r.method, ...(r.params ? { params: r.params } : {}) })
        }
        if (!pending.size) finish({ ok: true, results })
        return
      }
      const method = pending.get(message.id)
      if (!method) return
      pending.delete(message.id)
      const error = message.error && typeof message.error === 'object' ? message.error : null
      results[method] = error ? { error: { code: Number(error.code) || 0, message: String(error.message || '').slice(0, 200) } } : { result: message.result }
      if (!pending.size) finish({ ok: true, results })
    }
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_OUTPUT) return finish({ ok: false, reason: 'response' })
        out += chunk
        let nl
        while (!finished && (nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).replace(/\r$/, '').trim()
          out = out.slice(nl + 1)
          if (line) onLine(line)
        }
      })
    }
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'tessel', title: 'Tessel', version: String(version) },
        // Tessel draws no question dialog: none is sent to it.
        capabilities: { userInputDialogs: false, ...(experimental ? { experimentalApi: true } : {}) }
      }
    })
  })
}
