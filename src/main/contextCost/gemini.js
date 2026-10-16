// Exact Gemini token counts for Settings > Context: Google's countTokens for
// the model a Gemini CLI or Antigravity agent runs, with a Gemini API key in
// the environment (GEMINI_API_KEY / GOOGLE_API_KEY, as Gemini CLI reads it,
// unless a base URL sends it elsewhere), or, only when the user turned on
// "Count with my Gemini CLI sign-in", that login (the Code Assist service's
// countTokens, as Gemini CLI itself calls it; usageProviderSources.js reads
// it). Turning the switch off drops the sign-in counts still running. Asked
// on view or click only, each count kept by content hash and model
// (counts.js); the key or token is never logged, nor the text.
// Tool definitions are counted as their JSON text (countTokens takes no
// tools): close to, not exactly, what the model gets.
import { CountError } from './anthropic'

export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
export const CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:countTokens'
const RESPONSE_LIMIT = 64 * 1024
const MIN_BLOCK_MS = 30 * 1000

export function itemText(item) {
  if (item.kind !== 'tools') return String(item.text || '')
  const decl = (item.tools || []).map((tl) => ({ name: tl.name, description: tl.description || '', parameters: tl.input_schema || tl.inputSchema || {} }))
  return JSON.stringify(decl)
}

// auth(opts): -> { ok: true, kind: 'apiKey', key } | { ok: true, kind: 'oauth', headers } | { ok: false, code? }
export function createGeminiCounter({ auth, request = globalThis.fetch, apiUrl = GEMINI_API_URL, codeAssistUrl = CODE_ASSIST_URL, timeoutMs = 20000, concurrency = 2, clock = Date.now, log = null }) {
  let blocked = null

  async function post(login, model, text) {
    const contents = [{ role: 'user', parts: [{ text }] }]
    const isKey = login.kind === 'apiKey'
    const target = isKey ? `${apiUrl}/${encodeURIComponent(model)}:countTokens` : codeAssistUrl
    const headers = { 'content-type': 'application/json', ...(isKey ? { 'x-goog-api-key': login.key } : login.headers) }
    const body = isKey ? { contents } : { request: { model: `models/${model}`, contents } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await request(target, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
    } catch {
      throw new CountError('offline')
    } finally {
      clearTimeout(timer)
    }
    const status = response.status
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      if (status === 429) throw new CountError('rateLimited', { status })
      if (status === 401 || status === 403) throw new CountError('signedOut', { status })
      if (status === 400 || status === 404) throw new CountError('refused', { status })
      throw new CountError('unavailable', { status })
    }
    let data = null
    try {
      const raw = await response.text()
      if (raw.length <= RESPONSE_LIMIT) data = JSON.parse(raw)
    } catch {
      data = null
    }
    const tokens = data && Number(data.totalTokens)
    if (!Number.isFinite(tokens) || tokens < 0) throw new CountError('unavailable', { status })
    return tokens
  }

  // opts: { geminiSignIn, allowed(provider) } for this call.
  async function count(model, items, opts = {}) {
    const out = {}
    const fail = (code, list) => list.forEach((item) => (out[item.key] = { error: code }))
    if (blocked && clock() < blocked.until) {
      fail(blocked.code, items)
      return out
    }
    blocked = null
    let login
    try {
      login = await auth(opts)
    } catch {
      login = null
    }
    if (!login || !login.ok || (login.kind === 'apiKey' ? !login.key : !login.headers)) {
      fail(login && login.code === 'noKey' ? 'noKey' : 'signedOut', items)
      return out
    }
    const stillAllowed = () => login.kind !== 'oauth' || typeof opts.allowed !== 'function' || opts.allowed('gemini')
    const queue = [...items]
    let stopped = null
    async function next() {
      while (queue.length && !stopped) {
        if (!stillAllowed()) {
          stopped = new CountError('noKey')
          break
        }
        const item = queue.shift()
        try {
          const tokens = await post(login, model, itemText(item))
          out[item.key] = stillAllowed() ? { tokens } : { error: 'noKey' }
        } catch (err) {
          const code = err instanceof CountError ? err.code : 'unavailable'
          out[item.key] = { error: code }
          log?.warn?.('context', `countTokens: ${code}${err && err.status ? ` (HTTP ${err.status})` : ''}`) // i18n-ignore
          if (code !== 'refused') {
            stopped = err
            if (code === 'rateLimited') blocked = { until: clock() + MIN_BLOCK_MS * 2, code }
            else if (code === 'signedOut') blocked = { until: Infinity, code }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, next))
    if (stopped) fail(stopped.code, queue.splice(0))
    return out
  }

  return {
    count,
    reset() {
      blocked = null
    }
  }
}
