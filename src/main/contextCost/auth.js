// Which credential each count API of Settings > Context may use, decided in
// the main process for each call:
//   - an API key from the environment the panes get, unless that provider's
//     base URL is set too (ANTHROPIC_BASE_URL, also in the env of any Claude
//     settings file: the account's, ~/.claude's, the project's
//     .claude/settings*.json, the managed settings; OPENAI_BASE_URL;
//     GOOGLE_GEMINI_BASE_URL; XAI_BASE_URL): such a key is a gateway's, and
//     never goes to the official host. Claude's settings are read for each
//     call, before it counts; when they cannot be read, the key stays unused;
//   - a sign-in (the Claude Code login, the Gemini CLI login) only when the
//     user turned its switch on in Settings > Context. Each call carries the
//     switches as they are now (signIns.take); turning one off makes the
//     sign-in counts still running stop and drop their results (allowed).
// No key or token is ever logged or returned to the window.
import path from 'node:path'
import { readJson } from '../fileRead'
import { walkLinks } from './rulesFiles'

const KEY_SHAPE = /^[\x21-\x7e]{8,1024}$/
export const BASE_URLS = Object.freeze({
  anthropic: ['ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'],
  google: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],
  xai: ['XAI_BASE_URL']
})

const set = (v) => typeof v === 'string' && v.trim() !== ''

// The key named, when no base URL of that provider is set (in the
// environment or in any of the extra env objects, e.g. Claude's settings).
export function apiKeyFor(provider, keyNames, env, extraEnvs = []) {
  const bases = BASE_URLS[provider] || []
  for (const e of [env, ...extraEnvs]) if (e && bases.some((b) => set(e[b]))) return null
  for (const name of keyNames) {
    const v = env && env[name]
    if (typeof v === 'string' && KEY_SHAPE.test(v.trim())) return v.trim()
  }
  return null
}

// Where Claude Code reads its managed settings (an administrator's).
export function managedSettingsFiles(platform = process.platform, env = process.env) {
  if (platform === 'win32')
    return [
      path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'),
      path.win32.join(env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
    ]
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  return ['/etc/claude-code/managed-settings.json']
}

// A file of the project folder is read only when no link on its way leads
// to the network or a device (the repository chose it).
const projectFileSafe = async (file) => !(await walkLinks(file)).problem

// The "env" objects of every Claude settings file that may set a gateway's
// ANTHROPIC_BASE_URL: <dir>/settings.json of each config folder, the
// project's .claude/settings.json and .claude/settings.local.json, the
// managed settings. -> [env]
export async function claudeSettingsEnvs({ configDirs = [], cwd = null, managed = managedSettingsFiles(), read = readJson, safe = projectFileSafe } = {}) {
  const files = [...configDirs.filter(Boolean).map((d) => path.join(d, 'settings.json')), ...managed]
  if (typeof cwd === 'string' && path.isAbsolute(cwd))
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(cwd, '.claude', name)
      if (await safe(file)) files.push(file)
    }
  return files.map((f) => read(f)).map((cfg) => (cfg && cfg.env && typeof cfg.env === 'object' ? cfg.env : null)).filter(Boolean)
}

// The sign-in switches, as each call brings them.
export function createSignIns() {
  const state = { claude: { on: false, epoch: 0 }, gemini: { on: false, epoch: 0 } }
  return {
    // q: { claudeSignIn, geminiSignIn } -> the call's choices, with
    // allowed(provider): still on, and not turned off since this call.
    take(q = {}) {
      const at = {}
      for (const [provider, flag] of [['claude', q.claudeSignIn === true], ['gemini', q.geminiSignIn === true]]) {
        if (state[provider].on && !flag) state[provider].epoch++
        state[provider].on = flag
        at[provider] = state[provider].epoch
      }
      return {
        claudeSignIn: state.claude.on,
        geminiSignIn: state.gemini.on,
        allowed: (provider) => !!state[provider] && state[provider].on && state[provider].epoch === at[provider]
      }
    }
  }
}

// The auth functions the counters call (anthropic.js, gemini.js, apis.js).
//   env()                   the panes' environment
//   claudeSettingsEnv(opts) -> [env] of Claude's settings files, for the
//                           call's project (opts.cwd): claudeSettingsEnvs
//   claudeLogin()           -> { ok, headers } (providerUsage.js apiAuth)
//   geminiLogin()           -> { headers } (usageProviderSources.js auth('gemini'))
export function createCountAuths({ env, claudeSettingsEnv = async () => [], claudeLogin, geminiLogin }) {
  return {
    async anthropic(opts = {}) {
      let extra = null
      try {
        extra = await claudeSettingsEnv(opts)
      } catch {
        extra = null // a gateway can't be ruled out: no key
      }
      const key = Array.isArray(extra) ? apiKeyFor('anthropic', ['ANTHROPIC_API_KEY'], env(), extra) : null
      if (key) return { ok: true, kind: 'apiKey', headers: { 'x-api-key': key } }
      if (!opts.claudeSignIn) return { ok: false, code: 'noKey' }
      const login = await claudeLogin()
      return login && login.ok && login.headers ? { ok: true, kind: 'oauth', headers: login.headers } : { ok: false }
    },
    async google(opts = {}) {
      const key = apiKeyFor('google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], env())
      if (key) return { ok: true, kind: 'apiKey', key }
      if (!opts.geminiSignIn) return { ok: false, code: 'noKey' }
      try {
        const login = await geminiLogin()
        return login && login.headers ? { ok: true, kind: 'oauth', headers: login.headers } : { ok: false }
      } catch {
        return { ok: false }
      }
    },
    xaiKey: () => apiKeyFor('xai', ['XAI_API_KEY'], env()),
    openaiKey: () => apiKeyFor('openai', ['OPENAI_API_KEY'], env())
  }
}
