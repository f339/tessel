// The status bar's pure logic, ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): resource-usage-metrics.tsx (formatMemory / formatCpu),
// agent-awake-copy.ts, the Resource Manager tree and the Ports summary.

import { t, intlLocale } from './i18n'

function fixed(value, digits) {
  return new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false
  }).format(value)
}

export function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024 * 1024) return t('statusBar.units.kb', '{{value}} KB', { value: fixed(bytes / 1024, 0) })
  if (bytes < 1024 * 1024 * 1024)
    return t('statusBar.units.mb', '{{value}} MB', { value: fixed(bytes / (1024 * 1024), 1) })
  return t('statusBar.units.gb', '{{value}} GB', { value: fixed(bytes / (1024 * 1024 * 1024), 2) })
}

// A percent as the interface's language writes it (French: 41,7 %, with a
// space that never breaks the line).
export function formatCpu(percent) {
  if (!Number.isFinite(percent)) return '—'
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent / 100)
}

// Tessel's keepAwake ('on' | 'agents' | 'off') with Orca's words.
function modeLabelFor(mode) {
  if (mode === 'on') return t('statusBar.awake.on', 'On')
  if (mode === 'agents') return t('statusBar.awake.agent', 'Agent')
  return t('statusBar.awake.off', 'Off')
}
export function awakeCopy(mode, active) {
  const modeLabel = modeLabelFor(mode)
  const statusText = t('statusBar.awake.status', '{{mode}} · {{state}}', {
    mode: modeLabel,
    state: active ? t('statusBar.awake.active', 'Active') : t('statusBar.awake.inactive', 'Inactive')
  })
  const title = t('statusBar.awake.title', 'Keep computer awake')
  return {
    title,
    modeLabel,
    statusText,
    ariaLabel: t('statusBar.awake.ariaLabel', '{{title}}, {{status}}', { title, status: statusText })
  }
}

// snapshot + terminals ([{ id, label, group, groupKey }]) -> groups of
// sessions per workspace, sorted like Orca's popover (memory by default).
export function resourceTree(snapshot, terminals, sortBy = 'memory') {
  const groups = new Map()
  for (const term of terminals || []) {
    const s = snapshot && snapshot.sessions ? snapshot.sessions[term.id] : null
    const key = term.groupKey || term.group || 'Terminals' // i18n-ignore
    if (!groups.has(key))
      groups.set(key, {
        key,
        name: term.group || t('statusBar.resources.terminals', 'Terminals'),
        cpu: 0,
        memory: 0,
        sessions: []
      })
    const g = groups.get(key)
    const session = { id: term.id, label: term.label, bound: !!s, cpu: s ? s.cpu : 0, memory: s ? s.memory : 0 }
    g.sessions.push(session)
    g.cpu += session.cpu
    g.memory += session.memory
  }
  const cmp = (a, b) =>
    sortBy === 'name'
      ? (a.name || a.label).localeCompare(b.name || b.label, intlLocale())
      : sortBy === 'cpu'
        ? b.cpu - a.cpu
        : b.memory - a.memory
  const list = [...groups.values()]
  for (const g of list) g.sessions.sort(cmp)
  list.sort(cmp)
  const app = snapshot && snapshot.app
  return {
    groups: list,
    app: app
      ? [
          { key: 'main', label: t('statusBar.resources.main', 'Main'), ...app.main },
          { key: 'renderer', label: t('statusBar.resources.renderer', 'Renderer'), ...app.renderer },
          ...(app.other && app.other.memory > 0
            ? [{ key: 'other', label: t('statusBar.resources.other', 'Other'), ...app.other }]
            : [])
        ]
      : []
  }
}

// --- Sparkline history (Orca's memory-snapshot-buckets.ts ring + Sparkline) --
// Orca keeps, per workspace and for the app total, the last 60 memory samples
// (one per snapshot: the seed at start, then every 2 s while the popover is
// open), and forgets a key not sampled for 10 minutes. Tessel groups its
// terminals by workspace in the renderer, so the rings live here, bounded and
// in memory, fed by the snapshots the Resource Manager already fetches.
export const HISTORY_CAPACITY = 60
export const HISTORY_STALE_MS = 10 * 60 * 1000
export const APP_HISTORY_KEY = '__app__'

