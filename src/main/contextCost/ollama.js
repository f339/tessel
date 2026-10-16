// Local models run by Ollama (Settings > Context): Ollama has no tokenize
// endpoint, so a model whose name tokenCounters.js does not place is asked
// about with /api/show (its GGUF metadata names the model it was made from:
// general.basename, general.base_model.0.repo_url, general.architecture),
// and that model's tokenizer counts it. Failing that, on view or click
// only, Ollama counts the text itself: prompt_eval_count of a raw generate
// of one token (it loads the model; a reused KV cache can lower a count).
// Everything stays on this computer (localhost).
import { tokenCounterFor } from '../../shared/tokenCounters'
import { CountError } from './anthropic'

export const OLLAMA_URL = 'http://127.0.0.1:11434'
// The largest answer read: /api/show (its metadata) and a generate.
export const SHOW_LIMIT = 4 * 1024 * 1024
export const GENERATE_LIMIT = 256 * 1024
const ARCHITECTURES = { qwen2: 'qwen2', qwen3: 'qwen3', qwen3moe: 'qwen3', gemma3: 'gemini-2.5', deepseek2: 'deepseek-v3', gptoss: 'gpt-oss', glm4: 'glm-4', glm4moe: 'glm-4', mistral3: 'mistral-small' }

// An Ollama model reference: "ollama/<name>" (OpenCode, Cline) or any name
// for the ollama agent.
export const ollamaName = (agent, model) => {
  const m = String(model || '').trim()
  if (/^ollama\//i.test(m)) return m.slice(7)
  return agent === 'ollama' && m ? m : null
}

// An answer read up to `limit` bytes (a larger one is refused, not parsed).
async function readLimited(response, limit) {
  if (Number(response.headers?.get?.('content-length')) > limit) {
    await response.body?.cancel?.().catch(() => {})
    throw new CountError('unavailable')
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) throw new CountError('unavailable')
      chunks.push(Buffer.from(part.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function postJson(request, url, body, timeoutMs, limit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new CountError(response.status === 404 ? 'refused' : 'unavailable', { status: response.status })
    }
    return await readLimited(response, limit)
  } catch (err) {
    if (err instanceof CountError) throw err
    throw new CountError('offline')
  } finally {
    clearTimeout(timer)
  }
}

// -> a local counter for the model it was made from, or null.
export async function ollamaCounter(name, { request = globalThis.fetch, url = OLLAMA_URL, timeoutMs = 5000 } = {}) {
  let info
  try {
    info = (await postJson(request, `${url}/api/show`, { model: name }, timeoutMs, SHOW_LIMIT)).model_info || {}
  } catch {
    return null
  }
  const candidates = [info['general.base_model.0.repo_url'], info['general.base_model.0.name'], info['general.basename'], ARCHITECTURES[info['general.architecture']]]
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue
    const counter = tokenCounterFor(c.replace(/^https?:\/\/huggingface\.co\//i, ''), null)
    if (counter.kind === 'local') return { ...counter, model: name, via: c }
  }
  return null
}

// The prompt_eval_count counter (an "api" of counts.js).
export function createOllamaCounter({ request = globalThis.fetch, url = OLLAMA_URL, timeoutMs = 120000 } = {}) {
  async function count(model, items) {
    const out = {}
    for (const item of items) {
      try {
        const text = item.kind === 'tools' ? JSON.stringify(item.tools || []) : String(item.text || '')
        const data = await postJson(request, `${url}/api/generate`, { model, prompt: text, raw: true, stream: false, options: { num_predict: 1 } }, timeoutMs, GENERATE_LIMIT)
        const n = Number(data && data.prompt_eval_count)
        out[item.key] = Number.isFinite(n) ? { tokens: n } : { error: 'unavailable' }
      } catch (err) {
        out[item.key] = { error: err instanceof CountError ? err.code : 'unavailable' }
        if (err instanceof CountError && err.code === 'offline') {
          for (const rest of items) if (!out[rest.key]) out[rest.key] = { error: 'offline' }
          break
        }
      }
    }
    return out
  }
  return { count, reset() {} }
}
