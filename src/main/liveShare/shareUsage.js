// Live Share: the host's usage for guests who have "See my usage".
//
// A guest gets a copy made here from readings the host already has, never a
// reading taken for it: the results the automatic refresh pushes to the
// window (providerUsage:update, handed over by providerUsageIpc.js
// onResult), the refresh's cached readings (usagePoller.js entry, through
// providerUsageIpc.js onCache) and the local Codex session readings
// (providerAccountUsage.js usage()), those at most once a minute. There is
// never an extra provider call.
//
// Per provider the copy has only: its id, its plan, its windows (label, %
// used, reset time), a status (ok, stale, signin, unsupported, error) and
// when it was read. It is built field by field (an allowlist), so account
// ids, account labels, emails, organisations, credits, reset tickets, paid
// extra usage, history and error text never reach a guest, nor any field the
// host's readings gain later. Labels and plans are short plain names; one
// that looks like anything else (an address, a key) is dropped.
//
// Providers the host hides from its Usage menu are left out, and so are the
// ones it cannot read at all ('unavailable': not installed, no subscription),
// as its own menu does.
//
// Pushes (subscribe): only when the content changed, at most once every
// USAGE_PUSH_MS for all guests together. The host's refresh reads only while
// its window is in use, so the copy says when it was read and the guest shows
// "updated N min ago"; a reading that only got older is pushed again once
// its age moved by FRESHNESS_STEP_MS.

import { USAGE_PROVIDERS } from '../../shared/usageProviders'
import { STALE_THRESHOLD_MS } from '../usagePoller'
import { maskSecrets } from './shareChat'

export const USAGE_PUSH_MS = 30 * 1000
// The local Codex readings (session files on this computer), at most this often.
export const LOCAL_USAGE_TTL_MS = 60 * 1000
// Changes nothing pushes on its own (a reading the user refreshed by hand,
// the local readings): looked for this often while someone is subscribed.
export const USAGE_RECHECK_MS = 60 * 1000
const FRESHNESS_STEP_MS = 5 * 60 * 1000
export const USAGE_STATUSES = Object.freeze(['ok', 'stale', 'signin', 'unsupported', 'error'])
export const USAGE_LIMITS = Object.freeze({ windows: 16, label: 70, plan: 40 })

const PROVIDER_IDS = USAGE_PROVIDERS.map((p) => p.id)
// The codes of a read that needs the host to sign in again (UsageMenu.vue's
// SIGN_IN_CODES, and a login that is not the selected account's).
const SIGN_IN_CODES = new Set(['auth', 'expired', 'identity'])
// The local readings' window names -> the names the provider readings use.
const LOCAL_LABELS = { '5h': '5-hour', week: 'Weekly' }
const MAX_TIME_MS = 8.64e15

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A label or a plan: one line, letters, digits and a little punctuation,
// bounded; anything else (an email, a URL, a key) -> null.
/* eslint-disable no-control-regex */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/* eslint-enable no-control-regex */
const PLAIN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,_+()%\u00d7/:'&-]*$/u
export function plainName(value, max) {
  if (typeof value !== 'string') return null
  const text = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  if (!text || text.length > max || !PLAIN_NAME.test(text)) return null
  // A long run of letters and digits, of hex digits, or a UUID reads as a
  // key or an account id.
  if (maskSecrets(text) !== text || /[A-Za-z0-9]{33,}|[0-9a-f]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(text)) return null
  return text
}

// A time (ms or seconds since the epoch, or an ISO date) -> ms, or null.
export function usageTime(value) {
  let ms = null
  if (typeof value === 'number' && Number.isFinite(value)) ms = value < 10_000_000_000 ? value * 1000 : value
  else if (typeof value === 'string' && value.length <= 40) ms = Date.parse(value)
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIME_MS ? Math.round(ms) : null
}

// A reading's windows -> { list: [{ label, usedPct, resetsAt }], stale }.
function cleanWindows(raw, labels = null) {
  const list = []
  let stale = false
  for (const w of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    if (list.length >= USAGE_LIMITS.windows) break
    if (!object(w) || typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct)) continue
    const named = labels && typeof w.label === 'string' && Object.hasOwn(labels, w.label) ? labels[w.label] : w.label
    // An unnamed window stays (ZCode's are), as an unnamed one.
    const label = named === '' ? '' : plainName(named, USAGE_LIMITS.label)
    if (label === null) continue
    list.push({
      label,
      usedPct: Math.round(Math.min(100, Math.max(0, w.usedPct)) * 100) / 100,
      resetsAt: usageTime(w.resetsAt)
    })
    if (w.stale === true) stale = true
  }
  return { list, stale }
}

