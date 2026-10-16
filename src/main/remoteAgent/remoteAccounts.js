// Which account each agent on an SSH host (or a WSL distro) is signed in
// with, and the folders Tessel makes there for one account each, so a pane
// on the host can run on the account you choose (Claude Code with
// CLAUDE_CONFIG_DIR, Codex with CODEX_HOME), as the per-session accounts do
// on this PC (claudeAccounts.js, codexAccounts.js).
//
// What crosses the connection: the host's own shell functions
// (remoteAccounts.sh, part of remoteShell.js's prelude) print identity
// fields by name (email, organization, plan...), never a token; this module
// checks every line again (a known key, a value of its exact shape, nothing
// that looks like a key or a token, no invisible or direction characters)
// and keeps nothing else. A sign-in is never copied here or there: you sign
// in on the host, in a pane, with the agent's own login (see copyPolicy).
//
// The login shell's profile runs once per connection (its CLAUDE_CONFIG_DIR,
// CODEX_HOME and which keys it exports, kept here), and again only when you
// ask for a refresh: never on every check (a profile can start daemons).
import crypto from 'crypto'
import { t } from '../i18n'
import shellSource from './remoteAccounts.sh?raw'

// The functions the host's session may run for this (remoteShell.js FUNCTIONS).
export const ACCOUNT_FUNCTIONS = ['__t_accts', '__t_acctmk', '__t_acctrm', '__t_acctout']
// Their definitions, for the prelude (a checkout with CRLF line ends must not
// reach a POSIX sh).
export const ACCOUNTS_SHELL = String(shellSource).replace(/\r/g, '')

// The agents whose identity is read, and the ones Tessel can run on a folder
// of their own (the variable that names it).
export const ACCOUNT_AGENTS = ['claude', 'codex', 'gemini', 'copilot', 'grok', 'cursor', 'kimi', 'qwen', 'opencode']
export const FOLDER_ENV = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' })
export const FOLDER_AGENTS = Object.keys(FOLDER_ENV)
const SCOPES = new Set(['default', 'env', 'tessel', 'orphan'])
// What can make an agent use something other than its sign-in: an API key
// helper, a key, a token, a gateway (settings.json or the login shell).
export const OVERRIDES = ['helper', 'key', 'token', 'gateway']
const MAX_ENTRIES = 120
const MAX_LINES = 4000
export const ID = /^[0-9a-z]{1,40}$/
export const PANE_ID = /^pane-[\w-]{1,80}$/
const HOST_ID = /^[\w-]{1,80}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@"'<>\\]{1,64}@[^\s@"'<>\\]{1,190}\.[^\s@"'<>\\]{2,63}$/
// eslint-disable-next-line no-control-regex
const POSIX_DIR = /^\/[^\u0000-\u001f\u007f-\u009f]{0,1023}$/
// A folder whose name may go in a shell command: letters, digits and . _ @ + - / and spaces.
const SAFE_DIR = /^\/[\p{L}\p{N}._@+/ -]{1,1023}$/u
// Characters that change how a text reads: C0/C1 controls, bidi controls,
// zero-width and other invisible ones. Removed from names and emails (they
// reach a confirmation dialog). The joiners and variation selectors in it
// are listed on purpose (they are what is removed).
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g
// A key or token where a name should be (known prefixes, a JWT): never kept,
// whatever the field.
const SECRET = /(?:^|[^A-Za-z0-9])(?:sk-|sk_|rk_live|pk_live|AIza|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|glpat-|ya29\.|npm_|eyJ[\w-]{8,}\.)/

