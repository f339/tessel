// Muse Code runs every hook with a cleared environment: a hook in its
// settings or a project gets only HOME, PATH and a few others, never the
// pane's TESSEL_* variables, so it could not tell which pane it belongs to.
// Only a managed hooks file also gets the variables its settings name
// (managed_hooks_env_vars). Tessel's status hooks file is its own
// (agentStatusHooks.js); here, only the two settings that make it Muse's
// managed file are added to Muse's settings.json, or taken out:
//   "managed_hooks_path": "<Tessel's hooks file>",
//   "managed_hooks_env_vars": [..., "TESSEL_PANE_ID", ...]
// Muse has one managed file: one of someone else's (an administrator's, or
// another app's) is never replaced. Every other setting is kept as it is, and
// the file needs "schema_version": 1 (Muse refuses to start without it).
// What Tessel itself added (the pointer, each variable name) is noted beside
// its hooks file (tessel-status-hooks.added.json): only that is taken out
// again, never a pointer or a name that was there before.
//
// After Muse Code's hooks guide (meta-models.github.io/muse-code-sdk, Hooks:
// managed file, environment) and Orca's Muse hook service, MIT, Copyright
// (c) 2026 Lovecast Inc.
import fs from 'fs'
import os from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'
import { museSettingsFile } from './museSessions'

// What the status hook needs of the pane's environment (teamMcp/server.cjs:
// reportAgentState, reportSession).
export const MUSE_HOOK_ENV = ['TESSEL_PANE_ID', 'TESSEL_AGENT_PROVIDER', 'TESSEL_AGENT_LAUNCH', 'TESSEL_AGENT_STATE_DIR', 'TESSEL_SESSIONS_DIR', 'TESSEL_REMOTE']

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sameName = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()

// -> { settings, exists } or { error } (a file Tessel cannot read is never changed).
function read(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    if (error.code === 'ENOENT') return { settings: {}, exists: false }
    return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
  }
  if (!text.trim()) return { settings: {}, exists: true }
  try {
    const settings = JSON.parse(text)
    if (record(settings)) return { settings, exists: true }
  } catch {
    /* below */
  }
  return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
}

// The managed file the settings name (absolute: a relative one is Muse's,
// against the settings' folder), or null.
function pointer(settings, file) {
  const p = settings.managed_hooks_path
  if (typeof p !== 'string' || !p.trim()) return null
  return isAbsolute(p.trim()) ? resolve(p.trim()) : resolve(dirname(file), p.trim())
}
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

const elsewhere = (file, other) =>
  t('main.hooks.museManagedTaken', "{{file}} already names another managed hooks file ({{other}}), so Tessel did not replace it. Remove its managed_hooks_path to let Tessel read Muse Code's status.", { file, other })
const badEnvList = (file) =>
  t('main.hooks.museEnvList', '{{file}} has a managed_hooks_env_vars that is not a list of names, so Tessel did not change it.', { file })

// What Tessel added to Muse's settings: { pointer, envVars } (nothing known:
// nothing of Tessel's).
const addedFile = (hooksFile) => join(dirname(hooksFile), 'tessel-status-hooks.added.json')
function readAdded(hooksFile) {
  try {
    const o = JSON.parse(fs.readFileSync(addedFile(hooksFile), 'utf8'))
    const names = record(o) && Array.isArray(o.envVars) ? o.envVars : []
    return { pointer: record(o) && o.pointer === true, envVars: MUSE_HOOK_ENV.filter((name) => names.some((n) => sameName(n, name))) }
  } catch {
    return { pointer: false, envVars: [] }
  }
}

// Before anything is written: Muse's settings can point at Tessel's file.
// -> null, or { error }.
export function museManagedCheck(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const file = museSettingsFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  const other = pointer(got.settings, file)
  if (other && !samePath(other, resolve(hooksFile))) return { error: elsewhere(file, other) }
  const list = got.settings.managed_hooks_env_vars
  if (list !== undefined && !(Array.isArray(list) && list.every((v) => typeof v === 'string'))) return { error: badEnvList(file) }
  return null
}

