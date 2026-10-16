// The agents' accounts on SSH hosts (main's remoteAgent/remoteAccounts.js),
// for the panes there: the account a pane runs on (its header and menu),
// the other accounts of the host it can restart on, and the account folders
// a new pane can start on. A pane's `hostAccount` is the id of a folder
// Tessel made on the host for one account; none: the agent's own sign-in
// there. Identity fields only: main never sends a credential here.
//
// One timer per host, whatever the number of its panes: every minute, and
// sooner (15 s, then slower) while one of its panes waits for a sign-in in
// its account folder, or for the name of an account signed in (Claude Code
// writes the email once it has its profile); that wait ends once the folder
// is signed in and named, or gone.
import { reactive } from 'vue'
import { t } from './i18n'
import { shortAccount } from './accountChoices'
import { settings } from './settings'

// The agents Tessel can run on an account folder of a host.
export const HOST_ACCOUNT_AGENTS = ['claude', 'codex']
export const HOST_ACCOUNT_ID = /^[0-9a-z]{1,40}$/
// A host is asked again at most this often by the panes (main keeps its
// answer a little less long; a refresh you ask for is always done).
const MIN_GAP_MS = 20_000
export const POLL_MS = 60_000
export const WAIT_FIRST_MS = 15_000
export const WAIT_MAX_MS = 120_000
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
    state.hosts[hostId] = {
      entries: res.entries.filter((e) => e && typeof e.agent === 'string'),
      envOverrides: res.envOverrides && typeof res.envOverrides === 'object' ? res.envOverrides : {},
      at,
      checking: false,
      error: '',
      notConnected: false,
      os: res.os || null
    }
  } else {
    // A failed read keeps what was known.
    state.hosts[hostId] = { ...old, at, checking: false, error: (res && res.error) || '', notConnected: !!(res && res.notConnected) }
  }
}

