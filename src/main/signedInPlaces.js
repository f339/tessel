// "Where you're signed in" (Settings > AI provider accounts): every place
// Tessel itself can see an agent signed in, for each account. This PC (the
// system's own sign-in and the accounts added in Tessel), each WSL distro,
// each saved SSH host (the agent's own sign-in there and the folders Tessel
// made there for one account each). Only machines Tessel knows: a provider
// does not tell which other devices an account is signed in on.
//
// places() answers at once from what is known (this PC read now; hosts and
// distros from the last scan, or "not checked"); scan(id) checks one host or
// distro (in the background, bounded in time: remoteAccounts.js,
// wslAccounts.js), so one slow host never holds the others. Identity fields
// only, never a token.
import fs from 'fs/promises'
import path from 'path'
import { entryState, FOLDER_AGENTS } from './remoteAgent/remoteAccounts'

const PLACE = /^(pc|wsl:[\w.-]{1,64}|ssh:[\w-]{1,80})$/
const LOCAL_SIGNINS = ['gemini', 'grok', 'cursor']
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

// One row of a place, the same shape wherever it was read.
function row(e) {
  return {
    agent: e.agent,
    scope: e.scope,
    id: typeof e.id === 'string' ? e.id : null,
    email: text(e.email, 254),
    org: text(e.org, 120),
    plan: text(e.plan, 40),
    login: text(e.login, 39),
    providers: Array.isArray(e.providers) ? e.providers.slice(0, 20).map((p) => ({ name: text(p.name, 40), type: text(p.type, 20) })) : undefined,
    state: e.state,
    lastSeen: Number.isFinite(e.lastSeen) ? e.lastSeen : null,
    removable: !!e.removable,
    signOut: !!e.signOut
  }
}

// A host's or distro's detection (remoteAccounts.parseAccounts) -> rows.
// actions: an SSH host's folders can be removed, its own sign-in signed out of.
export function hostRows(entries, { actions = false } = {}) {
  return (Array.isArray(entries) ? entries : []).map((e) =>
    row({
      ...e,
      state: entryState(e),
      lastSeen: e.mtimeMs,
      removable: actions && e.scope === 'tessel',
      signOut: actions && e.scope === 'default' && FOLDER_AGENTS.includes(e.agent) && e.cred === 'file'
    })
  )
}

const STATUS = { ready: 'signed-in', missing: 'missing', unknown: 'unknown' }
// accounts.list() (providerAccounts.js) -> this PC's Claude Code and Codex rows.
export function pcAccountRows(list) {
  const out = []
  for (const p of (list && Array.isArray(list.providers) && list.providers) || []) {
    if (!p || p.error || !FOLDER_AGENTS.includes(p.provider)) continue
    const s = p.system
    if (s && (s.status === 'ready' || s.email)) out.push(row({ agent: p.provider, scope: 'system', id: null, email: s.email, org: s.organization, plan: s.plan, state: STATUS[s.status] || 'unknown' }))
    for (const a of p.accounts || []) {
      if (!a || typeof a.id !== 'string') continue
      const at = Date.parse(a.lastLoginAt || '')
      out.push(row({ agent: p.provider, scope: 'tessel', id: a.id, email: a.email, org: a.organization, plan: a.plan, state: STATUS[a.status] || 'unknown', lastSeen: Number.isFinite(at) ? at : null }))
    }
  }
  return out
}

// GitHub Copilot CLI on this PC: the GitHub login its config names (never
// its token, which is in the system's credential store or another file).
export async function copilotRows({ home }) {
  try {
    const file = path.join(home, '.copilot', 'config.json')
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return []
    const user = JSON.parse(await fs.readFile(file, 'utf8'))?.last_logged_in_user
    const login = user && typeof user.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null
    return login ? [{ agent: 'copilot', scope: 'default', login, state: 'signed-in', lastSeen: stat.mtimeMs }] : []
  } catch {
    return []
  }
}

