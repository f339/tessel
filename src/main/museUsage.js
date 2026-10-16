// Muse Code's subscription usage, from Muse itself: `muse serve` (museServe.js)
// answers usage/read with the last 5-hour and weekly windows it saw for your
// sign-in (percentages and reset times, as Meta reports them), without a
// prompt or a model call, and account/read with the kind of sign-in it uses.
// No such window: an API key (billed per token, no subscription quota), no
// sign-in, or nothing seen yet. Only once Muse has run on this computer (its
// settings or data folder exists): its first start may set up its sandbox,
// which can ask Windows for permission, never from a background read. One run
// at a time, a result reused for 30 s; only a short reason code leaves this
// file, never what Muse printed.
import fs from 'node:fs'
import os from 'node:os'
import { cleanEnv } from './cleanEnv'
import { quota } from './usageProviderMapping'
import { findMuse, museServe, MUSE_SERVE_TIMEOUT_MS } from './museServe'
import { museConfigDir, museDataDir } from './museSessions'

const REUSE_MS = 30 * 1000
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = 40) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '')

// usage/read's usage -> { windows, plan, observedAt } (null without a window).
// Its current window is the provider's 5-hour-class block (its length in
// minutes), then the rolling week.
export function mapMuseUsage(usage) {
  if (!object(usage)) return null
  const w = object(usage.window) ? usage.window : {}
  const week = object(usage.weekly) ? usage.weekly : {}
  const minutes = Number(w.windowDurationMins)
  const label = minutes === 300 ? '5-hour' : Number.isInteger(minutes) && minutes > 0 ? `${minutes} min` : '5-hour'
  const windows = [quota(label, w.usedPercent, w.resetsAtMs), quota('Weekly', week.usedPercent, week.resetsAtMs)].filter(Boolean)
  if (!windows.length) return null
  const observedAt = Number(usage.observedAtMs)
  return { windows, plan: text(usage.tier) || null, observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null }
}

// What `muse serve` answered -> { ok: true, windows, plan, observedAt } |
// { ok: false, reason }. reason: 'signed-out' | 'api-key' | 'none' | 'response'
export function readMuseAnswers(results) {
  const usage = results && results['usage/read']
  const account = results && results['account/read']
  const state = account && object(account.result) ? text(account.result.state) : ''
  if (usage && object(usage.result)) {
    const mapped = mapMuseUsage(usage.result.usage)
    if (mapped) return { ok: true, ...mapped }
  } else if (!state) return { ok: false, reason: 'response' }
  if (state === 'loggedOut') return { ok: false, reason: 'signed-out' }
  if (state === 'apiKey' || state === 'envKey') return { ok: false, reason: 'api-key' }
  return { ok: false, reason: 'none' }
}

// env: the variables muse runs with (Tessel's fresh PATH, see cleanEnv.js).
export function createMuseUsage({
  serve = museServe,
  find = findMuse,
  env = () => cleanEnv(process.env),
  clock = Date.now,
  home = os.homedir(),
  timeoutMs = MUSE_SERVE_TIMEOUT_MS,
  version = '0',
  ran = () => fs.existsSync(museConfigDir(home)) || fs.existsSync(museDataDir(home))
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
  // Whether muse is there and has run here, without running it.
  function present() {
    return !!find({ env: vars(), home }) && ran()
  }
  async function run() {
    const runEnv = vars()
    const file = find({ env: runEnv, home })
    if (!file) return { ok: false, reason: 'missing' }
    if (!ran()) return { ok: false, reason: 'never-run' }
    const res = await serve(file, [{ method: 'usage/read' }, { method: 'account/read' }], { env: runEnv, cwd: home, timeoutMs, version, experimental: true })
    if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'failed' }
    return readMuseAnswers(res.results)
  }
  // -> { ok: true, windows, plan, observedAt } | { ok: false, reason }
  // reason: 'missing' | 'never-run' | 'signed-out' | 'api-key' | 'none' |
  // 'config' | 'timeout' | 'failed' | 'response'
  function read() {
    if (running) return running
    if (last && clock() - last.at < REUSE_MS) return Promise.resolve(last.result)
    running = run()
      .catch(() => ({ ok: false, reason: 'failed' }))
      .then((result) => {
        const at = clock()
        const done = result.ok ? { ...result, observedAt: result.observedAt || at } : result
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