// -> the host's accounts (once known), asked again when older than the gap.
// relogin: its login shell asked again too (a refresh you asked for).
export function refreshHostAccounts(hostId, { fresh = false, relogin = false } = {}) {
  const a = api()
  if (!a || !a.detect || typeof hostId !== 'string' || !hostId) return Promise.resolve(null)
  if (pending.has(hostId)) return pending.get(hostId)
  const cur = state.hosts[hostId]
  if (!fresh && !relogin && cur && cur.at && Date.now() - cur.at < MIN_GAP_MS) return Promise.resolve(cur)
  state.hosts[hostId] = { ...(cur || { entries: [] }), checking: true }
  const p = Promise.resolve()
    .then(() => a.detect(hostId, relogin ? { fresh: true, relogin: true } : { fresh }))
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

// --- One timer per host -----------------------------------------------------
const watchers = new Map() // hostId -> { panes: Map(paneId -> { agentId, hostAccount }), timer, wait }
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

// Signed in with its login file, the account not named yet (no API key:
// that one never has an email).
export function unnamedEntry(e) {
  return !!e && e.state === 'signed-in' && e.cred === 'file' && !e.email && e.method !== 'apikey'
}
// A pane waits while its account folder is there and not signed in yet, or
// while the account it runs on (a folder, or the host's own) is signed in
// but not named yet (a folder that is gone is no wait).
function waiting(hostId) {
  const w = watchers.get(hostId)
  if (!w) return false
  for (const p of w.panes.values()) {
    const e = hostEntry(hostId, p.agentId, p.hostAccount)
    if (unnamedEntry(e) || (typeof p.hostAccount === 'string' && e && e.state !== 'signed-in')) return true
  }
  return false
}
function schedule(hostId) {
  const w = watchers.get(hostId)
  if (!w) return
  clearTimeout(w.timer)
  const wait = waiting(hostId)
  // While one waits: 15 s, then twice as long each time, at most 2 min.
  w.wait = wait ? (w.wait ? Math.min(w.wait * 2, WAIT_MAX_MS) : WAIT_FIRST_MS) : 0
  w.timer = setTimeout(async () => {
    if (watchers.get(hostId) !== w) return
    if (visible()) await refreshHostAccounts(hostId, { fresh: wait }).catch(() => null)
    schedule(hostId)
  }, wait ? w.wait : POLL_MS)
}

// A pane on this host (agentId, hostAccount) follows its accounts.
export function watchHostAccounts(hostId, paneId, { agentId, hostAccount } = {}) {
  if (typeof hostId !== 'string' || !hostId || typeof paneId !== 'string') return
  let w = watchers.get(hostId)
  if (!w) {
    w = { panes: new Map(), timer: null, wait: 0 }
    watchers.set(hostId, w)
  }
  const before = w.panes.get(paneId)
  w.panes.set(paneId, { agentId, hostAccount: typeof hostAccount === 'string' ? hostAccount : undefined })
  // A pane that starts waiting begins its back-off afresh.
  if (!before || before.hostAccount !== hostAccount) w.wait = 0
  hookFocus()
  refreshHostAccounts(hostId)
    .catch(() => null)
    .then(() => watchers.get(hostId) === w && schedule(hostId))
}
export function unwatchHostAccounts(hostId, paneId) {
  const w = watchers.get(hostId)
  if (!w) return
  w.panes.delete(paneId)
  if (!w.panes.size) {
    clearTimeout(w.timer)
    watchers.delete(hostId)
  }
}
// Check again (the pane's account menu, its hover card): the host asked now,
// past the last answer and the back-off.
export function checkHostAccountsNow(hostId) {
  const w = watchers.get(hostId)
  if (w) w.wait = 0
  return refreshHostAccounts(hostId, { fresh: true }).then((r) => {
    if (watchers.get(hostId) === w && w) schedule(hostId)
    return r
  })
}

// Back in Tessel (after a sign-in finished in the browser, say): each host
// where a pane waits is asked at once (at most every MIN_GAP_MS), its
// back-off begun afresh. A listener, not a timer.
let focusHooked = false
function onFocusBack() {
  for (const hostId of watchers.keys()) {
    const cur = state.hosts[hostId]
    if (!waiting(hostId) || pending.has(hostId) || (cur && cur.at && Date.now() - cur.at < MIN_GAP_MS)) continue
    checkHostAccountsNow(hostId).catch(() => null)
  }
}
function hookFocus() {
  if (focusHooked || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  focusHooked = true
  window.addEventListener('focus', onFocusBack)
}

// A turn of an agent on this host ended (a /login, its first answer): its
// account not fully known yet (not signed in, or no email), the host is
// asked again a few seconds later (Claude Code writes the email once it has
// fetched its profile). -> the timer to clear, or null
export function recheckAfterTurn(hostId, agentId, hostAccount, delayMs = 4000) {
  if (typeof hostId !== 'string' || !hostId || !HOST_ACCOUNT_AGENTS.includes(agentId)) return null
  const e = hostEntry(hostId, agentId, hostAccount)
  if (e && e.state === 'signed-in' && (e.email || e.method === 'apikey')) return null
  return setTimeout(() => checkHostAccountsNow(hostId).catch(() => null), delayMs)
}

// For tests: the hosts followed, their panes and their next wait.
export function hostWatchers() {
  return [...watchers].map(([hostId, w]) => ({ hostId, panes: w.panes.size, wait: w.wait }))
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

// What makes the agent there use something else than this sign-in (its
// settings.json, the login shell's exports): words for a title.
export function overrideText(list) {
  const kinds = Array.isArray(list) ? list : []
  const words = []
  if (kinds.includes('helper')) words.push(t('hostAccounts.override.helper', 'an API key helper'))
  if (kinds.includes('key')) words.push(t('hostAccounts.override.key', 'an API key'))
  if (kinds.includes('token')) words.push(t('hostAccounts.override.token', 'a sign-in token'))
  if (kinds.includes('gateway')) words.push(t('hostAccounts.override.gateway', 'a gateway address'))
  return words.join(', ')
}

// What a header has room for, and the whole of it.
// envOverrides: the host's login shell exports ({ claude: [...], codex: [...] }).
// -> { name, title, signedIn, override, unknown } or null when nothing names
// the account. unknown: signed in, but the account's email is not known yet
// (Claude Code writes it once it has fetched its profile).
export function entryLabel(e, hostLabel = '', envOverrides = null) {
  if (!e) return null
  const plan = planName(e.plan) || (e.method === 'apikey' ? t('hostAccounts.apiKey', 'API key') : '')
  const who = e.email || (e.login ? `@${e.login}` : '') || (Array.isArray(e.providers) && e.providers.length ? e.providers.map((p) => p.name).join(', ') : '')
  const signedIn = e.state === 'signed-in'
  const override = [...new Set([...(Array.isArray(e.override) ? e.override : []), ...(envOverrides && Array.isArray(envOverrides[e.agent]) ? envOverrides[e.agent] : [])])]
  if (!who && signedIn) {
    // Signed in (its login is there), the account not named yet: its plan.
    const name = (plan || t('hostAccounts.signedInShort', 'signed in')) + (override.length || e.linked ? ' ⚠' : '')
    const what = [e.planName || plan, hostLabel ? t('hostAccounts.onHostShort', 'on {{host}}', { host: hostLabel }) : ''].filter(Boolean).join(' ')
    let title = t('hostAccounts.unknownAccount', '{{what}}: signed in, account unknown (its email is not known yet). Check again once the agent has answered.', { what: what || t('hostAccounts.signedInShort', 'signed in') })
    if (override.length) title += `\n${t('hostAccounts.overrideNote', 'Note: {{what}} set on the host is used instead of this sign-in (settings.json or the login shell).', { what: overrideText(override) })}`
    if (e.linked) title += `\n${t('hostAccounts.linkedNote', 'Its sign-in file is a link to another folder (made outside Tessel): agents are not started on it.')}`
    return { name, title, signedIn: true, override, unknown: true }
  }
  if (!who && !plan) {
    if (e.scope !== 'tessel') return null
    const name = t('hostAccounts.notSignedIn', 'not signed in yet')
    return { name, title: hostLabel ? t('hostAccounts.folderOn', 'A new account folder on {{host}}: not signed in yet', { host: hostLabel }) : name, signedIn: false, override }
  }
  const short = e.email ? shortAccount(e.email) : who
  const name = [short, plan].filter(Boolean).join(' · ') + (override.length || e.linked ? ' ⚠' : '')
  const parts = [who, e.planName || plan, e.org && e.org !== who ? e.org : ''].filter(Boolean).join(' · ')
  const where = hostLabel ? t('hostAccounts.onHost', '{{account}}, on {{host}}', { account: parts, host: hostLabel }) : parts
  let title = signedIn ? where : t('hostAccounts.signedOut', '{{account}} (signed out there)', { account: where })
  if (override.length) title += `\n${t('hostAccounts.overrideNote', 'Note: {{what}} set on the host is used instead of this sign-in (settings.json or the login shell).', { what: overrideText(override) })}`
  if (e.linked) title += `\n${t('hostAccounts.linkedNote', 'Its sign-in file is a link to another folder (made outside Tessel): agents are not started on it.')}`
  return { name, title, signedIn, override }
}

// The account a pane on a host runs on, for its header. null when unknown.
export function hostPaneAccount(hostId, agentId, hostAccount, hostLabel = '') {
  const host = hostAccountsOf(hostId)
  return entryLabel(hostEntry(hostId, agentId, hostAccount), hostLabel, host && host.envOverrides)
}

// The account new panes of this agent use on this host (Settings, saved per
// host and agent): a folder id, or undefined (the host's own sign-in).
export function defaultHostAccount(hostId, agentId) {
  const d = settings.hostAccountDefaults && settings.hostAccountDefaults[hostId]
  return d && typeof d[agentId] === 'string' && HOST_ACCOUNT_ID.test(d[agentId]) ? d[agentId] : undefined
}
// id: a folder id, or null: the host's own sign-in (no default kept).
export function setDefaultHostAccount(hostId, agentId, id) {
  if (typeof hostId !== 'string' || !/^[\w-]{1,80}$/.test(hostId) || !HOST_ACCOUNT_AGENTS.includes(agentId)) return
  const all = { ...(settings.hostAccountDefaults || {}) }
  const mine = { ...(all[hostId] || {}) }
  if (typeof id === 'string' && HOST_ACCOUNT_ID.test(id)) mine[agentId] = id
  else delete mine[agentId]
  if (Object.keys(mine).length) all[hostId] = mine
  else delete all[hostId]
  settings.hostAccountDefaults = all
}
// Whether this account (a folder id, or null: the host's own) is the one
// new panes of this agent use on this host.
export function isDefaultHostAccount(hostId, agentId, id) {
  return (defaultHostAccount(hostId, agentId) ?? null) === (typeof id === 'string' ? id : null)
}

// The accounts a pane of this agent on this host can run on: the agent's
// own sign-in there and each account folder signed in. [{ id: null | id,
// name, title, isDefault }], the pane's own left out by the caller.
export function hostAccountChoices(hostId, agentId, hostLabel = '') {
  if (!HOST_ACCOUNT_AGENTS.includes(agentId)) return []
  const host = hostAccountsOf(hostId)
  if (!host) return []
  const out = []
  const own = hostEntry(hostId, agentId, undefined)
  if (own && own.state === 'signed-in') {
    const l = entryLabel(own, hostLabel, host.envOverrides)
    if (l) out.push({ id: null, name: l.name, title: t('hostAccounts.ownTitle', 'The host’s own sign-in: {{account}}', { account: l.title }) })
  }
  for (const e of host.entries) {
    if (e.agent !== agentId || e.scope !== 'tessel' || e.state !== 'signed-in' || e.linked || !HOST_ACCOUNT_ID.test(String(e.id || ''))) continue
    const l = entryLabel(e, hostLabel, host.envOverrides)
    if (l) out.push({ id: e.id, name: l.name, title: l.title })
  }
  // Two with the same name: their whole email.
  for (const c of out) if (out.filter((o) => o.name === c.name).length > 1) c.name = c.title
  for (const c of out) c.isDefault = isDefaultHostAccount(hostId, agentId, c.id)
  return out
}

// "Restart on <default>": the host's default account for this agent, when
// the pane runs on another one and the default can be started on (signed in
// there). -> the choice ({ id, name, title, isDefault }) or null
export function defaultRestartChoice(hostId, agentId, paneAccount, hostLabel = '') {
  const want = defaultHostAccount(hostId, agentId) ?? null
  if (want === (typeof paneAccount === 'string' ? paneAccount : null)) return null
  return hostAccountChoices(hostId, agentId, hostLabel).find((c) => c.id === want) || null
}

// A pane's own host account, as saved with the layout: a folder id, or
// undefined (the host's own sign-in).
export function validHostAccount(v) {
  return typeof v === 'string' && HOST_ACCOUNT_ID.test(v) ? v : undefined
}
// ...or what a pane chose: a folder id, null (the host's own sign-in, chosen
// or started on), undefined (nothing chosen: the host's default applies).
export function hostAccountChoice(v) {
  return v === null ? null : validHostAccount(v)
}