const cleanPlan = (value) => plainName(value, USAGE_LIMITS.plan)

// One result as the window gets it (a read, a live reading, a reading kept
// through a failure, a failure) -> the guest's copy, or null (not a
// provider's result). status 'unavailable' is internal: left out.
export function usageFromResult(result, now = Date.now()) {
  if (!object(result) || !PROVIDER_IDS.includes(result.provider)) return null
  const id = result.provider
  if (result.ok === true) {
    const windows = cleanWindows(result.windows)
    return {
      id,
      plan: cleanPlan(result.plan),
      windows: windows.list,
      status: result.kept === true || result.stale === true || windows.stale ? 'stale' : 'ok',
      updatedAt: usageTime(result.observedAt) ?? now
    }
  }
  const code = typeof result.code === 'string' ? result.code : ''
  // A result for an account that is no longer the selected one is never shown.
  if (code === 'stale') return null
  return {
    id,
    plan: cleanPlan(result.plan),
    windows: [],
    status: code === 'unavailable' ? 'unavailable' : SIGN_IN_CODES.has(code) ? 'signin' : code === 'unsupported' ? 'unsupported' : 'error',
    updatedAt: now
  }
}

// The refresh's cached state of a provider (usagePoller.js entry) -> the
// guest's copy, or null. The entry keeps no error code: a failure shows as
// 'error', with the last reading (marked stale) while it is recent, as the
// refresh itself keeps it.
export function usageFromEntry(id, entry, now = Date.now()) {
  if (!PROVIDER_IDS.includes(id) || !object(entry)) return null
  if (entry.status === 'unavailable') return { id, plan: null, windows: [], status: 'unavailable', updatedAt: now }
  const snapshot = object(entry.snapshot) ? entry.snapshot : null
  const updatedAt = usageTime(entry.updatedAt)
  if (entry.status === 'error') {
    const read = snapshot && usageFromResult({ ...snapshot, provider: id, ok: true }, updatedAt ?? now)
    if (read && read.windows.length && updatedAt !== null && now - updatedAt <= STALE_THRESHOLD_MS) return { ...read, status: 'stale' }
    return { id, plan: cleanPlan(snapshot?.plan), windows: [], status: 'error', updatedAt: usageTime(entry.attemptAt) ?? now }
  }
  if (!snapshot) return null
  return usageFromResult({ ...snapshot, provider: id, ok: true }, updatedAt ?? now)
}

// The local readings (providerAccountUsage.js usage(): { agents: [...] }) ->
// Map provider id -> the guest's copy (only those with windows).
export function usageFromLocal(local, now = Date.now()) {
  const out = new Map()
  for (const agent of Array.isArray(local?.agents) ? local.agents.slice(0, 8) : []) {
    if (!object(agent) || !['claude', 'codex'].includes(agent.id) || out.has(agent.id)) continue
    const windows = cleanWindows(agent.windows, LOCAL_LABELS)
    if (!windows.list.length) continue
    out.set(agent.id, {
      id: agent.id,
      plan: null,
      windows: windows.list,
      status: agent.stale === true || windows.stale ? 'stale' : 'ok',
      updatedAt: usageTime(agent.observedAt) ?? now
    })
  }
  return out
}

// What is compared to decide a push: the content, with its age in steps.
export function usageContentKey(payload) {
  const list = Array.isArray(payload?.providers) ? payload.providers : []
  return JSON.stringify(list.map((p) => [p.id, p.plan, p.status, p.windows, Math.floor((p.updatedAt || 0) / FRESHNESS_STEP_MS)]))
}

