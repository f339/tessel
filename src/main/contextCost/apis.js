// The other count APIs of Settings > Context, for models with no public
// tokenizer (src/shared/tokenCounters.js), each with an API key found in the
// environment Tessel's panes get (the key is read for the request, never
// logged or kept; the text counted is never logged):
//   xAI (Grok)          POST https://api.x.ai/v1/tokenize-text {model, text}
//                       -> token_ids (XAI_API_KEY)
//   Meta (Muse Spark)   POST https://api.meta.ai/v1/responses/input_tokens
//                       -> input_tokens (MODEL_API_KEY)
//   OpenAI (GPT-6)      POST https://api.openai.com/v1/responses/input_tokens
//                       -> input_tokens (OPENAI_API_KEY; tiktoken has no
//                       GPT-6 encoding yet)
// A responses count is the request with the item minus the same request
// without it (instructions for text, a tool list for tools), like
// anthropic.js. xAI tokenizes plain text: tools are counted as their JSON.
// Asked on view or click only; counts are kept by hash (counts.js).
import { CountError } from './anthropic'

export const XAI_TOKENIZE_URL = 'https://api.x.ai/v1/tokenize-text'
export const META_INPUT_TOKENS_URL = 'https://api.meta.ai/v1/responses/input_tokens'
export const OPENAI_INPUT_TOKENS_URL = 'https://api.openai.com/v1/responses/input_tokens'
const RESPONSE_LIMIT = 1024 * 1024
const MIN_BLOCK_MS = 60 * 1000

async function postJson(request, url, headers, body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
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
    if (status === 400 || status === 404 || status === 413) throw new CountError('refused', { status })
    throw new CountError('unavailable', { status })
  }
  try {
    const text = await response.text()
    if (text.length > RESPONSE_LIMIT) throw new Error('too large') // i18n-ignore internal
    return JSON.parse(text)
  } catch {
    throw new CountError('unavailable', { status })
  }
}

const toolsJson = (tools) => JSON.stringify((tools || []).map((tl) => ({ name: tl.name, description: tl.description || '', parameters: tl.input_schema || tl.inputSchema || {} })))
const responsesTool = (tl) => ({ type: 'function', name: tl.name, description: tl.description || '', parameters: tl.input_schema || tl.inputSchema || { type: 'object', properties: {} } })
const PROBE = { name: 'tessel_probe', description: 'Probe.', input_schema: { type: 'object', properties: {} } } // i18n-ignore

// The queue every API counter shares: at most `concurrency` requests at once,
// one item's refusal kept to that item, anything else (offline, signed out,
// rate limited) stopping the rest, and a rate limit or a refused key
// remembered until Retry (reset).
function createRunner({ name, key, countOne, concurrency = 2, clock = Date.now, log = null }) {
  let blocked = null
  async function count(model, items) {
    const out = {}
    const fail = (code, list) => list.forEach((item) => (out[item.key] = { error: code }))
    if (blocked && clock() < blocked.until) {
      fail(blocked.code, items)
      return out
    }
    blocked = null
    const secret = typeof key === 'function' ? key() : null
    if (!secret) {
      fail('noKey', items)
      return out
    }
    const queue = [...items]
    let stopped = null
    async function next() {
      while (queue.length && !stopped) {
        const item = queue.shift()
        try {
          out[item.key] = { tokens: await countOne(secret, model, item) }
        } catch (err) {
          const code = err instanceof CountError ? err.code : 'unavailable'
          out[item.key] = { error: code }
          log?.warn?.('context', `${name}: ${code}${err && err.status ? ` (HTTP ${err.status})` : ''}`) // i18n-ignore
          if (code !== 'refused') {
            stopped = err
            if (code === 'rateLimited') blocked = { until: clock() + MIN_BLOCK_MS, code }
            else if (code === 'signedOut') blocked = { until: Infinity, code }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, next))
    if (stopped) fail(stopped.code, queue.splice(0))
    return out
  }
  return { count, reset: () => (blocked = null) }
}

export function createXaiCounter({ key, request = globalThis.fetch, url = XAI_TOKENIZE_URL, timeoutMs = 20000, log = null, clock } = {}) {
  return createRunner({
    name: 'xai tokenize-text', // i18n-ignore
    key,
    log,
    clock,
    async countOne(secret, model, item) {
      const text = item.kind === 'tools' ? toolsJson(item.tools) : String(item.text || '')
      const data = await postJson(request, url, { authorization: `Bearer ${secret}` }, { model, text }, timeoutMs)
      if (!data || !Array.isArray(data.token_ids)) throw new CountError('unavailable')
      return data.token_ids.length
    }
  })
}

// Meta's and OpenAI's responses/input_tokens.
export function createResponsesCounter({ name, key, url, request = globalThis.fetch, timeoutMs = 20000, log = null, clock } = {}) {
  const baselines = new Map()
  async function tokens(secret, body) {
    const data = await postJson(request, url, { authorization: `Bearer ${secret}` }, body, timeoutMs)
    const n = data && Number(data.input_tokens)
    if (!Number.isFinite(n) || n < 0) throw new CountError('unavailable')
    return n
  }
  const bodyFor = (model, item) =>
    item === 'tools' || (item && item.kind === 'tools')
      ? { model, input: '.', tools: [PROBE, ...((item && item.tools) || [])].map(responsesTool) }
      : item === 'text'
        ? { model, input: '.' }
        : { model, input: '.', instructions: String(item.text || '') }
  function baseline(secret, model, kind) {
    const k = `${model}|${kind}`
    if (!baselines.has(k)) {
      const p = tokens(secret, kind === 'tools' ? { model, input: '.', tools: [responsesTool(PROBE)] } : bodyFor(model, 'text'))
      p.catch(() => baselines.delete(k))
      baselines.set(k, p)
    }
    return baselines.get(k)
  }
  const runner = createRunner({
    name,
    key,
    log,
    clock,
    async countOne(secret, model, item) {
      const [full, base] = await Promise.all([tokens(secret, bodyFor(model, item)), baseline(secret, model, item.kind)])
      return Math.max(0, full - base)
    }
  })
  return {
    count: runner.count,
    reset() {
      runner.reset()
      baselines.clear()
    }
  }
}
