// Exact Claude token counts for Settings > Context: Anthropic's count_tokens
// endpoint (POST /v1/messages/count_tokens), for the model the agent runs,
// with the Claude sign-in Tessel already reads for usage (an API key when one
// is set, else the selected account's Claude Code login: providerUsage.js
// apiAuth). The user allowed it. Asked only when Settings > Context, the
// Skills page or a Measure is opened or clicked (never from a timer); each
// count is kept by content hash and model (counts.js), so the same text is
// never sent twice. The token is read for the request and dropped; neither it
// nor the text counted is ever logged.
//
// Each item is counted as the agent loads it, and only its own share: a
// rules file or instructions as system text, MCP tools as `tools`. The count
// of a request holding the item, minus the same request without it: the
// framing every request has (and the tool-use instructions any request with
// tools has) is not the item's. Claude Code's identity line is in both, as in
// its own requests (a Claude Code login is meant for those).
export const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens'
export const ANTHROPIC_VERSION = '2023-06-01'
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
// Claude Code's own headers with its login (the usage reader's beta flag).
const OAUTH_HEADERS = Object.freeze({
  'anthropic-beta': 'oauth-2025-04-20',
  'user-agent': 'claude-cli/2.1.0 (external, cli)',
  'x-app': 'cli'
})
const PROBE_TOOL = Object.freeze({ name: 'tessel_probe', description: 'Probe.', input_schema: { type: 'object', properties: {} } }) // i18n-ignore
const RESPONSE_LIMIT = 64 * 1024
const MIN_BLOCK_MS = 30 * 1000

// code: 'offline' | 'signedOut' | 'noKey' | 'rateLimited' | 'refused' | 'unavailable'
export class CountError extends Error {
  constructor(code, { status = null, retryAfterMs = null } = {}) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

// Retry-After in seconds or as a date.
function retryAfter(headers, now) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 3600 * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 3600 * 1000)) : null
}

export function requestBody(model, item) {
  const base = { model, messages: [{ role: 'user', content: '.' }] }
  const system = [{ type: 'text', text: IDENTITY }]
  if (item && item.kind === 'tools') return { ...base, system, tools: [PROBE_TOOL, ...(item.tools || [])] }
  if (item && item.kind === 'text') return { ...base, system: [...system, { type: 'text', text: String(item.text || '') }] }
  return { ...base, system, ...(item === 'tools' ? { tools: [PROBE_TOOL] } : {}) }
}

// auth(): -> { ok: true, kind: 'apiKey' | 'oauth', headers } or { ok: false, code? }
export function createAnthropicCounter({
  auth,
  request = globalThis.fetch,
  url = COUNT_TOKENS_URL,
  timeoutMs = 20000,
  concurrency = 2,
  clock = Date.now,
  log = null
}) {
  let blocked = null // { until, code } after a 429 or a refused sign-in
  const baselines = new Map() // `${model}|${kind}` -> Promise<number>

  async function post(body, headers) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await request(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
    } catch {
      throw new CountError('offline')
    } finally {
      clearTimeout(timer)
    }
    const status = response.status
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      if (status === 429) throw new CountError('rateLimited', { status, retryAfterMs: retryAfter(response.headers, clock()) })
      if (status === 401 || status === 403) throw new CountError('signedOut', { status })
      if (status === 400 || status === 404 || status === 413) throw new CountError('refused', { status })
      throw new CountError('unavailable', { status })
    }
    let data = null
    try {
      const text = await response.text()
      if (text.length <= RESPONSE_LIMIT) data = JSON.parse(text)
    } catch {
      data = null
    }
    const tokens = data && Number(data.input_tokens)
    if (!Number.isFinite(tokens) || tokens < 0) throw new CountError('unavailable', { status })
    return tokens
  }

  function baseline(model, kind, headers) {
    const key = `${model}|${kind}`
    if (!baselines.has(key)) {
      const p = post(requestBody(model, kind === 'tools' ? 'tools' : 'text'), headers)
      p.catch(() => baselines.delete(key))
      baselines.set(key, p)
    }
    return baselines.get(key)
  }

  function block(err) {
    if (err.code === 'rateLimited') blocked = { until: clock() + Math.max(MIN_BLOCK_MS, err.retryAfterMs || 60000), code: err.code }
    else if (err.code === 'signedOut') blocked = { until: Infinity, code: err.code }
  }

  // items: [{ key, kind: 'text' | 'tools', text?, tools? }]
  // -> { [key]: { tokens } | { error: code } }
  async function count(model, items) {
    const out = {}
    const fail = (code, list) => list.forEach((item) => (out[item.key] = { error: code }))
    if (blocked && clock() < blocked.until) {
      fail(blocked.code, items)
      return out
    }
    blocked = null
    let login
    try {
      login = await auth()
    } catch {
      login = null
    }
    if (!login || !login.ok || !login.headers) {
      // noKey: no API key and the sign-in is not to be used (Settings > Context).
      fail(login && login.code === 'noKey' ? 'noKey' : 'signedOut', items)
      return out
    }
    const headers = {
      ...login.headers,
      ...(login.kind === 'oauth' ? OAUTH_HEADERS : {}),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    }
    const queue = [...items]
    let stopped = null
    async function next() {
      while (queue.length && !stopped) {
        const item = queue.shift()
        try {
          const [full, base] = await Promise.all([post(requestBody(model, item), headers), baseline(model, item.kind, headers)])
          out[item.key] = { tokens: Math.max(0, full - base) }
        } catch (err) {
          const code = err instanceof CountError ? err.code : 'unavailable'
          out[item.key] = { error: code }
          // Status and code only: never the text, never the token.
          log?.warn?.('context', `count_tokens: ${code}${err && err.status ? ` (HTTP ${err.status})` : ''}`) // i18n-ignore
          if (code !== 'refused') {
            stopped = err
            block(err)
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
    // Retry: the next count asks again even after a 429 or a refused sign-in.
    reset() {
      blocked = null
      baselines.clear()
    }
  }
}
