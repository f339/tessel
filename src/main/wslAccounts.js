// The agents' accounts in this PC's WSL distros ("Where you're signed in"):
// the same read-only shell functions as on an SSH host
// (remoteAgent/remoteAccounts.sh), run in the distro by wsl.exe with the
// script on stdin (never on a command line), bounded in size and time. A
// distro that is not running is not started by a scan nobody asked for:
// it is listed as stopped, and checked only when you ask (start: true).
import { spawn } from 'child_process'
import { ACCOUNTS_SHELL, parseAccounts } from './remoteAgent/remoteAccounts'

export const DISTRO = /^[\w.-]{1,64}$/
// Docker Desktop's own distros hold no agent.
const SKIPPED = new Set(['docker-desktop', 'docker-desktop-data'])
const MAX_OUT = 256 * 1024

// wsl.exe -l -q prints UTF-16 (little endian); some builds print UTF-8.
export function distroNames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''))
  const zeros = b.subarray(0, 200).filter((x) => x === 0).length
  let text = zeros > 2 ? b.toString('utf16le') : b.toString('utf8')
  // Its byte order mark, and the NULs of a UTF-16 text read as UTF-8.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const nul = String.fromCharCode(0)
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.split(nul).join('').trim())
        .filter((l) => DISTRO.test(l) && !SKIPPED.has(l.toLowerCase()))
    )
  ].slice(0, 20)
}

export function createWslAccounts({ wslExe, spawnImpl = spawn, exists = () => true, timeoutMs = 15_000, listTimeoutMs = 5_000 } = {}) {
  function runOnce(args, { input = null, ms, cap = MAX_OUT }) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(wslExe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      } catch {
        resolve({ ok: false })
        return
      }
      const parts = []
      let size = 0
      let done = false
      const finish = (res) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(res)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* gone */
        }
        finish({ ok: false, timeout: true })
      }, ms)
      child.on('error', () => finish({ ok: false }))
      child.stdout.on('data', (chunk) => {
        size += chunk.length
        if (size > cap) {
          try {
            child.kill()
          } catch {
            /* gone */
          }
          return finish({ ok: false, tooLarge: true })
        }
        parts.push(chunk)
      })
      child.on('close', (code) => finish({ ok: code === 0, code, out: Buffer.concat(parts) }))
      try {
        if (child.stdin) {
          child.stdin.on('error', () => {})
          if (input !== null) child.stdin.write(input)
          child.stdin.end()
        }
      } catch {
        /* the process tells */
      }
    })
  }

  const available = () => {
    try {
      return !!wslExe && exists(wslExe)
    } catch {
      return false
    }
  }

  // -> { ok, distros: [{ name, running }] } | { ok: false }
  async function list() {
    if (!available()) return { ok: true, distros: [] }
    const [all, running] = await Promise.all([runOnce(['-l', '-q'], { ms: listTimeoutMs, cap: 64 * 1024 }), runOnce(['-l', '--running', '-q'], { ms: listTimeoutMs, cap: 64 * 1024 })])
    // No distro at all: wsl.exe says so and ends with an error code.
    if (!all.ok) return all.timeout ? { ok: false } : { ok: true, distros: [] }
    const up = new Set(running.ok ? distroNames(running.out) : [])
    return { ok: true, distros: distroNames(all.out).map((name) => ({ name, running: up.has(name) })) }
  }

  // -> { ok: true, os, home, entries } | { ok: false, stopped?, timeout?, error? }
  async function scan(name, { start = false } = {}) {
    if (!available() || typeof name !== 'string' || !DISTRO.test(name)) return { ok: false }
    if (!start) {
      const now = await runOnce(['-l', '--running', '-q'], { ms: listTimeoutMs, cap: 64 * 1024 })
      if (!now.ok || !distroNames(now.out).includes(name)) return { ok: false, stopped: true }
    }
    const res = await runOnce(['-d', name, '-e', 'sh', '-s'], { input: `${ACCOUNTS_SHELL}\n__t_accts login\n`, ms: timeoutMs })
    if (!res.ok) return { ok: false, ...(res.timeout ? { timeout: true } : {}) }
    return { ok: true, ...parseAccounts(res.out.toString('utf8')) }
  }

  return { list, scan, available }
}
