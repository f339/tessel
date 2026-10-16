// Which account each agent on an SSH host (or a WSL distro) is signed in
// with, and the folders Tessel makes there for one account each, so a pane
// on the host can run on the account you choose (Claude Code with
// CLAUDE_CONFIG_DIR, Codex with CODEX_HOME), as the per-session accounts do
// on this PC (claudeAccounts.js, codexAccounts.js).
//
// What crosses the connection: the host's own shell functions
// (remoteAccounts.sh, part of remoteShell.js's prelude) print identity
// fields by name (email, organization, plan...), never a token; this module
// checks every line again (a known key, a value of the expected shape) and
// keeps nothing else. A sign-in is never copied here or there: you sign in
// on the host, in a pane, with the agent's own login (see copyPolicy).
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
const SCOPES = new Set(['default', 'env', 'tessel'])
const MAX_ENTRIES = 120
const MAX_LINES = 4000
export const ID = /^[0-9a-z]{1,40}$/
const HOST_ID = /^[\w-]{1,80}$/
const EMAIL = /^[^\s@"'<>\\]{1,64}@[^\s@"'<>\\]{1,190}\.[^\s@"'<>\\]{2,63}$/
// eslint-disable-next-line no-control-regex
const POSIX_DIR = /^\/[^\u0000-\u001f\u007f]{0,1023}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

// JSON's own escapes in a value (é, \/), read as JSON reads them.
function unescape(value) {
  if (!value.includes('\\')) return value
  try {
    const v = JSON.parse(`"${value}"`)
    return typeof v === 'string' ? v : value
  } catch {
    return value
  }
}
const textOf = (value, max) => {
  const v = unescape(value).replace(CONTROL, ' ').trim()
  return v && v.length <= max ? v : null
}
// Each key kept, with its check. Anything else on a line is dropped.
const FIELDS = {
  email: (v) => {
    const e = unescape(v).trim().toLowerCase()
    return EMAIL.test(e) ? e : null
  },
  org: (v) => textOf(v, 120),
  name: (v) => textOf(v, 120),
  orgId: (v) => (/^[\w-]{1,80}$/.test(v) ? v : null),
  account: (v) => (/^[\w-]{1,80}$/.test(v) ? v : null),
  plan: (v) => (/^[\w .+-]{1,40}$/.test(v) ? v : null),
  tier: (v) => (/^[\w .+-]{1,60}$/.test(v) ? v : null),
  billing: (v) => (/^[\w .+-]{1,60}$/.test(v) ? v : null),
  mode: (v) => (/^[\w-]{1,40}$/.test(v) ? v : null),
  method: (v) => (v === 'apikey' ? v : null),
  cred: (v) => (v === 'file' ? v : null),
  login: (v) => (/^[A-Za-z0-9-]{1,39}$/.test(v) ? v : null),
  site: (v) => (/^[\w.:/-]{1,100}$/.test(v) ? v : null)
}