// JSON's own escapes in a value (\u00e9, \/), read as JSON reads them.
function unescape(value) {
  if (!value.includes('\\')) return value
  try {
    const v = JSON.parse(`"${value}"`)
    return typeof v === 'string' ? v : value
  } catch {
    return value
  }
}
const clean = (value) => unescape(value).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
const notSecret = (v) => (v && !SECRET.test(v) ? v : null)
const textOf = (value, max) => {
  const v = clean(value)
  return v && v.length <= max ? notSecret(v) : null
}
// Each key kept, with its check. Anything else on a line is dropped.
const FIELDS = {
  email: (v) => {
    const e = clean(v).toLowerCase()
    return EMAIL.test(e) ? notSecret(e) : null
  },
  org: (v) => textOf(v, 120),
  name: (v) => textOf(v, 120),
  orgId: (v) => (UUID.test(v) ? v.toLowerCase() : null),
  account: (v) => (UUID.test(v) ? v.toLowerCase() : null),
  plan: (v) => (/^[A-Za-z][A-Za-z0-9 _.+-]{0,23}$/.test(v) ? notSecret(v) : null),
  tier: (v) => (/^[A-Za-z0-9][A-Za-z0-9_]{0,59}$/.test(v) ? notSecret(v) : null),
  billing: (v) => (/^[A-Za-z0-9][A-Za-z0-9_]{0,59}$/.test(v) ? notSecret(v) : null),
  mode: (v) => (['chatgpt', 'chatgptAuthTokens', 'apikey'].includes(v) ? v : null),
  method: (v) => (v === 'apikey' ? v : null),
  cred: (v) => (v === 'file' ? v : null),
  login: (v) => (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v) ? notSecret(v) : null),
  site: (v) => (/^https?:\/\/[A-Za-z0-9.-]{1,100}(?::\d{1,5})?\/?$/.test(v) ? v : null)
}

// The host's answer (remoteAccounts.sh) -> { os, home, entries, loginEnv,
// envOverrides }. loginEnv: the login shell's folders ({ claude, codex },
// null when it sets none; undefined when it was not asked); envOverrides:
// the keys or tokens it exports, per agent. Lines it does not know, values
// of the wrong shape and records past the limits are left out; never throws.
export function parseAccounts(text) {
  const out = { os: null, home: null, entries: [], loginEnv: undefined, envOverrides: { claude: [], codex: [] } }
  let cur = null
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line.startsWith('@h ')) {
      const m = /^@h (\S*) (.*)$/.exec(line)
      if (m) {
        out.os = /^[\w.-]{1,40}$/.test(m[1]) ? m[1] : null
        out.home = POSIX_DIR.test(m[2]) ? m[2] : null
      }
      continue
    }
    if (line.startsWith('@e ')) {
      const m = /^@e (claude|codex) (.*)$/.exec(line)
      if (m) {
        out.loginEnv = out.loginEnv || { claude: null, codex: null }
        out.loginEnv[m[1]] = m[2] !== '-' && POSIX_DIR.test(m[2]) ? m[2] : null
      }
      continue
    }
    if (line.startsWith('@o ')) {
      const m = /^@o (claude|codex) (\w+)$/.exec(line)
      if (m && OVERRIDES.includes(m[2]) && !out.envOverrides[m[1]].includes(m[2])) out.envOverrides[m[1]].push(m[2])
      continue
    }
    if (line.startsWith('@a ')) {
      cur = null
      const m = /^@a (\S+) (\S+) (\S+) (\S+) (.*)$/.exec(line)
      if (!m || out.entries.length >= MAX_ENTRIES) continue
      const [, agent, scope, id, mtime, dir] = m
      if (!ACCOUNT_AGENTS.includes(agent) || !SCOPES.has(scope) || !POSIX_DIR.test(dir)) continue
      const folder = scope === 'tessel' || scope === 'orphan'
      if (folder ? !FOLDER_AGENTS.includes(agent) || !ID.test(id) : id !== '-') continue
      cur = { agent, scope, id: folder ? id : null, dir, mtimeMs: /^\d{1,12}$/.test(mtime) ? Number(mtime) * 1000 : null }
      out.entries.push(cur)
      continue
    }
    if (!cur || !line.startsWith('v ')) continue
    const m = /^v (\w+) (.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (key === 'provider') {
      const p = /^([\w.-]{1,40}) ([a-z]{1,20})$/.exec(value)
      if (p && cur.agent === 'opencode' && !SECRET.test(p[1])) {
        cur.providers = cur.providers || []
        if (cur.providers.length < 20 && !cur.providers.some((x) => x.name === p[1])) cur.providers.push({ name: p[1], type: p[2] })
      }
      continue
    }
    if (key === 'override') {
      if (OVERRIDES.includes(value)) {
        cur.override = cur.override || []
        if (!cur.override.includes(value)) cur.override.push(value)
      }
      continue
    }
    if (!Object.hasOwn(FIELDS, key) || Object.hasOwn(cur, key)) continue
    const v = FIELDS[key](value)
    if (v !== null) cur[key] = v
  }
  return out
}

