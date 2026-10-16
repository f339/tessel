// The agents' accounts on SSH hosts (main's remoteAgent/remoteAccounts.js),
// for the panes there: the account a pane runs on (its header and menu),
// the other accounts of the host it can restart on, and the account folders
// a new pane can start on. A pane's `hostAccount` is the id of a folder
// Tessel made on the host for one account; none: the agent's own sign-in
// there. Identity fields only: main never sends a credential here.
import { reactive } from 'vue'
import { t } from './i18n'
import { shortAccount } from './accountChoices'

// The agents Tessel can run on an account folder of a host.
export const HOST_ACCOUNT_AGENTS = ['claude', 'codex']
export const HOST_ACCOUNT_ID = /^[0-9a-z]{1,40}$/
// A host is asked again at most this often by the panes (main keeps its
// answer a little less long; a refresh you ask for is always done).
const MIN_GAP_MS = 20_000
const state = reactive({ hosts: {} })
const pending = new Map()

function api() {
  return typeof window !== 'undefined' && window.shellApi && window.shellApi.remoteAccounts
}

// A detection from main (remoteAccounts:detect), kept for its host.
export function applyHostAccounts(hostId, res, at = Date.now()) {
  if (typeof hostId !== 'string' || !hostId) return
  const old = state.hosts[hostId] || { entries: [] }
  if (res && res.ok && Array.isArray(res.entries)) {
    state.hosts[hostId] = { entries: res.entries.filter((e) => e && typeof e.agent === 'string'), at, checking: false, error: '', notConnected: false, os: res.os || null }
  } else {
    // A failed read keeps what was known.
    state.hosts[hostId] = { ...old, at, checking: false, error: (res && res.error) || '', notConnected: !!(res && res.notConnected) }
  }
}

// -> the host's accounts (once known), asked again when older than the gap.
export function refreshHostAccounts(hostId, { fresh = false } = {}) {
  const a = api()
  if (!a || !a.detect || typeof hostId !== 'string' || !hostId) return Promise.resolve(null)
  if (pending.has(hostId)) return pending.get(hostId)
  const cur = state.hosts[hostId]
  if (!fresh && cur && cur.at && Date.now() - cur.at < MIN_GAP_MS) return Promise.resolve(cur)
  state.hosts[hostId] = { ...(cur || { entries: [] }), checking: true }
  const p = Promise.resolve()
    .then(() => a.detect(hostId, { fresh }))
    .then((res) => applyHostAccounts(hostId, res))
    .catch(() => applyHostAccounts(hostId, null))
    .then(() => state.hosts[hostId])
    .finally(() => pending.delete(hostId))
  pending.set(hostId, p)
  return p
}

export function hostAccountsOf(hostId) {
  return (typeof hostId === 'string' && state.hosts[hostId]) || null
}

// Claude's "pro", Codex's "plus": as their sites write them.
export function planName(plan) {
  if (typeof plan !== 'string' || !plan.trim()) return ''
  const p = plan.trim()
  if (/^api key$/i.test(p)) return t('hostAccounts.apiKey', 'API key')
  return p
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .slice(0, 30)
}

// The entry a pane on this host runs on: its account folder, else the
// agent's own sign-in there (CLAUDE_CONFIG_DIR / CODEX_HOME from the login
// shell first, as a plain pane would start with it). null when not known.
export function hostEntry(hostId, agentId, hostAccount) {
  const host = hostAccountsOf(hostId)
  if (!host || typeof agentId !== 'string') return null
  const mine = host.entries.filter((e) => e.agent === agentId)
  if (typeof hostAccount === 'string') return mine.find((e) => e.scope === 'tessel' && e.id === hostAccount) || null
  return mine.find((e) => e.scope === 'env') || mine.find((e) => e.scope === 'default') || null
}

// What a header has room for, and the whole of it.
// -> { name, title, signedIn } or null when nothing names the account.
export function entryLabel(e, hostLabel = '') {
  if (!e) return null
  const plan = planName(e.plan) || (e.method === 'apikey' ? t('hostAccounts.apiKey', 'API key') : '')
  const who = e.email || (e.login ? `@${e.login}` : '') || (Array.isArray(e.providers) && e.providers.length ? e.providers.map((p) => p.name).join(', ') : '')
  const signedIn = e.state === 'signed-in'
  if (!who && !plan) {
    if (e.scope !== 'tessel') return null
    const name = t('hostAccounts.notSignedIn', 'not signed in yet')
    return { name, title: hostLabel ? t('hostAccounts.folderOn', 'A new account folder on {{host}}: not signed in yet', { host: hostLabel }) : name, signedIn: false }
  }
  const short = e.email ? shortAccount(e.email) : who
  const name = [short, plan].filter(Boolean).join(' · ')
  const parts = [who, plan, e.org && e.org !== who ? e.org : ''].filter(Boolean).join(' · ')
  const where = hostLabel ? t('hostAccounts.onHost', '{{account}}, on {{host}}', { account: parts, host: hostLabel }) : parts
  return {
    name,
    title: signedIn ? where : t('hostAccounts.signedOut', '{{account}} (signed out there)', { account: where }),
    signedIn
  }
}

// The account a pane on a host runs on, for its header. null when unknown.
export function hostPaneAccount(hostId, agentId, hostAccount, hostLabel = '') {
  return entryLabel(hostEntry(hostId, agentId, hostAccount), hostLabel)
}

// The accounts a pane of this agent on this host can run on: the agent's
// own sign-in there and each account folder signed in. [{ id: null | id,
// name, title }], the pane's own left out by the caller.
export function hostAccountChoices(hostId, agentId, hostLabel = '') {
  if (!HOST_ACCOUNT_AGENTS.includes(agentId)) return []
  const host = hostAccountsOf(hostId)
  if (!host) return []
  const out = []
  const own = hostEntry(hostId, agentId, undefined)
  if (own && own.state === 'signed-in') {
    const l = entryLabel(own, hostLabel)
    if (l) out.push({ id: null, name: l.name, title: t('hostAccounts.ownTitle', 'The host’s own sign-in: {{account}}', { account: l.title }) })
  }
  for (const e of host.entries) {
    if (e.agent !== agentId || e.scope !== 'tessel' || e.state !== 'signed-in' || !HOST_ACCOUNT_ID.test(String(e.id || ''))) continue
    const l = entryLabel(e, hostLabel)
    if (l) out.push({ id: e.id, name: l.name, title: l.title })
  }
  // Two with the same name: their whole email.
  for (const c of out) if (out.filter((o) => o.name === c.name).length > 1) c.name = c.title
  return out
}

// A pane's own host account, as saved with the layout: a folder id, or
// undefined (the host's own sign-in).
export function validHostAccount(v) {
  return typeof v === 'string' && HOST_ACCOUNT_ID.test(v) ? v : undefined
}
