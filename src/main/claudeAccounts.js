// Independent implementation informed by stablyai/orca's Claude account/runtime
// auth services (MIT, Lovecast Inc., 2026). Credentials stay in private main-process
// storage; public records contain identity metadata only. Windows/file auth only.
//
// Each managed account runs Claude Code with its own config folder
// (CLAUDE_CONFIG_DIR = its auth folder): its sign-in lives there and only there,
// and Claude refreshes it there. The system login stays in ~/.claude, untouched.
// Before a launch the account's folder is linked to the system Claude folder's
// conversations, plugins, skills… and gets a copy of its settings, so every
// account shares them. The "selected" account is the default for new sessions.
import os from 'os'
import fs from 'fs/promises'
import { join, resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import { t } from './i18n'
import {
  authError,
  inspect,
  ensureDirectory,
  readText,
  writeText,
  exclusiveText,
  jsonObject,
  ownedDirectory,
  removeOwnedDirectory
} from './claudeAccountsStorage'

const MARKER = '.tessel-managed-claude-auth'
const STALE_LOGIN_MS = 60 * 60 * 1000 // a sign-in times out after 10 minutes
const LOGIN_PID = '.tessel-login-pid' // a sign-in whose end was never confirmed
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SYSTEM_FILE_LIMIT = 8 * 1024 * 1024
// The system Claude folder's folders every account uses as its own (junctions),
// created there when missing: conversations and what Claude keeps beside them,
// plugins, skills, agents, commands… Its other folders are shared too, unless
// they are Claude's own state for that folder (PRIVATE_ENTRIES).
export const SHARED_FOLDERS = [
  'projects',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'tasks',
  'plans',
  'transcripts',
  'paste-cache',
  'plugins',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'ide',
  'chrome'
]
// Each config folder's own: logins, logs, caches, state, the local install,
// and `sessions` (its live-process registry). The prompt history
// (history.jsonl) stays each account's own too.
const PRIVATE_ENTRIES = new Set([
  'api-dumps',
  'backups',
  'bridge-spawn',
  'cache',
  'ccr',
  'debug',
  'downloads',
  'dump-prompts',
  'feedback',
  'feedback-bundles',
  'file-transfers',
  'image-cache',
  'jobs',
  'local',
  'local-settings',
  'logs',
  'mcp-discovery-cache',
  'mcp-skill-archives',
  'project-settings',
  'remote',
  'remote-control',
  'scratch',
  'seed-admin',
  'sessions',
  'shares',
  'startup-perf',
  'state',
  'statsig',
  'storage-v2',
  'systemd',
  'teams',
  'telemetry',
  'traces',
  'uploads',
  'usage-data'
])
const sharedFolderName = (name) =>
  !PRIVATE_ENTRIES.has(name) &&
  !name.startsWith('.') &&
  !/^(daemon|agent-memory)/.test(name) &&
  !name.endsWith('.merge')
// Copied from the system folder before each launch (the system's copy wins).
// Copied, not linked: Claude replaces these files when it saves them. Only
// these: an unknown file could hold a login, and a second copy of one breaks it.
export const COPIED_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json']
// The keys of the system's .claude.json an account's own one never takes: its
// login and ids, first-start facts, caches, and its subscription, passes,
// usage, organization and claude.ai state (all bound to an account).
const ACCOUNT_KEYS = new Set([
  'userID',
  'machineID',
  'numStartups',
  'hasAvailableSubscription',
  'additionalModelOptionsAnsweredAt',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'startupPrefetchedAt',
  'hasRemoteEnvironment'
])
export const sharedStateKey = (key) =>
  !ACCOUNT_KEYS.has(key) &&
  !/cache|passes|oauth|api_?key|token|subscription|usage|^claudeai|^bridge|^remote|^first/i.test(key) &&
  !/^org|Org/.test(key)
const queues = new Map()
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const publicText = (value) =>
  text(value)
    ?.replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 240) || null
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const fold = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const lstatOrNull = (path) =>
  fs.lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
const absentOauth = () => ({ present: false, value: null })
const oauthField = (config) =>
  Object.hasOwn(config, 'oauthAccount')
    ? { present: true, value: config.oauthAccount }
    : absentOauth()
const identity = (value) => ({
  account: text(value?.accountUuid ?? value?.accountId),
  email: text(value?.emailAddress ?? value?.email)?.toLowerCase() || null,
  organization: text(value?.organizationUuid ?? value?.organizationId ?? value?.orgId)
})
const conflict = (a, b) =>
  ['account', 'email', 'organization'].some((k) => a[k] && b[k] && a[k] !== b[k])