// Whether the agent there holds a sign-in Tessel can name (or at least a
// login file): 'signed-in', 'profile' (its profile is there, its login is
// not: signed out, or kept in the macOS keychain), 'empty' (a folder Tessel
// made, not signed in yet).
export function entryState(e) {
  if (!e) return 'empty'
  if (e.cred === 'file' || e.method === 'apikey' || e.login || (e.providers && e.providers.length)) return 'signed-in'
  if (e.email || e.account) return 'profile'
  return 'empty'
}

// Copying a sign-in from this PC to a host is not offered. Claude Code and
// Codex renew their sign-in with a refresh token that can be used once: two
// copies refreshing on their own sign one of them out at the first renewal
// (this PC's per-session accounts are built never to keep a second copy of a
// login, claudeAccounts.js), and the server would hold a long-lived
// credential anyone with that account (or root) there can use. Signing in on
// the host makes a login of its own there instead, which you can sign out of
// or remove alone.
export function copyPolicy(agent) {
  return {
    allowed: false,
    agent: typeof agent === 'string' ? agent : null,
    reason: t(
      'main.remoteAccounts.noCopy',
      'Copying a sign-in from this PC is not offered: the agent renews its sign-in with a single-use token, so a copy would sign out this PC or the host at the first renewal, and the server would keep a long-lived credential. Sign in on the host instead.'
    )
  }
}

// An account folder Tessel made, safe to name in a shell command: letters,
// digits, . _ @ + - / and spaces only (never a quote, $, `, \ or a control
// or direction character), ending in its own place.
export function safeFolder(agent, dir, id) {
  return !!FOLDER_ENV[agent] && typeof dir === 'string' && ID.test(String(id || '')) && SAFE_DIR.test(dir) && dir.endsWith(`/.tessel-server/accounts/${agent}/${id}`)
}

// The words the shell prefix puts before the agent's command on the host:
// CLAUDE_CONFIG_DIR='/home/u/.tessel-server/accounts/claude/<id>' (one
// assignment, a folder Tessel made, checked by safeFolder).
export function folderPrefix(agent, dir, id) {
  return safeFolder(agent, dir, id) ? `${FOLDER_ENV[agent]}='${dir}' ` : null
}

