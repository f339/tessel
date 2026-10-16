// A Live Share host's usage as its guest shows it (UsageMenu.vue): what the
// host's Tessel sent, taken field by field and bounded, so nothing else it
// may hold (an account, an email, an error's text) can reach the screen.
//
//   snapshot = { providers: [{ id, plan, windows: [{ label, usedPct,
//                resetsAt }], status, updatedAt }] }
//   status: 'ok' | 'stale' | 'signin' | 'unsupported' | 'error'
//
// -> [{ id, plan, windows: [{ label, usedPct, resetsAt }], status,
//       updatedAt, stale }]
export const HOST_USAGE_STATUSES = ['ok', 'stale', 'signin', 'unsupported', 'error']
const MAX_PROVIDERS = 16
const MAX_WINDOWS = 8
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/

const text = (v, max) => (typeof v === 'string' && !CONTROL.test(v) ? v.trim().slice(0, max) : '')
const time = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function cleanHostUsage(snapshot) {
  const list = snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : []
  const out = []
  const seen = new Set()
  for (const p of list.slice(0, MAX_PROVIDERS)) {
    const id = p && typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id) ? p.id : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    const windows = []
    for (const w of (Array.isArray(p.windows) ? p.windows : []).slice(0, MAX_WINDOWS)) {
      const label = text(w && w.label, 60)
      const usedPct = w && typeof w.usedPct === 'number' && Number.isFinite(w.usedPct) ? Math.min(100, Math.max(0, w.usedPct)) : null
      if (!label || usedPct === null) continue
      windows.push({ label, usedPct, resetsAt: time(w.resetsAt) })
    }
    const status = HOST_USAGE_STATUSES.includes(p.status) ? p.status : 'error'
    out.push({ id, plan: text(p.plan, 40), windows, status, updatedAt: time(p.updatedAt), stale: status === 'stale' })
  }
  return out
}

// The newest reading of them all (the section's "Updated N min ago").
export function latestUpdate(providers) {
  let best = null
  for (const p of providers || []) if (p.updatedAt && (!best || p.updatedAt > best)) best = p.updatedAt
  return best
}
