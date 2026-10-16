// Which credential each count API of Settings > Context may use, decided in
// the main process for each call:
//   - an API key from the environment the panes get, unless that provider's
//     base URL is set too (ANTHROPIC_BASE_URL, also in Claude's settings env;
//     OPENAI_BASE_URL; GOOGLE_GEMINI_BASE_URL; XAI_BASE_URL): such a key is a
//     gateway's, and never goes to the official host;
//   - a sign-in (the Claude Code login, the Gemini CLI login) only when the
//     user turned its switch on in Settings > Context. Each call carries the
//     switches as they are now (signIns.take); turning one off makes the
//     sign-in counts still running stop and drop their results (allowed).
// No key or token is ever logged or returned to the window.

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
//   env()             the panes' environment
//   claudeSettingsEnv() the "env" objects of Claude's settings files
//   claudeLogin()     -> { ok, headers } (providerUsage.js apiAuth)
//   geminiLogin()     -> { headers } (usageProviderSources.js auth('gemini'))
export function createCountAuths({ env, claudeSettingsEnv = () => [], claudeLogin, geminiLogin }) {
  return {
    async anthropic(opts = {}) {
      const key = apiKeyFor('anthropic', ['ANTHROPIC_API_KEY'], env(), claudeSettingsEnv())
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