// cache() -> { hidden: [provider ids], entries: { [id]: usagePoller entry } }
//   (providerUsageIpc.js onCache; set later with setCache)
// localUsage() -> providerAccountUsage.js usage() (local files only)
export function createShareUsage({
  cache = null,
  localUsage = null,
  clock = Date.now,
  timers = globalThis,
  pushMs = USAGE_PUSH_MS,
  localTtlMs = LOCAL_USAGE_TTL_MS,
  recheckMs = USAGE_RECHECK_MS,
  log = null
} = {}) {
  let readCache = typeof cache === 'function' ? cache : null
  // provider -> { item, accountId, at }: the last result pushed to the window,
  // with its code (the cache keeps none).
  const latest = new Map()
  const listeners = new Set()
  let local = { at: -Infinity, value: null, pending: null }
  let lastKey = null
  let lastPushAt = -Infinity
  let timer = null
  let recheck = null
  let flushing = null
  // A result came while a copy was being made: another push after it.
  let dirty = false

  async function localReadings() {
    if (typeof localUsage !== 'function') return null
    if (local.pending) return local.pending
    if (clock() - local.at < localTtlMs) return local.value
    const pending = (async () => {
      let value
      try {
        value = await localUsage()
      } catch {
        value = null
      }
      // A failed read waits as long as a good one: never a read per push.
      local = { at: clock(), value, pending: null }
      return value
    })()
    local.pending = pending
    return pending
  }

  function cached() {
    try {
      const value = readCache ? readCache() : null
      return object(value) ? value : null
    } catch {
      return null
    }
  }

  // The current copy for guests: { providers: [...] }, from what the host has.
  async function snapshot() {
    const state = cached()
    const hidden = new Set(Array.isArray(state?.hidden) ? state.hidden : [])
    const entries = object(state?.entries) ? state.entries : {}
    const locals = usageFromLocal(await localReadings(), clock())
    const now = clock()
    const providers = []
    for (const id of PROVIDER_IDS) {
      if (hidden.has(id)) continue
      const entry = object(entries[id]) ? entries[id] : null
      let item = null
      if (entry) {
        // The pushed result has its code (sign in again, unsupported); a
        // reading taken after it (a refresh by hand) is only in the cache.
        const pushed = latest.get(id)
        item = pushed && pushed.accountId === (entry.accountId ?? null) && pushed.at >= (Number(entry.attemptAt) || 0) ? pushed.item : usageFromEntry(id, entry, now)
      } else latest.delete(id) // forgotten (an account switch): its old result too
      const own = locals.get(id)
      if ((!item || item.status === 'unavailable' || !item.windows.length) && own) item = own
      if (item && item.status !== 'unavailable') providers.push(item)
    }
    return { providers }
  }

  async function flush() {
    timer = null
    if (!listeners.size) return
    let payload
    try {
      payload = await snapshot()
    } catch (err) {
      log?.warn?.('live-share', `usage snapshot failed: ${String(err?.message || err).slice(0, 120)}`) // i18n-ignore
      return
    }
    const key = usageContentKey(payload)
    if (key === lastKey) return
    lastKey = key
    lastPushAt = clock()
    for (const fn of [...listeners]) {
      try {
        fn(payload)
      } catch {
        /* one guest's send failing never stops the others */
      }
    }
  }

  // A push soon: now if the last one is old enough, else when it is.
  function schedule() {
    if (!listeners.size || timer || flushing) return
    const wait = Math.max(0, lastPushAt + pushMs - clock())
    timer = timers.setTimeout(() => {
      flushing = flush().finally(() => {
        flushing = null
        // A change that came while the copy was made.
        if (dirty) {
          dirty = false
          schedule()
        }
      })
    }, wait)
    timer?.unref?.()
  }

  function stopTimers() {
    if (timer) timers.clearTimeout(timer)
    timer = null
    if (recheck) timers.clearInterval(recheck)
    recheck = null
  }

  return {
    // providerUsageIpc.js onResult: every result pushed on providerUsage:update.
    onResult(result) {
      const item = usageFromResult(result, clock())
      if (!item) return
      latest.set(item.id, { item, accountId: result.accountId ?? null, at: clock() })
      if (flushing) dirty = true
      else schedule()
    },
    // providerUsageIpc.js onCache hands over the cache reader.
    setCache(fn) {
      readCache = typeof fn === 'function' ? fn : null
    },
    snapshot,
    // fn(payload): the first copy now (for this listener), then each change,
    // at most once every pushMs for all listeners. -> unsubscribe
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      if (!recheck) {
        recheck = timers.setInterval(() => schedule(), recheckMs)
        recheck?.unref?.()
      }
      snapshot().then(
        (payload) => {
          if (!listeners.has(fn)) return
          if (lastKey === null) {
            lastKey = usageContentKey(payload)
            lastPushAt = clock()
          }
          try {
            fn(payload)
          } catch {
            /* the guest went away */
          }
        },
        () => {}
      )
      return () => {
        listeners.delete(fn)
        if (!listeners.size) {
          stopTimers()
          lastKey = null
        }
      }
    },
    stop() {
      listeners.clear()
      stopTimers()
      lastKey = null
    }
  }
}