// The host's answer (remoteAccounts.sh) -> { os, home, entries }. Lines it
// does not know, values of the wrong shape and records past the limits are
// left out; never throws.
export function parseAccounts(text) {
  const out = { os: null, home: null, entries: [] }
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
    if (line.startsWith('@a ')) {
      cur = null
      const m = /^@a (\S+) (\S+) (\S+) (\S+) (.*)$/.exec(line)
      if (!m || out.entries.length >= MAX_ENTRIES) continue
      const [, agent, scope, id, mtime, dir] = m
      if (!ACCOUNT_AGENTS.includes(agent) || !SCOPES.has(scope) || !POSIX_DIR.test(dir)) continue
      if (scope === 'tessel' ? !FOLDER_AGENTS.includes(agent) || !ID.test(id) : id !== '-') continue
      cur = { agent, scope, id: scope === 'tessel' ? id : null, dir, mtimeMs: /^\d{1,12}$/.test(mtime) ? Number(mtime) * 1000 : null }
      out.entries.push(cur)
      continue
    }
    if (!cur || !line.startsWith('v ')) continue
    const m = /^v (\w+) (.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (key === 'provider') {
      const p = /^([\w.-]{1,40}) ([a-z]{1,20})$/.exec(value)
      if (p && cur.agent === 'opencode') {
        cur.providers = cur.providers || []
        if (cur.providers.length < 20 && !cur.providers.some((x) => x.name === p[1])) cur.providers.push({ name: p[1], type: p[2] })
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

// The words the shell prefix puts before the agent's command on the host:
// CLAUDE_CONFIG_DIR='/home/u/.tessel-server/accounts/claude/<id>' (one
// assignment, a path Tessel made: no quote can be in it).
export function folderPrefix(agent, dir, id) {
  const name = FOLDER_ENV[agent]
  if (!name || typeof dir !== 'string' || !ID.test(String(id || ''))) return null
  if (!POSIX_DIR.test(dir) || dir.includes("'") || !dir.endsWith(`/.tessel-server/accounts/${agent}/${id}`)) return null
  return `${name}='${dir}' `
}

// run(hostId, fn, args, { cap, timeoutMs, user }) -> remoteFs.accountCall's
// answer ({ rc, out } | { error, notConnected? }). confirm({ kind, host,
// agent, email }) -> true only when you said yes (a dialog in main, never
// the window's word). afterChange(hostId): a folder was made or removed
// (the shim's install sets up the team tools in the new one).
export function createRemoteAccounts({
  run,
  label = (hostId) => hostId,
  confirm = async () => false,
  afterChange = () => {},
  now = Date.now,
  ttlMs = 45_000,
  newId = () => crypto.randomBytes(6).toString('hex'),
  log = null
} = {}) {
  const cache = new Map() // hostId -> { at, value }
  const inflight = new Map()
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
    if (res && res.notConnected) return { ok: false, notConnected: true, error: res.error || t('main.remoteFs.notConnected', '{{host}} is not connected. Use Connect to sign in.', { host: hostName(hostId) }) }
    if (res && res.error) return { ok: false, error: String(res.error).slice(0, 300) }
    return { ok: false, error: t('main.remoteAccounts.failed', 'The accounts on {{host}} could not be read.', { host: hostName(hostId) }) }
  }
  const validAgent = (agent) => FOLDER_AGENTS.includes(agent)
  // Your yes, and only a yes: a dialog that fails or is closed is a no.
  const asked = (q) =>
    Promise.resolve()
      .then(() => confirm(q))
      .then(
        (v) => v === true,
        () => false
      )

  async function detectNow(hostId) {
    const res = await run(hostId, '__t_accts', ['login'], { cap: 256 * 1024, timeoutMs: 25_000 })
    if (!res || res.error || res.notConnected || res.skipped || typeof res.rc !== 'number') return failed(hostId, res)
    if (res.rc !== 0) {
      warn(`accounts on ${hostId}: exit ${res.rc}`) // i18n-ignore log
      return failed(hostId, null)
    }
    const parsed = parseAccounts(outText(res))
    const value = { ok: true, hostId, at: now(), os: parsed.os, home: parsed.home, entries: parsed.entries }
    cache.set(hostId, { at: value.at, value })
    return value
  }

  // -> { ok: true, hostId, at, os, home, entries } | { ok: false, notConnected?, error }
  function detect(hostId, { fresh = false } = {}) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) return Promise.resolve({ ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') })
    const kept = cache.get(hostId)
    if (!fresh && kept && now() - kept.at < ttlMs) return Promise.resolve(kept.value)
    if (inflight.has(hostId)) return inflight.get(hostId)
    const p = detectNow(hostId)
      .catch(() => failed(hostId, null))
      .finally(() => inflight.delete(hostId))
    inflight.set(hostId, p)
    return p
  }

  const folderOf = (res, agent, id) => {
    const dir = outText(res).split('\n')[0].trim()
    return folderPrefix(agent, dir, id) ? dir : null
  }

  // A new folder for one more account of `agent` there (you sign in to it in
  // a pane). -> { ok, id, dir } | { ok: false, error }
  async function create(hostId, agent) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !validAgent(agent)) return { ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') }
    const id = newId()
    if (!ID.test(id)) return { ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') }
    const res = await run(hostId, '__t_acctmk', [agent, id, 'new'], { cap: 8192, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
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

  // The prefix that starts the agent on that folder (made whole again first:
  // its links, its marker checked). -> { ok, prefix, dir } | { ok: false, missing?, error }
  async function launchEnv(hostId, agent, id) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !validAgent(agent) || typeof id !== 'string' || !ID.test(id)) return { ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') }
    const res = await run(hostId, '__t_acctmk', [agent, id], { cap: 8192, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    if (res.rc === 91) return { ok: false, missing: true, error: t('main.remoteAccounts.gone', 'This account’s folder is no longer on {{host}}. Start the agent on another account.', { host: hostName(hostId) }) }
    const dir = res.rc === 0 ? folderOf(res, agent, id) : null
    if (!dir) return { ok: false, error: t('main.remoteAccounts.unusable', 'This account’s folder on {{host}} cannot be used safely (it was changed outside Tessel).', { host: hostName(hostId) }) }
    return { ok: true, prefix: folderPrefix(agent, dir, id), dir }
  }

  const known = (hostId, pick) => {
    const kept = cache.get(hostId)
    return (kept && kept.value.entries.find(pick)) || null
  }

  // Removes a folder Tessel made there, after you say yes (asked here).
  // -> { ok } | { ok: false, cancelled?, error }
  async function remove(hostId, agent, id) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !validAgent(agent) || typeof id !== 'string' || !ID.test(id)) return { ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') }
    const entry = known(hostId, (e) => e.agent === agent && e.scope === 'tessel' && e.id === id)
    if (!(await asked({ kind: 'remove', host: hostName(hostId), agent, email: (entry && entry.email) || null }))) return { ok: false, cancelled: true }
    const res = await run(hostId, '__t_acctrm', [agent, id], { cap: 8192, timeoutMs: 60_000, user: true })
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
  async function signOut(hostId, agent) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !validAgent(agent)) return { ok: false, error: t('main.remoteAccounts.invalid', 'This account cannot be used on this host.') }
    const entry = known(hostId, (e) => e.agent === agent && e.scope === 'default')
    if (!(await asked({ kind: 'signOut', host: hostName(hostId), agent, email: (entry && entry.email) || null }))) return { ok: false, cancelled: true }
    const res = await run(hostId, '__t_acctout', [agent], { cap: 4096, timeoutMs: 20_000, user: true })
    if (!res || res.error || res.notConnected || typeof res.rc !== 'number') return failed(hostId, res)
    cache.delete(hostId)
    if (res.rc === 91) return { ok: true, gone: true }
    if (res.rc !== 0) return { ok: false, error: t('main.remoteAccounts.signOutFailed', 'Tessel could not sign {{agent}} out on {{host}}.', { agent, host: hostName(hostId) }) }
    return { ok: true }
  }

  return {
    detect,
    create,
    launchEnv,
    remove,
    signOut,
    copyPolicy,
    cached: (hostId) => (cache.get(hostId) || {}).value || null,
    forget: (hostId) => cache.delete(hostId)
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
  return {
    ok: true,
    hostId: value.hostId,
    at: value.at,
    os: value.os,
    home: value.home,
    entries: value.entries.map(publicEntry)
  }
}
const ENTRY_KEYS = ['agent', 'scope', 'id', 'dir', 'mtimeMs', 'email', 'org', 'orgId', 'account', 'name', 'plan', 'tier', 'billing', 'mode', 'method', 'cred', 'login', 'site']
export function publicEntry(e) {
  const out = {}
  for (const k of ENTRY_KEYS) if (e[k] !== undefined) out[k] = e[k]
  if (Array.isArray(e.providers)) out.providers = e.providers.map((p) => ({ name: p.name, type: p.type }))
  out.state = entryState(e)
  return out
}
