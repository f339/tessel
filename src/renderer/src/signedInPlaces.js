// "Where you're signed in" (SignedInPlaces.vue), the window's side of main's
// signedInPlaces.js: the places' rows grouped by provider and account (an
// agent and its email, account id or login), the panes on an account and
// the panes that can switch to one.

const AGENT_ORDER = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'cursor', 'kimi', 'qwen', 'opencode', 'muse']

// The providers' order on the page.
const rank = (a) => {
  const i = AGENT_ORDER.indexOf(a)
  return i < 0 ? AGENT_ORDER.length : i
}

// An account's key, from what names it; null when nothing does (OpenCode's
// providers, a login file with no name in it).
export function accountKey(e) {
  if (!e || typeof e.agent !== 'string') return null
  const who = e.email || (e.account ? `id:${e.account}` : '') || (e.login ? `@${e.login}` : '')
  return who ? `${e.agent}|${who}` : null
}

// places -> { groups: [{ key, agent, email, login, plan, org, rows: [{ place, entry }] }], unnamed: [{ place, entry }] }
// A folder nobody signed in to yet is no account: left to its place.
export function groupAccounts(places) {
  const groups = new Map()
  const unnamed = []
  for (const place of Array.isArray(places) ? places : []) {
    for (const entry of (place && place.entries) || []) {
      if (!entry || entry.state === 'empty') continue
      const key = accountKey(entry)
      if (!key) {
        unnamed.push({ place, entry })
        continue
      }
      let g = groups.get(key)
      if (!g) {
        g = { key, agent: entry.agent, email: entry.email || null, login: entry.login || null, plan: null, org: null, rows: [] }
        groups.set(key, g)
      }
      if (!g.plan && entry.plan) g.plan = entry.plan
      if (!g.org && entry.org) g.org = entry.org
      if (!g.email && entry.email) g.email = entry.email
      g.rows.push({ place, entry })
    }
  }
  const list = [...groups.values()].sort((a, b) => rank(a.agent) - rank(b.agent) || String(a.email || a.login || a.key).localeCompare(String(b.email || b.login || b.key)))
  return { groups: list, unnamed }
}

// places -> [{ agent, accounts: [{ key, agent, email, login, plan, org,
// unknown, chips: [{ place, entry }] }] }], providers in a fixed order. The
// sign-ins that name no account a person can read (a login file with no
// email in it yet, a profile with only its account id, OpenCode's
// providers) are one "Unknown account" of their provider, a chip per place
// (each with its own state: signed in or out).
export function groupByProvider(places) {
  const { groups, unnamed } = groupAccounts(places)
  const byAgent = new Map()
  const providerOf = (agent) => {
    let p = byAgent.get(agent)
    if (!p) {
      p = { agent, accounts: [] }
      byAgent.set(agent, p)
    }
    return p
  }
  for (const g of groups) {
    if (!g.email && !g.login) unnamed.push(...g.rows)
    else providerOf(g.agent).accounts.push({ key: g.key, agent: g.agent, email: g.email, login: g.login, plan: g.plan, org: g.org, unknown: false, chips: g.rows })
  }
  for (const row of unnamed) {
    const p = providerOf(row.entry.agent)
    let u = p.accounts.find((a) => a.unknown)
    if (!u) {
      u = { key: `${row.entry.agent}|?`, agent: row.entry.agent, email: null, login: null, plan: null, org: null, unknown: true, chips: [] }
      p.accounts.push(u)
    }
    if (!u.plan && row.entry.plan) u.plan = row.entry.plan
    u.chips.push(row)
  }
  return [...byAgent.values()].sort((a, b) => rank(a.agent) - rank(b.agent))
}