function matches(a, b) {
  return (
    !conflict(a, b) &&
    !!((a.account && a.account === b.account) || (a.email && a.email === b.email)) &&
    (!a.organization || a.organization === b.organization)
  )
}
function credentials(raw) {
  if (raw === null) return null
  const parsed = jsonObject(raw)
  if (!object(parsed.claudeAiOauth) || !text(parsed.claudeAiOauth.accessToken))
    throw authError(t('main.claudeAccount.credentialsInvalid', 'Claude OAuth credentials are missing or invalid.'))
  return parsed.claudeAiOauth
}
function metadata(raw) {
  if (raw === null) return { version: 1, selectedId: null, accounts: [] }
  const value = jsonObject(raw)
  if (
    value.version !== 1 ||
    !(value.selectedId === null || typeof value.selectedId === 'string') ||
    !(value.perSession === undefined || typeof value.perSession === 'boolean') ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 100 ||
    value.accounts.some(
      (a) =>
        !object(a) ||
        !UUID.test(a.id) ||
        !object(a.identity) ||
        !['account', 'email', 'organization'].every(
          (key) => a.identity[key] === null || typeof a.identity[key] === 'string'
        ) ||
        (!a.identity.account && !a.identity.email) ||
        typeof a.lastLoginAt !== 'string'
    ) ||
    new Set(value.accounts.map((a) => a.id)).size !== value.accounts.length
  )
    throw authError()
  return value
}
// The per-entry merge of `projects` and `mcpServers`: the system's entries win,
// the account's own ones stay, and a folder trusted in the account (Tessel
// trusts it right before a launch) stays trusted.
function mergeEntries(key, own, shared) {
  if (!object(shared)) return own === undefined ? shared : own
  if (!object(own)) return shared
  const merged = { ...own, ...shared }
  if (key === 'projects')
    for (const [path, entry] of Object.entries(shared))
      if (object(own[path]) && own[path].hasTrustDialogAccepted === true && object(entry))
        merged[path] = { ...entry, hasTrustDialogAccepted: true }
  return merged
}
// An account's .claude.json: its own keys, the system's user-level ones over
// them, and its own login identity. Never a token: none is in either file's
// shared keys, and the login itself stays in .credentials.json.
export function accountState(own, system, oauth) {
  const next = { ...own }
  for (const [key, value] of Object.entries(object(system) ? system : {})) {
    if (!sharedStateKey(key)) continue
    next[key] = key === 'projects' || key === 'mcpServers' ? mergeEntries(key, own[key], value) : value
  }
  // Claude keeps its profile there fresher than the one saved at sign-in.
  next.oauthAccount =
    object(own.oauthAccount) && matches(identity(oauth), identity(own.oauthAccount)) ? own.oauthAccount : oauth
  return next
}

