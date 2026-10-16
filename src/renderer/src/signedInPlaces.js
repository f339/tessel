// "Where you're signed in" (SignedInPlaces.vue), the window's side of main's
// signedInPlaces.js: the places' rows grouped by account (an agent and its
// email, account id or login), and the panes that can switch to one.

const AGENT_ORDER = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'cursor', 'kimi', 'qwen', 'opencode', 'muse']

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
  const rank = (a) => {
    const i = AGENT_ORDER.indexOf(a)
    return i < 0 ? AGENT_ORDER.length : i
  }
  const list = [...groups.values()].sort((a, b) => rank(a.agent) - rank(b.agent) || String(a.email || a.login || a.key).localeCompare(String(b.email || b.login || b.key)))
  return { groups: list, unnamed }
}

// The pane account a row stands for, when a pane can be switched to it:
// this PC, Claude Code (a Tessel account id, null: the system's sign-in);
// an SSH host, Claude Code or Codex (an account folder id, null: the
// host's own sign-in, the login shell's folder first). null: none.
export function switchTarget(place, entry, siblings = []) {
  if (!place || !entry || entry.state !== 'signed-in') return null
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