export function createResourceHistory({ capacity = HISTORY_CAPACITY, staleMs = HISTORY_STALE_MS } = {}) {
  const rings = new Map() // key -> { samples, touchedAt }
  function push(key, memoryBytes, now) {
    let ring = rings.get(key)
    if (!ring) rings.set(key, (ring = { samples: [], touchedAt: now }))
    ring.samples.push(Number.isFinite(memoryBytes) ? memoryBytes : 0)
    if (ring.samples.length > capacity) ring.samples.shift()
    ring.touchedAt = now
  }
  function sweep(now) {
    for (const [key, ring] of rings) if (now - ring.touchedAt > staleMs) rings.delete(key)
  }
  // One snapshot: the app total and each workspace's summed memory.
  function record(snapshot, terminals, now = Date.now()) {
    if (snapshot && snapshot.app && snapshot.app.total) push(APP_HISTORY_KEY, snapshot.app.total.memory, now)
    for (const g of resourceTree(snapshot, terminals).groups) push(g.key, g.memory, now)
    sweep(now)
  }
  const read = (key) => {
    const ring = rings.get(key)
    return ring ? [...ring.samples] : []
  }
  return { push, record, sweep, read, size: () => rings.size }
}

// Orca's Sparkline points: min-max scaled into width x height, a flat
// midline until there are two samples.
// The samples a sparkline's width holds: a minute of the popover's 2 s readings.
export const SPARK_SLOTS = 30
export function sparklinePoints(samples, width = 48, height = 14, slots = SPARK_SLOTS) {
  const safe = (Array.isArray(samples) ? samples : []).filter(Number.isFinite).slice(-slots)
  const midY = (height / 2).toFixed(1)
  // Nothing yet: a flat line in the middle.
  if (!safe.length) return `0,${midY} ${width},${midY}`
  // Like Task Manager's graphs: the latest sample at the right edge, history
  // filling in to the left as it comes (one sample is a short stub, not a
  // line across pretending to be two minutes of history). The height spans
  // at least a tenth of the largest value, so a few kilobytes of change
  // don't swing the line from top to bottom; the samples sit around the
  // middle.
  let min = safe[0]
  let max = safe[0]
  for (const v of safe) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = Math.max(max - min, Math.abs(max) * 0.1) || 1
  const mid = (max + min) / 2
  const stepX = width / Math.max(1, slots - 1)
  const y = (v) => (height / 2 - ((v - mid) / span) * height).toFixed(1)
  const x = (i) => (width - (safe.length - 1 - i) * stepX).toFixed(1)
  if (safe.length === 1) return `${(width - stepX).toFixed(1)},${y(safe[0])} ${width.toFixed(1)},${y(safe[0])}`
  return safe.map((v, i) => `${x(i)},${y(v)}`).join(' ')
}

// Left of the first sample, while the history fills in: a faint flat line at
// its level, so a first open shows a baseline, not a lone dot ('' once the
// samples span the width, or with none).
export function sparklineLead(samples, width = 48, height = 14, slots = SPARK_SLOTS) {
  if (!(Array.isArray(samples) ? samples : []).some(Number.isFinite)) return ''
  const [x, y] = sparklinePoints(samples, width, height, slots).split(' ')[0].split(',')
  return Number(x) > 0 ? `0.0,${y} ${x},${y}` : ''
}

// The Ports segment's numbers: workspace ports (shown), external ones.
export function portsSummary(groups, external) {
  const withPorts = (groups || []).filter((g) => g.ports && g.ports.length)
  const workspaceCount = withPorts.reduce((n, g) => n + g.ports.length, 0)
  const externalCount = (external || []).length
  return { groups: withPorts, workspaceCount, externalCount, totalCount: workspaceCount + externalCount }
}