export function createClaudeAccounts({
  userData,
  home = os.homedir(),
  env = process.env,
  runLogin,
  now = Date.now,
  log = null,
  pidAlive = running
} = {}) {
  if (!text(userData) || !isAbsolute(userData) || !isAbsolute(home))
    throw authError(t('main.claudeAccount.absolutePaths', 'Absolute account storage and home paths are required.'))
  const data = resolve(userData)
  const accountsRoot = join(data, 'claude-accounts')
  const runtimeRoot = join(data, 'claude-runtime-auth')
  const indexPath = join(accountsRoot, 'accounts.json')
  // Left by older versions, which copied the chosen account into the system files.
  const snapshotPath = join(runtimeRoot, 'system-default-auth.json')
  const journalPath = join(runtimeRoot, 'transaction.json')
  const override = text(env.CLAUDE_CONFIG_DIR)
  if (override && !isAbsolute(override)) throw authError(t('main.claudeAccount.configDirAbsolute', 'CLAUDE_CONFIG_DIR must be absolute.'))
  const configDir = override || join(resolve(home), '.claude')
  const defaultConfigDir = fold(configDir) === fold(join(home, '.claude'))
  const credentialsPath = join(configDir, '.credentials.json')
  // Claude config-dir logins use a colocated .claude.json (also used by Orca).
  const configPath = override
    ? join(configDir, '.claude.json')
    : join(resolve(home), '.claude.json')
  const binding = { credentialsPath, configPath }
  const queueKey = process.platform === 'win32' ? data.toLowerCase() : data
  const warn = (message) => log?.warn?.('accounts', message)
  const authPath = (id) => {
    if (!UUID.test(id)) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
    return join(accountsRoot, id, 'auth')
  }
  const safe = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      throw error?.safeClaudeAccountError ? error : authError()
    }
  }
  const serialized = (fn) => {
    const previous = queues.get(queueKey) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => safe(fn))
    queues.set(queueKey, next)
    next
      .finally(() => {
        if (queues.get(queueKey) === next) queues.delete(queueKey)
      })
      .catch(() => {})
    return next
  }
  const readMetadata = async () => metadata(await readText(indexPath))
  const readConfig = async () => {
    const raw = await readText(configPath)
    const config = raw === null ? {} : jsonObject(raw)
    if (
      Object.hasOwn(config, 'oauthAccount') &&
      config.oauthAccount !== null &&
      !object(config.oauthAccount)
    )
      throw authError()
    return config
  }
  async function systemAuth() {
    // A missing child of an unreadable/link home must never look logged out.
    await inspect(resolve(home), true)
    const raw = await readText(credentialsPath)
    if (raw !== null) jsonObject(raw)
    return { credentials: raw, oauth: oauthField(await readConfig()) }
  }
  async function managed(id) {
    const path = authPath(id)
    try {
      if (!(await ownedDirectory(accountsRoot, path, MARKER, id))) return { status: 'missing' }
      const raw = await readText(join(path, '.credentials.json'))
      const accountRaw = await readText(join(path, 'oauth-account.json'))
      if (raw === null || accountRaw === null) return { status: 'missing' }
      const token = credentials(raw)
      const oauth = jsonObject(accountRaw)
      if (conflict(identity(token), identity(oauth))) throw authError()
      return { status: 'ready', raw, oauth, token }
    } catch {
      return { status: 'unknown' }
    }
  }
  function publicAccount(account, status, selectedId) {
    return {
      id: account.id,
      label: publicText(account.label) || publicText(account.email) || 'Claude account',
      email: publicText(account.email),
      organization: publicText(account.organization),
      plan: publicText(account.plan),
      status,
      lastLoginAt: account.lastLoginAt,
      active: account.id === selectedId
    }
  }
  function authStatus(auth) {
    if (auth.credentials === null) return 'missing'
    try {
      const stored = jsonObject(auth.credentials)
      // A valid credentials document may hold API/provider auth without a
      // claude.ai OAuth login. System default may still launch with that setup.
      if (!Object.hasOwn(stored, 'claudeAiOauth') || stored.claudeAiOauth === null) return 'missing'
      const token = credentials(auth.credentials)
      const who = identity(auth.oauth.value)
      return auth.oauth.present && (who.account || who.email) && !conflict(identity(token), who)
        ? 'ready'
        : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  // The system login's display fields, as a managed account's row shows them:
  // its email and organization from .claude.json, its plan from the
  // credentials' subscriptionType field (nothing else of that file leaves here).
  function systemDetails(auth) {
    const status = authStatus(auth)
    const oauth = auth.oauth.present && object(auth.oauth.value) ? auth.oauth.value : {}
    let plan = null
    try {
      if (status === 'ready') plan = publicText(credentials(auth.credentials).subscriptionType)
    } catch {
      /* no plan shown */
    }
    return {
      status,
      email: publicText(oauth.emailAddress ?? oauth.email),
      organization: publicText(oauth.organizationName ?? oauth.organizationUuid),
      plan
    }
  }
  async function snapshot() {
    const raw = await readText(snapshotPath)
    if (raw !== null) {
      const value = jsonObject(raw)
      if (
        value.version !== 1 ||
        !equal(value.binding, binding) ||
        !(value.credentials === null || typeof value.credentials === 'string') ||
        !object(value.oauth) ||
        typeof value.oauth.present !== 'boolean' ||
        (value.oauth.present && value.oauth.value !== null && !object(value.oauth.value))
      )
        throw authError(t('main.claudeAccount.systemSnapshotInvalid', 'The system-default Claude auth snapshot is unavailable or invalid.'))
      if (value.credentials !== null) jsonObject(value.credentials)
      return value
    }
    throw authError(t('main.claudeAccount.systemSnapshotMissing', 'The system-default Claude auth snapshot is missing.'))
  }
  async function slotPath(change) {
    if (change.kind === 'index') return indexPath
    if (change.kind === 'credentials') return credentialsPath
    if (change.kind === 'managedCredentials' || change.kind === 'managedOauth') {
      const path = authPath(change.id)
      if (!(await ownedDirectory(accountsRoot, path, MARKER, change.id))) throw authError()
      return join(
        path,
        change.kind === 'managedCredentials' ? '.credentials.json' : 'oauth-account.json'
      )
    }
    throw authError()
  }
  async function readSlot(change) {
    return change.kind === 'oauth'
      ? oauthField(await readConfig())
      : readText(await slotPath(change))
  }
  async function applySlot(change, value, expected) {
    const current = await readSlot(change)
    if (equal(current, value)) return
    if (!equal(current, expected))
      throw authError(
        t('main.claudeAccount.changedRecovery', 'Claude account files changed during the operation. Recovery requires the original files.')
      )
    if (change.kind === 'oauth') {
      const raw = await readText(configPath)
      const config = raw === null ? {} : jsonObject(raw)
      if (!equal(oauthField(config), expected)) throw authError()
      if (value.present) config.oauthAccount = value.value
      else delete config.oauthAccount
      await writeText(configPath, Object.keys(config).length ? encode(config) : null, raw)
    } else await writeText(await slotPath(change), value, current)
  }
  function validateJournal(value) {
    if (
      value.version !== 1 ||
      !equal(value.binding, binding) ||
      !Array.isArray(value.changes) ||
      value.changes.length > 12
    )
      throw authError()
    for (const change of value.changes) {
      if (
        !object(change) ||
        !['index', 'credentials', 'oauth', 'managedCredentials', 'managedOauth'].includes(
          change.kind
        )
      )
        throw authError()
      if (change.kind.startsWith('managed') && !UUID.test(change.id)) throw authError()
      for (const part of ['before', 'after']) {
        const v = change[part]
        if (change.kind === 'oauth') {
          if (
            !object(v) ||
            typeof v.present !== 'boolean' ||
            (v.present && v.value !== null && !object(v.value))
          )
            throw authError()
        } else if (!(v === null || typeof v === 'string')) throw authError()
        else if (change.kind === 'index') metadata(v)
        else if (v !== null) jsonObject(v)
      }
    }
  }
  async function recover() {
    const raw = await readText(journalPath)
    if (raw === null) return
    const journal = jsonObject(raw)
    validateJournal(journal)
    for (const change of [...journal.changes].reverse())
      await applySlot(change, change.before, change.after)
    await writeText(journalPath, null, raw)
  }
  async function transaction(changes) {
    const prepared = []
    for (const change of changes) {
      const before = await readSlot(change)
      if (Object.hasOwn(change, 'expected') && !equal(before, change.expected))
        throw authError(
          t('main.claudeAccount.changedRetry', 'Claude account files changed during the operation. Retry after other logins finish.')
        )
      if (!equal(before, change.after)) prepared.push({ ...change, before })
    }
    if (!prepared.length) return
    const journal = { version: 1, binding, changes: prepared }
    validateJournal(journal)
    const raw = encode(journal)
    await exclusiveText(journalPath, raw)
    try {
      for (const change of prepared) await applySlot(change, change.after, change.before)
      await writeText(journalPath, null, raw)
    } catch {
      try {
        await recover()
      } catch {
        throw authError(
          t('main.claudeAccount.rollbackFailed', 'Claude account change could not be rolled back. Launch is blocked until recovery succeeds.')
        )
      }
      throw authError(t('main.claudeAccount.changeFailed', 'Claude account change failed; the previous login was restored.'))
    }
  }
  function accountChanges(id, auth) {
    return [
      { kind: 'managedCredentials', id, after: auth.raw },
      { kind: 'managedOauth', id, after: encode(auth.oauth) }
    ]
  }
  // The system files' login, when it is this account's and newer than its
  // saved copy (an older version's session refreshed it there).
  async function refreshed(account, saved) {
    if (saved.status !== 'ready') return saved
    const runtime = await systemAuth()
    if (runtime.credentials === null) return saved
    let token
    try {
      token = credentials(runtime.credentials)
    } catch {
      return saved
    }
    const who = identity(runtime.oauth.value)
    if (!runtime.oauth.present || !matches(account.identity, who) || conflict(identity(token), who))
      return saved
    const beforeExpiry = Number(saved.token.expiresAt)
    const afterExpiry = Number(token.expiresAt)
    if (Number.isFinite(beforeExpiry) && Number.isFinite(afterExpiry) && afterExpiry < beforeExpiry)
      return saved
    return { status: 'ready', raw: runtime.credentials, oauth: runtime.oauth.value, token }
  }
  // An older version put the chosen account's login into the system Claude
  // files (after a snapshot of the system's own). Put the system login back
  // once, the account's refreshed login captured first; it stays the default
  // for new sessions. The snapshot, a copy of a login, is then deleted.
  const legacy = (state, raw) => raw !== null && state.selectedId !== null && !state.perSession
  async function migrate() {
    const raw = await readText(snapshotPath)
    if (raw === null) return
    const state = await readMetadata()
    if (legacy(state, raw)) {
      const old = state.accounts.find((a) => a.id === state.selectedId)
      let auth = old ? await managed(old.id) : null
      if (auth?.status === 'unknown')
        throw authError(
          t('main.claudeAccount.selectedUnreadable', 'The selected Claude account is unreadable. No authentication files were changed.')
        )
      const changes = []
      if (auth?.status === 'ready') {
        auth = await refreshed(old, auth)
        changes.push(...accountChanges(old.id, auth))
      }
      const original = await snapshot()
      changes.push(
        { kind: 'credentials', after: original.credentials },
        { kind: 'oauth', after: original.oauth },
        { kind: 'index', after: encode({ ...state, selectedId: old ? old.id : null, perSession: true }) }
      )
      await transaction(changes)
      if (auth?.status === 'ready') await writeOwnState(old.id, auth.oauth)
    }
    await writeText(snapshotPath, null, raw)
  }
  // Claude takes <file>.lock (a folder, proper-lockfile's way) while it writes
  // its config; so does Tessel, never breaking it. Held: false, nothing done.
  async function underClaudeLock(file, fn) {
    const lock = `${file}.lock`
    for (let i = 0; ; i++) {
      try {
        await fs.mkdir(lock)
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (i >= 4) return false
        await sleep(Math.min(250, 50 * 2 ** i))
      }
    }
    try {
      await fn()
      return true
    } finally {
      await fs.rmdir(lock).catch(() => {})
    }
  }
  // The account's own .claude.json (accountState). Best effort: a session
  // still starts without it (Claude fetches its profile itself).
  async function writeOwnState(id, oauth) {
    const file = join(authPath(id), '.claude.json')
    let system = null
    try {
      const raw = await readText(configPath)
      system = raw === null ? {} : jsonObject(raw)
    } catch {
      warn('Claude account: the system Claude settings could not be read; shared settings not updated') // i18n-ignore log
    }
    const write = async () => {
      const raw = await readText(file)
      let own = {}
      try {
        own = raw === null ? {} : jsonObject(raw)
      } catch {
        // Damaged: Claude starts it again too.
      }
      const next = accountState(own, system, oauth)
      if (raw === null || !equal(next, own)) await writeText(file, encode(next), raw)
    }
    try {
      if (!(await underClaudeLock(file, write))) warn('Claude account: its settings file is locked; shared settings not updated') // i18n-ignore log
    } catch {
      warn('Claude account: its settings file could not be updated') // i18n-ignore log
    }
  }
  // Moves what `from` holds into `to`, never over something there and never
  // through a link: what cannot move stays (counted). `from` goes once empty.
  async function drain(from, to, depth = 0) {
    let left = 0
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      try {
        const there = await lstatOrNull(target)
        if (entry.isSymbolicLink()) left++
        else if (!there) await fs.rename(source, target)
        else if (entry.isDirectory() && there.isDirectory() && !there.isSymbolicLink() && depth < 8)
          left += await drain(source, target, depth + 1)
        else left++
      } catch {
        left++
      }
    }
    if (!left) await fs.rmdir(from).catch(() => {})
    return left
  }
  // One shared folder: <account>/<name> a junction to <system>/<name>. A link
  // to another place is replaced (the link itself, never what it points to).
  // A real folder there (a session ran before it was linked) is moved aside to
  // <name>.merge and its entries into the system folder, none over one there;
  // what cannot move stays in <name>.merge and is tried again next time.
  async function linkShared(folder, name, create) {
    const source = join(configDir, name)
    const target = join(folder, name)
    const aside = `${target}.merge`
    let entry = await lstatOrNull(source)
    if (!entry && !create) return 'absent'
    if (!entry) {
      await fs.mkdir(source, { recursive: true })
      entry = await fs.lstat(source)
    }
    // The user's own link there is shared as what it points to.
    if (!(entry.isSymbolicLink() ? (await fs.stat(source)).isDirectory() : entry.isDirectory()))
      return 'absent'
    const waiting = await lstatOrNull(aside)
    if (waiting?.isDirectory() && !waiting.isSymbolicLink()) await drain(aside, source)
    const current = await lstatOrNull(target)
    let moved = false
    if (current?.isSymbolicLink()) {
      const there = await fs.realpath(target).catch(() => null)
      if (there && fold(there) === fold(await fs.realpath(source))) return 'unchanged'
      await fs.unlink(target).catch(() => fs.rmdir(target))
    } else if (current?.isDirectory()) {
      // Empty: removed. Otherwise moved aside, unless earlier entries still wait there.
      const removed = await fs.rmdir(target).then(
        () => true,
        () => false
      )
      if (!removed) {
        if (await lstatOrNull(aside)) return 'kept'
        try {
          await fs.rename(target, aside)
        } catch {
          return 'kept' // in use by a running session: next launch
        }
        moved = true
      }
    } else if (current) return 'kept'
    try {
      await fs.symlink(source, target, 'junction')
    } catch (error) {
      if (moved) await fs.rename(aside, target).catch(() => {})
      throw error
    }
    if (moved && (await drain(aside, source)))
      warn(`Claude account: some of its own ${name} entries could not be shared; kept in ${name}.merge`) // i18n-ignore log
    return 'linked'
  }
  // A system file as it is, through the user's own link if it is one;
  // null when it is not there.
  async function readSystemFile(path) {
    try {
      const stat = await fs.stat(path)
      if (!stat.isFile()) return null
      if (stat.size > SYSTEM_FILE_LIMIT) throw authError()
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }
  async function copyShared(folder, name) {
    let contents = await readSystemFile(join(configDir, name))
    // ~/.claude/CLAUDE.md is also read as a parent folder's for projects in the
    // home folder: an import of it, never a second copy of the same text.
    if (contents !== null && name === 'CLAUDE.md' && defaultConfigDir) contents = '@~/.claude/CLAUDE.md\n'
    // Gone from the system folder: gone from the account's too.
    await writeText(join(folder, name), contents)
  }
  // Before each launch on a managed account: its folder shares the system
  // one's conversations, plugins, skills and settings (each item best effort).
  async function prepare(id, auth) {
    const folder = authPath(id)
    if (!(await ownedDirectory(accountsRoot, folder, MARKER, id))) throw authError()
    let others = []
    try {
      others = (await fs.readdir(configDir)).filter((name) => sharedFolderName(name) && !SHARED_FOLDERS.includes(name))
    } catch {
      /* none yet: the listed ones are created */
    }
    for (const name of [...SHARED_FOLDERS, ...others]) {
      try {
        const outcome = await linkShared(folder, name, SHARED_FOLDERS.includes(name))
        if (outcome === 'kept') warn(`Claude account: its own ${name} folder is kept, not shared`) // i18n-ignore log
      } catch (error) {
        warn(`Claude account: ${name} could not be shared (${error?.code || 'error'})`) // i18n-ignore log
      }
    }
    for (const name of COPIED_FILES) {
      try {
        await copyShared(folder, name)
      } catch (error) {
        warn(`Claude account: ${name} could not be copied (${error?.code || 'error'})`) // i18n-ignore log
      }
    }
    await writeOwnState(id, auth.oauth)
  }
  async function login(id, { signal, onProgress } = {}) {
    await recover()
    await migrate()
    const state = await readMetadata()
    const previous = id ? state.accounts.find((a) => a.id === id) : null
    if (id && !previous) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
    if (id && (await managed(id)).status === 'unknown') throw authError()
    if (typeof runLogin !== 'function') throw authError(t('main.claudeAccount.loginUnavailable', 'Claude login is unavailable.'))
    if (signal?.aborted) throw authError(t('main.claudeAccount.loginCancelled', 'Claude login was cancelled.'))
    await removeStaleLogins()
    const loginId = randomUUID()
    const temporary = join(runtimeRoot, `login-${loginId}`)
    await ensureDirectory(temporary)
    await exclusiveText(join(temporary, MARKER), `login:${loginId}\n`)
    let created = null
    let cleanupSafe = true
    try {
      // The runner reports uncertain termination explicitly. Record that before
      // cancellation checks so an aborted, possibly live child keeps its home.
      const result = await runLogin({ provider: 'claude', home: temporary, signal, onProgress })
      cleanupSafe = result?.cleanupSafe !== false
      if (!cleanupSafe) {
        // Its folder stays until that process is seen gone (an unknown one:
        // for good).
        const pid = Number.isInteger(result.pid) && result.pid > 0 ? result.pid : ''
        await writeText(join(temporary, LOGIN_PID), `${pid}\n`).catch(() => {})
        throw Object.assign(
          authError(
            t('main.claudeAccount.stopFailed', 'Claude sign-in could not be stopped. Temporary files were retained because process termination could not be confirmed.')
          ),
          { cleanupSafe: false }
        )
      }
      if (signal?.aborted) throw authError(t('main.claudeAccount.loginCancelled', 'Claude login was cancelled.'))
      if (!result?.ok)
        throw authError(t('main.claudeAccount.loginIncomplete', 'Claude login did not complete. The previous account was preserved.'))
      const status = result.status
      const raw = await readText(join(temporary, '.credentials.json'))
      const token = credentials(raw)
      if (!token) throw authError(t('main.claudeAccount.noCredentials', 'Claude login produced no credentials.'))
      const configRaw =
        (await readText(join(temporary, '.claude.json'))) ??
        (await readText(join(temporary, '.config.json')))
      const oauth = configRaw === null ? null : jsonObject(configRaw).oauthAccount
      const who = identity(oauth)
      if (
        !object(status) ||
        status.loggedIn !== true ||
        !object(oauth) ||
        !matches(who, identity(status)) ||
        conflict(identity(token), who) ||
        (previous && !matches(previous.identity, who))
      )
        throw authError(t('main.claudeAccount.identityUnverified', 'Claude login identity could not be verified for this account.'))
      const accountId = id || randomUUID()
      const path = authPath(accountId)
      if (!id) {
        await ensureDirectory(path)
        await exclusiveText(join(path, MARKER), `${accountId}\n`)
        created = { id: accountId, path }
      } else if (!(await ownedDirectory(accountsRoot, path, MARKER, accountId))) throw authError()
      const account = {
        id: accountId,
        identity: who,
        email: publicText(oauth.emailAddress ?? oauth.email ?? status.email),
        organization: publicText(
          status.organizationName ?? status.orgName ?? oauth.organizationName ?? who.organization
        ),
        plan: publicText(status.subscriptionType ?? token.subscriptionType ?? status.plan),
        lastLoginAt: new Date(now()).toISOString()
      }
      account.label = account.email || publicText(oauth.displayName) || 'Claude account'
      const next = {
        ...state,
        accounts: [...state.accounts.filter((a) => a.id !== accountId), account]
      }
      await transaction([...accountChanges(accountId, { raw, oauth }), { kind: 'index', after: encode(next) }])
      created = null
      // Its own .claude.json right away: its usage can be read before a first session.
      await writeOwnState(accountId, oauth)
      return {
        ok: true,
        account: publicAccount(account, 'ready', state.selectedId),
        selectedId: state.selectedId,
        restartRequired: false
      }
    } finally {
      if (created) {
        // Leave files needed by a failed durable rollback for recovery.
        if ((await readText(journalPath)) === null)
          await removeOwnedDirectory(accountsRoot, created.path, MARKER, created.id)
      }
      // Only a copy of what was saved: a failed cleanup never undoes the
      // sign-in (the folder is removed by a later one).
      if (cleanupSafe)
        await removeOwnedDirectory(runtimeRoot, temporary, MARKER, `login:${loginId}`).catch(async () => {
          // At least its copy of the login goes now.
          await writeText(join(temporary, '.credentials.json'), null).catch(() => {})
        })
    }
  }
  // Sign-in folders an earlier sign-in left (its cleanup failed, or Tessel
  // stopped meanwhile): removed once no sign-in can still use them.
  async function removeStaleLogins() {
    let names
    try {
      names = await fs.readdir(runtimeRoot)
    } catch {
      return
    }
    for (const name of names) {
      const id = /^login-(.+)$/.exec(name)?.[1]
      if (!id || !UUID.test(id)) continue
      const path = join(runtimeRoot, name)
      try {
        const marker = await inspect(join(path, MARKER))
        if (!marker || Date.now() - marker.mtimeMs < STALE_LOGIN_MS) continue
        // A sign-in whose end was never confirmed: kept while it may still run.
        const pidText = await readText(join(path, LOGIN_PID))
        if (pidText !== null) {
          const pid = Number(pidText.trim())
          if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue
        }
        await removeOwnedDirectory(runtimeRoot, path, MARKER, `login:${id}`)
      } catch {
        /* kept: tried again at the next sign-in */
      }
    }
  }
  async function validSavedAccount(state, id) {
    if (id === null) return true
    const account = state.accounts.find((entry) => entry.id === id)
    if (!account) return false
    const auth = await managed(id)
    return auth.status === 'ready' && matches(account.identity, identity(auth.oauth))
  }
  const systemEnv = () => (override ? { CLAUDE_CONFIG_DIR: configDir } : {})
  return {
    // Deliberately unqueued: UI polling remains responsive during browser login.
    list: () =>
      safe(async () => {
        const state = await readMetadata()
        let system = { status: 'unknown', email: null, organization: null, plan: null }
        try {
          // Before the one-time restore, the system's login is in the snapshot.
          system = systemDetails(legacy(state, await readText(snapshotPath)) ? await snapshot() : await systemAuth())
        } catch {
          /* unknown, not missing */
        }
        const pending = await readText(journalPath)
        const accounts = await Promise.all(
          state.accounts.map(async (a) =>
            publicAccount(a, pending ? 'unknown' : (await managed(a.id)).status, state.selectedId)
          )
        )
        return {
          provider: 'claude',
          selectedId: state.selectedId,
          system: { id: null, label: 'System default', ...system, ...(pending ? { status: 'unknown' } : {}) },
          accounts
        }
      }),
    add: (options) => serialized(() => login(null, options)),
    reauthenticate: (id, options) => serialized(() => login(id, options)),
    // The default account for new sessions. Nothing else changes: each session
    // keeps the account it started with.
    select: (id) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        if (id !== null) {
          const account = state.accounts.find((a) => a.id === id)
          if (!account) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
          const auth = await managed(id)
          if (auth.status !== 'ready' || !matches(account.identity, identity(auth.oauth)))
            throw authError(t('main.claudeAccount.needsLogin', 'This Claude account needs a valid login before selection.'))
          await writeOwnState(id, auth.oauth)
        }
        await transaction([{ kind: 'index', after: encode({ ...state, selectedId: id }) }])
        return { ok: true, selectedId: id, restartRequired: false }
      }),
    remove: (id) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        if (!state.accounts.some((a) => a.id === id)) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
        if ((await managed(id)).status === 'unknown')
          throw authError(t('main.claudeAccount.removeUnsafe', 'Managed Claude auth cannot be removed safely.'))
        const selectedId = state.selectedId === id ? null : state.selectedId
        await transaction([
          { kind: 'index', after: encode({ ...state, selectedId, accounts: state.accounts.filter((a) => a.id !== id) }) }
        ])
        const result = { ok: true, selectedId, restartRequired: false }
        try {
          // Its shared folders are junctions: removed themselves, never what they point to.
          await removeOwnedDirectory(accountsRoot, authPath(id), MARKER, id, { depth: 24, count: 50000 })
          await fs.rmdir(join(accountsRoot, id)).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
          })
        } catch {
          return {
            ...result,
            warning: t('main.claudeAccount.removedNotCleaned', 'Account removed; its managed files could not be cleaned safely.')
          }
        }
        return result
      }),
    // At startup: an older version's account switch is undone once (migrate).
    migrate: () =>
      serialized(async () => {
        await recover()
        await migrate()
      }),
    // Quota reads: a managed account's login is in its own folder, where its
    // sessions refresh it; the caller checks the identity found there.
    usageScope: (accountId = undefined) =>
      safe(async () => {
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id === null) return { ok: true, env: systemEnv(), accountId: null, expectedIdentity: null }
        if (
          typeof id !== 'string' ||
          !(await validSavedAccount(state, id)) ||
          !(await inspect(join(authPath(id), '.claude.json')))
        )
          return { ok: false, error: t('main.claudeAccount.changedUnavailable', 'The selected Claude account changed or is unavailable.') }
        return {
          ok: true,
          env: { CLAUDE_CONFIG_DIR: authPath(id) },
          accountId: id,
          expectedIdentity: { ...state.accounts.find((row) => row.id === id).identity }
        }
      }),
    // Conversations are shared: every account's sessions keep them in the
    // system Claude folder (their own projects folder is linked there), read
    // there for any account, even one removed since.
    sessionEnv: (accountId = undefined) =>
      safe(async () => {
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id !== null && (typeof id !== 'string' || !UUID.test(id)))
          return { ok: false, error: t('main.claudeAccount.savedMissing', 'The saved Claude account is missing or unreadable.') }
        return { ok: true, env: systemEnv(), accountId: id }
      }),
    // undefined: the default account; null: the system login; an id: that
    // account, whichever is the default (a saved pane restarts on its own).
    launchEnv: (accountId = undefined) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id === null) {
          if (authStatus(await systemAuth()) === 'unknown')
            throw authError(t('main.claudeAccount.systemAuthUnreadable', 'System Claude authentication is unreadable; launch was refused.'))
          // The configured override (if any) stays inherited by the pane.
          return { ok: true, env: {}, accountId: null }
        }
        const account = typeof id === 'string' ? state.accounts.find((a) => a.id === id) : null
        if (!account)
          return {
            ok: false,
            error: t('main.claudeAccount.removedAccount', 'This Claude account is no longer in Tessel. Start the session on another account.')
          }
        const auth = await managed(id)
        if (auth.status === 'unknown')
          throw authError(t('main.claudeAccount.selectedAuthUnreadable', 'Selected Claude authentication is unreadable; launch was refused.'))
        if (auth.status !== 'ready' || !matches(account.identity, identity(auth.oauth)))
          return {
            ok: false,
            error: t('main.claudeAccount.signInAgain', 'This Claude account needs to sign in again (Settings > AI provider accounts).')
          }
        await prepare(id, auth)
        return { ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id }
      })
  }
}