// run(hostId, fn, args, { cap, timeoutMs, user }) -> remoteFs.accountCall's
// answer ({ rc, out } | { error, notConnected? }). confirm({ kind, host,
// agent, email, panes, keychain }) -> true only when you said yes (a dialog
// in main, never the window's word). stopPanes(hostId, paneIds) -> { ok }:
// the panes still running on a login, stopped before it is removed (a
// running agent would write its sign-in back). afterChange(hostId): a folder
// was made or removed (the shim's install sets up the team tools in the new
// one).
export function createRemoteAccounts({
  run,
  label = (hostId) => hostId,
  confirm = async () => false,
  stopPanes = async () => ({ ok: true }),
  afterChange = () => {},
  now = Date.now,
  ttlMs = 45_000,
  newId = () => crypto.randomBytes(6).toString('hex'),
  // New folders: at most this many per host in a window; launches per minute.
  limits = { creates: 6, createWindowMs: 10 * 60_000, launches: 30, launchWindowMs: 60_000 },
  log = null
} = {}) {
  const cache = new Map() // hostId -> { at, value }
  const inflight = new Map()
  // hostId -> { claude, codex, overrides }: what its login shell said, asked
  // once per connection (dropped when the host is found not connected).
  const logins = new Map()
  const hits = new Map() // kind\nhostId -> [times]
  const warn = (msg) => {
    try {
      if (log) log.warn('remote-accounts', msg)
    } catch {
      /* never mind */
    }
  }
  const hostName = (hostId) => {
    try {
      return label(hostId) || hostId
    } catch {
      return hostId
    }
  }
  const outText = (res) => (Buffer.isBuffer(res.out) ? res.out.toString('utf8') : String(res.out || ''))
  const failed = (hostId, res) => {
    if (res && res.notConnected) {
      logins.delete(hostId)
      return { ok: false, notConnected: true, error: res.error || t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostName(hostId) }) }
    }
    if (res && res.error) return { ok: false, error: String(res.error).slice(0, 300) }
    return { ok: false, error: t('main.remoteAccounts.failed', 'The accounts on {{host}} could not be read.', { host: hostName(hostId) }) }
  }
  const invalid = () => ({ ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') })
  const validAgent = (agent) => FOLDER_AGENTS.includes(agent)
  const validHost = (hostId) => typeof hostId === 'string' && HOST_ID.test(hostId)
  const paneList = (panes) => (Array.isArray(panes) ? [...new Set(panes.filter((p) => typeof p === 'string' && PANE_ID.test(p)))].slice(0, 50) : [])
  // Your yes, and only a yes: a dialog that fails or is closed is a no.
  const asked = (q) =>
    Promise.resolve()
      .then(() => confirm(q))
      .then(
        (v) => v === true,
        () => false
      )
  function rate(kind, hostId, max, windowMs) {
    const key = `${kind}\n${hostId}`
    const at = now()
    const list = (hits.get(key) || []).filter((x) => at - x < windowMs)
    if (list.length >= max) {
      hits.set(key, list)
      return false
    }
    list.push(at)
    hits.set(key, list)
    return true
  }

  async function detectNow(hostId, relogin) {
    const kept = relogin ? null : logins.get(hostId)
    const args = kept ? ['dirs', kept.claude || '-', kept.codex || '-'] : ['login']
    const res = await run(hostId, '__t_accts', args, { cap: 256 * 1024, timeoutMs: 25_000 })
    if (!res || res.error || res.notConnected || res.skipped || typeof res.rc !== 'number') return failed(hostId, res)
    if (res.rc !== 0) {
      warn(`accounts on ${hostId}: exit ${res.rc}`) // i18n-ignore log
      return failed(hostId, null)
    }
    const parsed = parseAccounts(outText(res))
    if (!kept) logins.set(hostId, { claude: parsed.loginEnv ? parsed.loginEnv.claude : null, codex: parsed.loginEnv ? parsed.loginEnv.codex : null, overrides: parsed.envOverrides })
    const login = logins.get(hostId)
    const value = { ok: true, hostId, at: now(), os: parsed.os, home: parsed.home, entries: parsed.entries, envOverrides: login ? login.overrides : { claude: [], codex: [] } }
    cache.set(hostId, { at: value.at, value })
    return value
  }

  // fresh: not the answer of the last seconds; relogin: the login shell
  // asked again too (a refresh you asked for).
  // -> { ok: true, hostId, at, os, home, entries, envOverrides } | { ok: false, notConnected?, error }
  async function detect(hostId, { fresh = false, relogin = false } = {}) {
    if (!validHost(hostId)) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    const kept = cache.get(hostId)
    if (!fresh && !relogin && kept && now() - kept.at < ttlMs) return kept.value
    if (inflight.has(hostId)) {
      const running = inflight.get(hostId)
      if (!relogin) return running
      await running.catch(() => null)
    }
    const p = detectNow(hostId, relogin)
      .catch(() => failed(hostId, null))
      .finally(() => {
        if (inflight.get(hostId) === p) inflight.delete(hostId)
      })
    inflight.set(hostId, p)
    return p
  }

  const folderOf = (res, agent, id) => {
    const dir = outText(res).split('\n')[0].trim()
    return safeFolder(agent, dir, id) ? dir : null
  }

  // A new folder for one more account of `agent` there (you sign in to it in
  // a pane). -> { ok, id, dir } | { ok: false, error }
  async function create(hostId, agent) {
    if (!validHost(hostId) || !validAgent(agent)) return invalid()
    if (!rate('create', hostId, limits.creates, limits.createWindowMs))
      return { ok: false, error: t('main.remoteAccounts.tooFast', 'Too many new accounts on {{host}} in a short time: try again in a few minutes.', { host: hostName(hostId) }) }
    const id = newId()
    if (!ID.test(id)) return invalid()
    const res = await run(hostId, '__t_acctmk', [agent, id, 'new'], { cap: 8192, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    if (res.rc === 97)
      return { ok: false, error: t('main.remoteAccounts.tooMany', '{{host}} already has too many account folders: remove one first (Settings > AI provider accounts > Where you’re signed in).', { host: hostName(hostId) }) }
    const dir = res.rc === 0 ? folderOf(res, agent, id) : null
    if (!dir) return { ok: false, error: t('main.remoteAccounts.createFailed', 'Tessel could not make the account folder on {{host}}.', { host: hostName(hostId) }) }
    cache.delete(hostId)
    try {
      await afterChange(hostId)
    } catch {
      /* the folder is there; its team tools come with the next install */
    }
    return { ok: true, id, dir }
  }

  // The folder an agent starts on (made whole again first: its links, its
  // marker checked). -> { ok, prefix, dir, name } | { ok: false, missing?, error }
  async function launchEnv(hostId, agent, id) {
    if (!validHost(hostId) || !validAgent(agent) || typeof id !== 'string' || !ID.test(id)) return invalid()
    if (!rate('launch', hostId, limits.launches, limits.launchWindowMs))
      return { ok: false, error: t('main.remoteAccounts.launchTooFast', 'Too many agents started on account folders of {{host}} in a minute: try again in a moment.', { host: hostName(hostId) }) }
    const res = await run(hostId, '__t_acctmk', [agent, id], { cap: 8192, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    if (res.rc === 91) return { ok: false, missing: true, error: t('main.remoteAccounts.gone', 'This account’s folder is no longer on {{host}}. Start the agent on another account.', { host: hostName(hostId) }) }
    const dir = res.rc === 0 ? folderOf(res, agent, id) : null
    if (!dir) return { ok: false, error: t('main.remoteAccounts.unusable', 'This account’s folder on {{host}} cannot be used safely (it was changed outside Tessel).', { host: hostName(hostId) }) }
    return { ok: true, prefix: folderPrefix(agent, dir, id), dir, name: FOLDER_ENV[agent] }
  }

  const known = (hostId, pick) => {
    const kept = cache.get(hostId)
    return (kept && kept.value.entries.find(pick)) || null
  }
  const notStopped = (hostId) => ({
    ok: false,
    error: t('main.remoteAccounts.panesRunning', 'The panes on this login on {{host}} did not stop: nothing was removed. Close them and try again.', { host: hostName(hostId) })
  })

  // Removes a folder Tessel made there (orphan: one that lost its marker but
  // still holds a sign-in), after you say yes (asked here). The panes still
  // running on it (panes: their ids, from the window) are stopped first.
  // -> { ok } | { ok: false, cancelled?, error }
  async function remove(hostId, agent, id, { panes = [], orphan = false } = {}) {
    if (!validHost(hostId) || !validAgent(agent) || typeof id !== 'string' || !ID.test(id)) return invalid()
    const running = paneList(panes)
    const entry = known(hostId, (e) => e.agent === agent && e.scope === (orphan ? 'orphan' : 'tessel') && e.id === id)
    if (!(await asked({ kind: orphan ? 'removeOrphan' : 'remove', host: hostName(hostId), agent, email: (entry && entry.email) || null, panes: running.length }))) return { ok: false, cancelled: true }
    if (running.length) {
      const stopped = await Promise.resolve()
        .then(() => stopPanes(hostId, running))
        .catch(() => null)
      if (!stopped || !stopped.ok) return notStopped(hostId)
    }
    const res = await run(hostId, '__t_acctrm', orphan ? [agent, id, 'orphan'] : [agent, id], { cap: 8192, timeoutMs: 60_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    cache.delete(hostId)
    if (res.rc === 91) return { ok: true, gone: true }
    if (res.rc !== 0) return { ok: false, error: t('main.remoteAccounts.removeFailed', 'Tessel could not remove this account’s folder from {{host}}: it was not made by Tessel, or was changed since.', { host: hostName(hostId) }) }
    try {
      await afterChange(hostId)
    } catch {
      /* nothing to set up */
    }
    return { ok: true }
  }

  // Signs the agent out of its own login there (its credentials file), after
  // you say yes: the one change to the agent's own folder Tessel ever makes.
  // The panes on that login are stopped first (they would write it back).
  // On a Mac, Claude Code's login in the Keychain stays (said, and returned).
  async function signOut(hostId, agent, { panes = [] } = {}) {
    if (!validHost(hostId) || !validAgent(agent)) return invalid()
    const running = paneList(panes)
    const entry = known(hostId, (e) => e.agent === agent && e.scope === 'default')
    const kept = cache.get(hostId)
    const keychain = agent === 'claude' && !!kept && kept.value.os === 'Darwin'
    if (!(await asked({ kind: 'signOut', host: hostName(hostId), agent, email: (entry && entry.email) || null, panes: running.length, keychain }))) return { ok: false, cancelled: true }
    if (running.length) {
      const stopped = await Promise.resolve()
        .then(() => stopPanes(hostId, running))
        .catch(() => null)
      if (!stopped || !stopped.ok) return notStopped(hostId)
    }
    const res = await run(hostId, '__t_acctout', [agent], { cap: 4096, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    cache.delete(hostId)
    if (res.rc === 91) return { ok: true, gone: true, ...(keychain ? { keychain: true } : {}) }
    if (res.rc !== 0) return { ok: false, error: t('main.remoteAccounts.signOutFailed', 'Tessel could not sign {{agent}} out on {{host}}.', { agent, host: hostName(hostId) }) }
    return { ok: true, ...(keychain ? { keychain: true } : {}) }
  }

  return {
    detect,
    create,
    launchEnv,
    remove,
    signOut,
    copyPolicy,
    cached: (hostId) => (cache.get(hostId) || {}).value || null,
    forget: (hostId) => {
      cache.delete(hostId)
      logins.delete(hostId)
    }
  }
}

// The window's copy of a detection: the same fields, nothing else (they are
// already only identity fields; this keeps the shape fixed at the boundary).
export function publicDetection(value) {
  if (!value || value.ok !== true) {
    return {
      ok: false,
      ...(value && value.notConnected ? { notConnected: true } : {}),
      error: value && typeof value.error === 'string' ? value.error.slice(0, 300) : 'failed'
    }
  }
  const over = (list) => (Array.isArray(list) ? list.filter((o) => OVERRIDES.includes(o)) : [])
  return {
    ok: true,
    hostId: value.hostId,
    at: value.at,
    os: value.os,
    home: value.home,
    entries: value.entries.map(publicEntry),
    envOverrides: { claude: over(value.envOverrides && value.envOverrides.claude), codex: over(value.envOverrides && value.envOverrides.codex) }
  }
}
const ENTRY_KEYS = ['agent', 'scope', 'id', 'dir', 'mtimeMs', 'email', 'org', 'orgId', 'account', 'name', 'plan', 'tier', 'billing', 'mode', 'method', 'cred', 'login', 'site']
export function publicEntry(e) {
  const out = {}
  for (const k of ENTRY_KEYS) if (e[k] !== undefined) out[k] = e[k]
  if (Array.isArray(e.providers)) out.providers = e.providers.map((p) => ({ name: p.name, type: p.type }))
  if (Array.isArray(e.override)) out.override = e.override.filter((o) => OVERRIDES.includes(o))
  out.state = entryState(e)
  return out
}
