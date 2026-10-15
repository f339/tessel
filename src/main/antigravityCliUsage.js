// Antigravity's quota from its own CLI: `agy -p /usage --output-format json`
// answers locally (a slash command: no model turn, no tokens) with
// command.data.groups[], each a model group with a 5-hour and a weekly
// bucket. agy is started directly (argument array, never a shell: Git Bash
// rewrites the leading "/" into a Windows path, which makes it a real model
// turn), stdin closed, stopped after 20 s or 256 KB. One run at a time, and a
// result is reused for 30 s. Its output is never logged or shown: only a
// short reason code leaves this file.
import { execFile as nodeExecFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanEnv } from './cleanEnv'
import { number, quota } from './usageProviderMapping'

export const AGY_USAGE_ARGS = Object.freeze(['-p', '/usage', '--output-format', 'json'])
export const AGY_TIMEOUT_MS = 20000
const MAX_OUTPUT = 256 * 1024
const REUSE_MS = 30 * 1000

// A bucket's window: its name alone, and after its group's name.
const WINDOWS = {
  '5h': { alone: '5-hour', after: '5-hour' },
  weekly: { alone: 'Weekly', after: 'weekly' }
}
const ORDER = ['5h', 'weekly']
const rank = (bucket) => {
  const i = ORDER.indexOf(bucket?.window)
  return i < 0 ? ORDER.length : i
}
const text = (value, max = 40) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '')

// command.data.groups[].buckets[] -> usage windows: per group, its 5-hour
// then its weekly limit ("Gemini 5-hour", "Gemini weekly").
export function mapAntigravityUsage(data) {
  const groups = data?.command?.data?.groups
  if (!Array.isArray(groups)) return []
  const out = []
  for (const group of groups.slice(0, 20)) {
    // "Gemini Models" -> "Gemini", "Claude and GPT models" -> "Claude and GPT".
    const name = text(group?.name).replace(/\s+models?$/i, '')
    const buckets = (Array.isArray(group?.buckets) ? group.buckets.slice(0, 20) : []).sort((a, b) => rank(a) - rank(b))
    for (const bucket of buckets) {
      const remaining = number(bucket?.remaining_fraction)
      if (remaining === null) continue
      const known = WINDOWS[bucket.window]
      // Another window: its own name, without "Limit Remaining".
      const own = text(bucket.name).replace(/\s*(limit\s*)?remaining$/i, '')
      const window = known ? (name ? known.after : known.alone) : own
      if (!window) continue
      const row = quota(name ? `${name} ${window}` : window, Math.round((1 - remaining) * 1000) / 10, bucket.reset_time)
      if (row && !out.some((w) => w.label === row.label)) out.push(row)
    }
  }
  return out
}

// agy's JSON answer -> { ok: true, windows } | { ok: false, reason }.
export function parseAntigravityUsage(stdout) {
  const raw = String(stdout || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let data
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, reason: 'response' }
  }
  if (!data || typeof data !== 'object' || start < 0) return { ok: false, reason: 'response' }
  if (data.status !== 'SUCCESS') {
    // Only a short field is looked at, for a sign-in it asks for.
    const said = [data.error, data.message, data.response].map((v) => text(v, 300)).join(' ')
    return { ok: false, reason: /sign.?in|log.?in|auth|credential/i.test(said) ? 'signed-out' : 'failed' }
  }
  // The usage command's own answer, never a model turn.
  if (data.command?.name !== 'usage') return { ok: false, reason: 'response' }
  const windows = mapAntigravityUsage(data)
  return windows.length ? { ok: true, windows } : { ok: false, reason: 'response' }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

// agy: the first one on PATH (absolute folders only), then its installer's
// folder (Windows: %LOCALAPPDATA%\agy\bin; elsewhere ~/.local/bin).
export function findAgy({ env = process.env, platform = process.platform, home = os.homedir(), exists = isFile } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const key = Object.keys(env || {}).find((k) => k.toLowerCase() === 'path')
  const dirs = String((key && env[key]) || '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  const local = env?.LOCALAPPDATA || p.join(home, 'AppData', 'Local')
  dirs.push(platform === 'win32' ? p.join(local, 'agy', 'bin') : p.join(home, '.local', 'bin'))
  const name = platform === 'win32' ? 'agy.exe' : 'agy'
  for (const dir of dirs) {
    if (!p.isAbsolute(dir)) continue
    const file = p.join(dir, name)
    if (exists(file)) return file
  }
  return null
}

// env: the variables agy runs with (Tessel's fresh PATH, without the
// launching session's own; see cleanEnv.js).
export function createAntigravityCliUsage({
  execFile = nodeExecFile,
  env = () => cleanEnv(process.env),
  find = findAgy,
  clock = Date.now,
  home = os.homedir(),
  timeoutMs = AGY_TIMEOUT_MS
} = {}) {
  let running = null
  let last = null // { at, result }
  const vars = () => {
    try {
      return env() || {}
    } catch {
      return {}
    }
  }
  // Whether agy is there, without running it.
  function present() {
    return !!find({ env: vars(), home })
  }
  async function run() {
    const runEnv = vars()
    const file = find({ env: runEnv, home })
    if (!file) return { ok: false, reason: 'missing' }
    const { error, stdout } = await new Promise((done) => {
      let child
      try {
        child = execFile(
          file,
          [...AGY_USAGE_ARGS],
          { cwd: home, env: runEnv, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
          (err, out) => done({ error: err, stdout: out })
        )
      } catch (err) {
        done({ error: err, stdout: '' })
        return
      }
      // Nothing to answer: a question would wait for input forever.
      child?.stdin?.on?.('error', () => {})
      child?.stdin?.end?.()
    })
    if (error) {
      if (error.code === 'ENOENT') return { ok: false, reason: 'missing' }
      if (error.killed || error.signal) return { ok: false, reason: 'timeout' }
      if (typeof error.code !== 'number') return { ok: false, reason: 'failed' }
      // A failed run: its answer may still say it needs a sign-in.
      const parsed = parseAntigravityUsage(stdout)
      return { ok: false, reason: parsed.reason === 'signed-out' ? 'signed-out' : 'failed' }
    }
    return parseAntigravityUsage(stdout)
  }
  // -> { ok: true, windows, observedAt } | { ok: false, reason }
  // reason: 'missing' | 'signed-out' | 'timeout' | 'failed' | 'response'
  function read() {
    if (running) return running
    if (last && clock() - last.at < REUSE_MS) return Promise.resolve(last.result)
    running = run()
      .catch(() => ({ ok: false, reason: 'failed' }))
      .then((result) => {
        const at = clock()
        const done = result.ok ? { ...result, observedAt: at } : result
        last = { at, result: done }
        return done
      })
      .finally(() => {
        running = null
      })
    return running
  }
  return { present, read, timeoutMs }
}