// accounts: providerAccounts.js; localSignIn(provider): usageProviderSources'
// signIn (Gemini, Grok, Cursor on this PC); localOthers(): more rows of this
// PC (Copilot); hosts: remoteHosts.js; connected(hostId): remoteFs's
// connectedQuietly; remoteAccounts: remoteAccounts.js; wsl: wslAccounts.js.
export function createSignedInPlaces({ accounts, localSignIn = async () => null, localOthers = async () => [], hosts, connected = () => false, remoteAccounts, wsl = null, now = Date.now, wslTtlMs = 60_000 } = {}) {
  const wslScans = new Map() // name -> { at, place }
  let distros = { at: 0, list: null, pending: null }

  async function pcPlace() {
    let entries = []
    try {
      entries = pcAccountRows(await accounts.list())
    } catch {
      /* this PC's accounts unreadable: the others still show */
    }
    for (const provider of LOCAL_SIGNINS) {
      try {
        const s = await localSignIn(provider)
        if (s && s.signedIn) entries.push(row({ agent: provider, scope: 'default', email: s.email, plan: s.planType, state: 'signed-in' }))
      } catch {
        /* not signed in there */
      }
    }
    try {
      for (const e of (await localOthers()) || []) entries.push(row({ ...e, state: e.state || 'signed-in' }))
    } catch {
      /* none */
    }
    return { id: 'pc', kind: 'pc', state: 'ready', at: now(), entries }
  }

  function sshPlace(target, value, state) {
    return {
      id: `ssh:${target.id}`,
      kind: 'ssh',
      hostId: target.id,
      label: text(target.label, 120) || target.id,
      state,
      at: value && value.ok ? value.at : null,
      entries: value && value.ok ? hostRows(value.entries, { actions: true }) : [],
      ...(value && value.ok && value.os ? { os: text(value.os, 40) } : {}),
      ...(value && !value.ok && value.error ? { error: text(value.error, 300) } : {})
    }
  }
  function targets() {
    try {
      return (hosts.list() || []).filter((h) => h && typeof h.id === 'string' && /^[\w-]{1,80}$/.test(h.id)).slice(0, 100)
    } catch {
      return []
    }
  }
  const isConnected = (hostId) => {
    try {
      return !!connected(hostId)
    } catch {
      return false
    }
  }

  async function distroList(fresh = false) {
    if (!wsl) return []
    if (!fresh && distros.list && now() - distros.at < wslTtlMs) return distros.list
    if (distros.pending) return distros.pending
    distros.pending = wsl
      .list()
      .then((r) => {
        distros = { at: now(), list: r && r.ok ? r.distros : [], pending: null }
        return distros.list
      })
      .catch(() => {
        distros = { at: now(), list: [], pending: null }
        return []
      })
    return distros.pending
  }
  function wslPlace(d, scanned) {
    if (scanned) return scanned
    return { id: `wsl:${d.name}`, kind: 'wsl', distro: d.name, label: d.name, state: d.running ? 'unknown' : 'stopped', at: null, entries: [] }
  }

  // Everything known now: this PC read, the rest from the last scans.
  async function places() {
    const pc = await pcPlace()
    const ssh = targets().map((target) => {
      const kept = remoteAccounts.cached(target.id)
      if (!isConnected(target.id)) return { ...sshPlace(target, kept, 'not-connected'), ...(kept ? { stale: true } : {}) }
      return sshPlace(target, kept, kept ? 'ready' : 'unknown')
    })
    const list = await distroList()
    const wslPlaces = list.map((d) => wslPlace(d, wslScans.get(d.name) && wslScans.get(d.name).place))
    return { ok: true, at: now(), places: [pc, ...wslPlaces, ...ssh] }
  }

  // One place checked now. -> its place
  async function scan(id, { fresh = false, start = false } = {}) {
    if (typeof id !== 'string' || !PLACE.test(id)) return { ok: false }
    if (id === 'pc') return { ok: true, place: await pcPlace() }
    if (id.startsWith('ssh:')) {
      const hostId = id.slice(4)
      const target = targets().find((h) => h.id === hostId)
      if (!target) return { ok: false }
      if (!isConnected(hostId)) return { ok: true, place: { ...sshPlace(target, remoteAccounts.cached(hostId), 'not-connected') } }
      const value = await remoteAccounts.detect(hostId, { fresh })
      return { ok: true, place: sshPlace(target, value, value && value.ok ? 'ready' : value && value.notConnected ? 'not-connected' : 'error') }
    }
    const name = id.slice(4)
    const d = (await distroList()).find((x) => x.name === name)
    if (!d || !wsl) return { ok: false }
    const res = await wsl.scan(name, { start })
    const place = res && res.ok
      ? { id, kind: 'wsl', distro: name, label: name, state: 'ready', at: now(), entries: hostRows(res.entries), ...(res.os ? { os: text(res.os, 40) } : {}) }
      : { id, kind: 'wsl', distro: name, label: name, state: res && res.stopped ? 'stopped' : 'error', at: null, entries: [] }
    if (res && res.ok) wslScans.set(name, { at: now(), place })
    else if (res && res.stopped) wslScans.delete(name)
    return { ok: true, place }
  }

  return { places, scan }
}
