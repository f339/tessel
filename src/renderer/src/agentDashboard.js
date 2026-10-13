// The Dashboard tab (AgentDashboard.vue): every agent row (sidebarModel.js
// paneRow, with its project) sorted into five states, filtered, searched and
// grouped by state or by project. Pure functions; the tab renders the result.
import { reactive } from 'vue'

// The order of the groups, the chips and the bar.
export const DASHBOARD_STATES = ['waiting', 'working', 'done', 'idle', 'sleeping']

// Grouping, filter and search of the tab, kept while Tessel runs.
export const dashboardView = reactive({ groupBy: 'status', filter: 'all', query: '' })

// A row's state on the dashboard: asks you (approval, usage limit) >
// working (or monitoring its background work) > done (its turn ended) >
// sleeping > idle (idle, not reporting, a stopped or interrupted chat).
export function dashboardBucket(row) {
  if (row.sleeping) return 'sleeping'
  switch (row.dotState) {
    case 'waiting':
    case 'blocked':
      return 'waiting'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
      return 'done'
  }
  return 'idle'
}

function matches(row, q) {
  if (!q) return true
  return [row.primary, row.subline, row.typeLabel, row.projectName, row.branch, row.title]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(q))
}

// Within a group: the longest in its state first, then pane order. A row
// only moves when its own state changes, and one that arrives goes under the
// others: rows never take turns at the top.
const sinceOf = (r) => (r.since > 0 ? r.since : Infinity)
function byLongest(a, b) {
  return sinceOf(a) - sinceOf(b) || (a.num || 0) - (b.num || 0)
}
// Grouped by project: projects with an agent at work (or asking you) first,
// the one at it the longest on top; then the others, in the sidebar's order.
const ACTIVE = ['waiting', 'working']
function activeSince(g) {
  const at = g.rows.filter((r) => ACTIVE.includes(r.bucket)).map(sinceOf)
  return at.length ? Math.min(...at) : null
}

// rows: paneRow(...) + { projectId, projectName, branch }.
// -> { counts: { state: n } (every row, before filter and search),
//      groups: [{ key, label, rows }] (filtered, searched) }; each row gets
//      its bucket.
export function buildDashboard(rows, { filter = 'all', query = '', groupBy = 'status' } = {}) {
  const counts = Object.fromEntries(DASHBOARD_STATES.map((s) => [s, 0]))
  const all = (rows || []).map((r) => ({ ...r, bucket: dashboardBucket(r) }))
  for (const r of all) counts[r.bucket]++
  const q = String(query || '').trim().toLowerCase()
  const shown = all.filter((r) => (filter === 'all' || r.bucket === filter) && matches(r, q))
  let groups
  if (groupBy === 'project') {
    const map = new Map()
    for (const r of shown) {
      const key = r.projectId || ''
      if (!map.has(key)) map.set(key, { key: 'project-' + key, label: r.projectName || '', rows: [] })
      map.get(key).rows.push(r)
    }
    const order = (r) => DASHBOARD_STATES.indexOf(r.bucket)
    groups = [...map.values()]
    for (const g of groups) g.rows.sort((a, b) => order(a) - order(b) || byLongest(a, b))
    const rank = new Map(groups.map((g, i) => [g, { i, at: activeSince(g) }]))
    groups.sort((a, b) => {
      const x = rank.get(a)
      const y = rank.get(b)
      if ((x.at === null) !== (y.at === null)) return x.at === null ? 1 : -1
      return (x.at !== null && x.at !== y.at ? x.at - y.at : 0) || x.i - y.i
    })
  } else {
    groups = DASHBOARD_STATES.map((s) => ({ key: s, label: s, rows: shown.filter((r) => r.bucket === s).sort(byLongest) })).filter(
      (g) => g.rows.length
    )
  }
  return { counts, groups }
}