// Muse's settings pointing at hooksFile, with Tessel's variables named.
// -> { changed } or { error }
export function installMuseManaged(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const check = museManagedCheck(hooksFile, { home, env })
  if (check) return check
  const file = museSettingsFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  const settings = { ...got.settings }
  const before = JSON.stringify(settings)
  const had = readAdded(hooksFile)
  // Already pointing at Tessel's file before (and not noted as Tessel's doing): the user's.
  const pointedBefore = !!pointer(got.settings, file)
  // Muse refuses to start on a settings file without it.
  if (settings.schema_version === undefined) settings.schema_version = 1
  settings.managed_hooks_path = resolve(hooksFile)
  const names = Array.isArray(settings.managed_hooks_env_vars) ? [...settings.managed_hooks_env_vars] : []
  const added = []
  // Muse refuses a name twice (in any case).
  for (const name of MUSE_HOOK_ENV) {
    if (names.some((n) => sameName(n, name))) continue
    names.push(name)
    added.push(name)
  }
  settings.managed_hooks_env_vars = names
  const note = { pointer: had.pointer || !pointedBefore, envVars: MUSE_HOOK_ENV.filter((name) => had.envVars.includes(name) || added.includes(name)) }
  const settingsChanged = !got.exists || JSON.stringify(settings) !== before
  const noteChanged = JSON.stringify(note) !== JSON.stringify(had) || !fs.existsSync(addedFile(hooksFile))
  if (!settingsChanged && !noteChanged) return { changed: false }
  try {
    fs.mkdirSync(dirname(file), { recursive: true })
    if (settingsChanged) {
      // The user's file as it was before Tessel's first change.
      if (got.exists && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
      writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n')
    }
    // Noted after the settings are written: a note that failed leaves a name
    // of Tessel's behind, never takes one of the user's.
    if (noteChanged) {
      fs.mkdirSync(dirname(addedFile(hooksFile)), { recursive: true })
      writeFileAtomic(addedFile(hooksFile), JSON.stringify(note) + '\n')
    }
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
  return { changed: settingsChanged }
}

// What Tessel added taken out (only while the pointer is Tessel's file): its
// pointer and its variable names as noted, nothing that was there before.
// -> { changed } or { error }
export function removeMuseManaged(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const file = museSettingsFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  const had = readAdded(hooksFile)
  const forget = () => {
    try {
      fs.rmSync(addedFile(hooksFile), { force: true })
    } catch {
      // left in place: names only
    }
  }
  const other = got.exists ? pointer(got.settings, file) : null
  if (!other || !samePath(other, resolve(hooksFile))) {
    forget()
    return { changed: false }
  }
  const settings = { ...got.settings }
  if (had.pointer) delete settings.managed_hooks_path
  if (Array.isArray(settings.managed_hooks_env_vars)) {
    const kept = settings.managed_hooks_env_vars.filter((n) => !had.envVars.some((name) => sameName(n, name)))
    if (kept.length) settings.managed_hooks_env_vars = kept
    else delete settings.managed_hooks_env_vars
  }
  if (JSON.stringify(settings) === JSON.stringify(got.settings)) {
    forget()
    return { changed: false }
  }
  try {
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n')
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
  forget()
  return { changed: true }
}

// For Settings: 'installed' (the settings point at hooksFile and name every
// variable), 'partial' (pointed at, a variable missing), 'missing', or
// { error } (unreadable, or another managed file named).
export function museManagedStatus(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const file = museSettingsFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  const other = pointer(got.settings, file)
  if (!other) return 'missing'
  if (!samePath(other, resolve(hooksFile))) return { error: elsewhere(file, other) }
  const names = Array.isArray(got.settings.managed_hooks_env_vars) ? got.settings.managed_hooks_env_vars : []
  return MUSE_HOOK_ENV.every((name) => names.some((n) => sameName(n, name))) ? 'installed' : 'partial'
}