// An organization worth showing beside its account: not the email again,
// nor Claude's name for a personal one ("<email>'s Organization").
export function shownOrg(org, email) {
  if (typeof org !== 'string' || !org.trim()) return ''
  const o = org.trim()
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (mail && o.toLowerCase() === mail) return ''
  const m = /^(.+?)['’]s (?:Organization|Organisation)$/i.exec(o)
  if (m && mail && (m[1].toLowerCase() === mail || m[1].toLowerCase() === mail.split('@')[0])) return ''
  return o
}

// The pane account a row stands for, when a pane can be switched to it:
// this PC, Claude Code (a Tessel account id, null: the system's sign-in);
// an SSH host, Claude Code or Codex (an account folder id, null: the
// host's own sign-in, the login shell's folder first). null: none, and
// never a folder whose sign-in file is a link (made outside Tessel: no agent
// is started on it, so it is neither a default nor a pane's target).
export function switchTarget(place, entry, siblings = []) {
  if (!place || !entry || entry.state !== 'signed-in' || entry.linked) return null
  if (place.kind === 'pc') {
    if (entry.agent !== 'claude') return null
    if (entry.scope === 'system') return { id: null }
    return entry.scope === 'tessel' && typeof entry.id === 'string' ? { id: entry.id } : null
  }
  if (place.kind !== 'ssh' || (entry.agent !== 'claude' && entry.agent !== 'codex')) return null
  if (entry.scope === 'tessel') return typeof entry.id === 'string' ? { id: entry.id } : null
  if (entry.scope === 'env') return { id: null }
  // The agent's own folder, unless the login shell names another one (a
  // plain pane starts with that one).
  if (entry.scope === 'default') return siblings.some((e) => e.agent === entry.agent && e.scope === 'env') ? null : { id: null }
  return null
}

// The open panes still running on a login of an SSH host (before it is
// removed or signed out of: main stops them, a running agent would write
// its sign-in back). A folder: the panes on it; the agent's own sign-in:
// its panes on no folder, unless the login shell names another folder for
// them (then they do not use this one).
export function panesOnLogin(place, entry, panes) {
  if (!place || place.kind !== 'ssh' || !entry || !Array.isArray(panes)) return []
  const mine = panes.filter((p) => p && p.agentId === entry.agent && p.remoteHostId === place.hostId)
  if (entry.scope === 'tessel' || entry.scope === 'orphan') return mine.filter((p) => p.hostAccount === entry.id)
  if (entry.scope !== 'default') return []
  if ((place.entries || []).some((e) => e.agent === entry.agent && e.scope === 'env')) return []
  return mine.filter((p) => typeof p.hostAccount !== 'string')
}

// The open panes on a sign-in: on an SSH host, those panesOnLogin names; on
// this PC, Claude Code's panes on that account (a Tessel account id, or the
// system's own sign-in).
export function panesOn(place, entry, panes) {
  if (!place || !entry || !Array.isArray(panes)) return []
  if (place.kind === 'ssh') return panesOnLogin(place, entry, panes)
  if (place.kind !== 'pc') return []
  const target = switchTarget(place, entry, place.entries || [])
  if (!target) return []
  return panes.filter((p) => p && !p.remoteHostId && !p.detected && p.agentId === entry.agent && (p.accountId ?? null) === target.id)
}
// The panes on an account, wherever it is signed in (each once).
export function panesUsing(account, panes) {
  const seen = new Map()
  for (const { place, entry } of (account && account.chips) || []) for (const p of panesOn(place, entry, panes)) if (!seen.has(p.id)) seen.set(p.id, p)
  return [...seen.values()]
}
// "Switch panes…": the panes on another account that can restart on this
// one, grouped by place: [{ place, items: [{ pane, target }] }]. A pane is
// offered once (the first sign-in of its place that it can switch to).
export function switchCandidates(account, panes) {
  const taken = new Set()
  const out = []
  for (const { place, entry } of (account && account.chips) || []) {
    const target = switchTarget(place, entry, place.entries || [])
    if (!target) continue
    const items = switchablePanes(place, entry, target, panes).filter((p) => !taken.has(p.id))
    if (!items.length) continue
    for (const p of items) taken.add(p.id)
    const group = out.find((g) => g.place.id === place.id)
    const list = items.map((pane) => ({ pane, target }))
    if (group) group.items.push(...list)
    else out.push({ place, items: list })
  }
  return out
}

// The places not shown with an account: { waiting, stopped, all } — waiting:
// hosts and distros not read yet (not connected, not checked, could not be
// checked); stopped: WSL distros not running; all: every host and distro.
export function placesToCheck(places, checking = {}) {
  const all = (Array.isArray(places) ? places : []).filter((p) => p && p.kind !== 'pc')
  const stopped = all.filter((p) => p.kind === 'wsl' && p.state === 'stopped' && !checking[p.id])
  const waiting = all.filter((p) => !checking[p.id] && p.state !== 'ready' && !(p.kind === 'wsl' && p.state === 'stopped'))
  return { waiting, stopped, all }
}

// The open panes (App's accountPanes.list) that can switch to that target:
// the same agent, at that place, not on it already.
export function switchablePanes(place, entry, target, panes) {
  if (!target || !Array.isArray(panes)) return []
  return panes.filter((p) => {
    if (!p || p.agentId !== entry.agent || p.detected || p.kind === 'chat') return false
    if (place.kind === 'pc') return !p.remoteHostId && (p.accountId ?? null) !== target.id
    return p.remoteHostId === place.hostId && (p.hostAccount ?? null) !== target.id
  })
}
