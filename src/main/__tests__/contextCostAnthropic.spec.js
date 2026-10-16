// @vitest-environment node
// Anthropic's count_tokens, against a local stand-in server: the headers each
// sign-in sends, the model and the shape of what is counted, the share of
// each item, rate limits, the fallback label, and logs without content.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createAnthropicCounter, requestBody, ANTHROPIC_VERSION } from '../contextCost/anthropic'
import { createGeminiCounter } from '../contextCost/gemini'
import { createXaiCounter, createResponsesCounter } from '../contextCost/apis'
import { createOllamaCounter, ollamaCounter, GENERATE_LIMIT } from '../contextCost/ollama'
import { createContextCounter, createCountCache } from '../contextCost/counts'
import { tokenCounterFor } from '../../shared/tokenCounters'

const SECRET_TEXT = 'Always answer in French, my private rule 7781.'
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const OAUTH_TOKEN = 'sk-ant-oat01-SECRET-TOKEN-1234567890'
const API_KEY = 'sk-ant-api03-SECRET-KEY-0987654321'

let server
let url
let requests = []
let reply = null // (req, body) -> { status, body, headers } | null
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ url: req.url, method: req.method, headers: req.headers, body })
      const custom = reply && reply(req, body)
      if (custom) {
        res.writeHead(custom.status, { 'content-type': 'application/json', ...(custom.headers || {}) })
        return res.end(JSON.stringify(custom.body || {}))
      }
      // One token per character of the system blocks but Claude Code's
      // identity line, ten per tool, five for the framing.
      const system = Array.isArray(body.system) ? body.system.filter((b) => b.text !== IDENTITY).map((b) => b.text).join('') : ''
      const tools = Array.isArray(body.tools) ? body.tools.length * 10 : 0
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 5 + system.length + tools }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}/v1/messages/count_tokens`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  requests = []
  reply = null
})

const logs = []
const log = { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')) }
const oauth = async () => ({ ok: true, kind: 'oauth', headers: { Authorization: `Bearer ${OAUTH_TOKEN}` } })
const apiKey = async () => ({ ok: true, kind: 'apiKey', headers: { 'x-api-key': API_KEY } })

describe("Anthropic's count_tokens", () => {
  it('sends the Claude Code sign-in the way Claude Code does, for the model named', async () => {
    const counter = createAnthropicCounter({ auth: oauth, url, log })
    const out = await counter.count('claude-opus-5-5', [{ key: 'rules', kind: 'text', text: SECRET_TEXT }])
    expect(out.rules).toEqual({ tokens: SECRET_TEXT.length }) // its block alone: the framing is subtracted
    const sent = requests.find((r) => r.body.system.length === 2)
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe('/v1/messages/count_tokens')
    expect(sent.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`)
    expect(sent.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(sent.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(sent.headers['x-app']).toBe('cli')
    expect(sent.headers['user-agent']).toMatch(/^claude-cli\//)
    expect(sent.headers['x-api-key']).toBeUndefined()
    expect(sent.body.model).toBe('claude-opus-5-5')
    expect(sent.body.system).toEqual([{ type: 'text', text: IDENTITY }, { type: 'text', text: SECRET_TEXT }])
    expect(sent.body.messages).toEqual([{ role: 'user', content: '.' }])
  })

  it('sends an API key as x-api-key, without the sign-in headers', async () => {
    const counter = createAnthropicCounter({ auth: apiKey, url, log })
    await counter.count('claude-sonnet-5-5', [{ key: 'a', kind: 'text', text: 'abc' }])
    expect(requests.every((r) => r.headers['x-api-key'] === API_KEY && !r.headers.authorization && !r.headers['anthropic-beta'])).toBe(true)
    expect(requests.every((r) => r.body.model === 'claude-sonnet-5-5')).toBe(true)
    // Claude Code's identity line goes only with its sign-in.
    expect(requests.every((r) => !JSON.stringify(r.body).includes('Claude Code'))).toBe(true)
  })

  it('drops the sign-in counts still running once the switch is turned off', async () => {
    let on = true
    let answered = 0
    reply = () => {
      answered++
      if (answered === 3) on = false // turned off while counting
      return null
    }
    const counter = createAnthropicCounter({ auth: oauth, url, log, concurrency: 1 })
    const items = [1, 2, 3, 4].map((i) => ({ key: `k${i}`, kind: 'text', text: `t${i}` }))
    const out = await counter.count('claude-opus-5-5', items, { claudeSignIn: true, allowed: () => on })
    expect(out.k1.tokens).toBe(2)
    expect(out.k2.error).toBe('noKey')
    expect(out.k3.error).toBe('noKey')
    expect(out.k4.error).toBe('noKey')
    expect(requests.length).toBeLessThanOrEqual(4)
  })

  it("counts tools as tools, each item's share only (the framing is subtracted)", async () => {
    const counter = createAnthropicCounter({ auth: apiKey, url, log })
    const tools = [{ name: 'mcp__fs__read', description: 'Read a file.', input_schema: { type: 'object', properties: {} } }]
    const out = await counter.count('claude-opus-5-5', [{ key: 'mcp', kind: 'tools', tools }, { key: 'b', kind: 'text', text: 'xyz' }])
    expect(out.mcp).toEqual({ tokens: 10 })
    expect(out.b).toEqual({ tokens: 3 })
    const withTools = requests.find((r) => Array.isArray(r.body.tools) && r.body.tools.length === 2)
    expect(withTools.body.tools[1]).toEqual(tools[0])
    // One baseline per kind, reused.
    expect(requests.filter((r) => !r.body.system && !r.body.tools)).toHaveLength(1)
    expect(requestBody('m', 'tools').tools).toHaveLength(1)
  })

  it('stops on a rate limit, waits for Retry-After, and Retry asks again', async () => {
    let now = 1000
    reply = () => ({ status: 429, headers: { 'retry-after': '120' } })
    const counter = createAnthropicCounter({ auth: apiKey, url, log, clock: () => now })
    const items = [1, 2, 3].map((i) => ({ key: `k${i}`, kind: 'text', text: `t${i}` }))
    const out = await counter.count('claude-opus-5-5', items)
    expect(Object.values(out).every((r) => r.error === 'rateLimited')).toBe(true)
    const asked = requests.length
    expect(asked).toBeLessThanOrEqual(4) // two at once and their baseline, no more
    reply = null
    now += 60 * 1000 // before Retry-After: nothing is sent
    expect((await counter.count('claude-opus-5-5', items)).k1.error).toBe('rateLimited')
    expect(requests.length).toBe(asked)
    counter.reset() // Retry
    expect((await counter.count('claude-opus-5-5', items)).k1.tokens).toBe(2)
  })

  it('says signedOut when the sign-in is refused, noKey when it may not be used', async () => {
    reply = () => ({ status: 401 })
    const refused = await createAnthropicCounter({ auth: oauth, url, log }).count('claude-opus-5-5', [{ key: 'a', kind: 'text', text: 'x' }])
    expect(refused.a.error).toBe('signedOut')
    const noKey = await createAnthropicCounter({ auth: async () => ({ ok: false, code: 'noKey' }), url, log }).count('claude-opus-5-5', [{ key: 'a', kind: 'text', text: 'x' }])
    expect(noKey.a.error).toBe('noKey')
    const offline = await createAnthropicCounter({ auth: apiKey, url: 'http://127.0.0.1:9/v1/messages/count_tokens', log, timeoutMs: 2000 }).count('claude-opus-5-5', [{ key: 'a', kind: 'text', text: 'x' }])
    expect(offline.a.error).toBe('offline')
  })

  it('keeps counts by content and model through the counter, with the fallback label when unreachable', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ctxanth-'))
    try {
      const worker = { request: async (msg) => ({ counts: (msg.texts || []).map((s) => s.length) }) }
      const anthropic = createAnthropicCounter({ auth: apiKey, url, log })
      const counter = createContextCounter({ cache: createCountCache(join(dir, 'c.json')), worker, apis: { anthropic } })
      const claude = tokenCounterFor('claude-opus-5-5')
      const first = await counter.count([{ key: 'a', kind: 'text', text: SECRET_TEXT }], claude, { remote: true })
      expect(first.a).toMatchObject({ exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' })
      const sent = requests.length
      await counter.count([{ key: 'again', kind: 'text', text: SECRET_TEXT }], claude, { remote: true })
      expect(requests.length).toBe(sent) // never counted twice
      reply = () => ({ status: 503 })
      const down = await counter.count([{ key: 'b', kind: 'text', text: 'something new' }], claude, { remote: true })
      expect(down.b).toMatchObject({ exact: false, source: 'estimate', reason: 'unavailable', api: 'anthropic' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never logs the text counted or the token', () => {
    const all = logs.join('\n')
    expect(all).not.toContain(SECRET_TEXT)
    expect(all).not.toContain(OAUTH_TOKEN)
    expect(all).not.toContain(API_KEY)
    expect(all).toMatch(/count_tokens: rateLimited \(HTTP 429\)/)
  })
})

describe('the other count APIs', () => {
  const fakeFetch = (handler) => async (target, init) => {
    const body = JSON.parse(init.body)
    const out = handler(target, init, body)
    return new Response(JSON.stringify(out.body), { status: out.status || 200, headers: { 'content-type': 'application/json' } })
  }

  it("Google's countTokens: API key on the public API, else the Gemini CLI login on Code Assist", async () => {
    const seen = []
    const request = fakeFetch((target, init, body) => {
      seen.push({ target, headers: init.headers, body })
      return { body: { totalTokens: 7 } }
    })
    const withKey = createGeminiCounter({ auth: async () => ({ ok: true, kind: 'apiKey', key: 'AIza-KEY' }), request })
    expect((await withKey.count('gemini-4-argon', [{ key: 'a', kind: 'text', text: 'hi' }])).a.tokens).toBe(7)
    expect(seen[0].target).toMatch(/\/models\/gemini-4-argon:countTokens$/)
    expect(seen[0].headers['x-goog-api-key']).toBe('AIza-KEY')
    const withLogin = createGeminiCounter({ auth: async () => ({ ok: true, kind: 'oauth', headers: { Authorization: 'Bearer ya29' } }), request })
    await withLogin.count('gemini-4-argon', [{ key: 'a', kind: 'text', text: 'hi' }])
    expect(seen[1].target).toBe('https://cloudcode-pa.googleapis.com/v1internal:countTokens')
    expect(seen[1].body).toEqual({ request: { model: 'models/gemini-4-argon', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } })
  })

  it('reads a bounded Ollama answer only', async () => {
    const big = 'x'.repeat(GENERATE_LIMIT + 10)
    const huge = async () => new Response(JSON.stringify({ prompt_eval_count: 3, pad: big }), { status: 200 })
    expect((await createOllamaCounter({ request: huge }).count('qwen3', [{ key: 'a', kind: 'text', text: 'hi' }])).a.error).toBe('unavailable')
    const ok = async () => new Response(JSON.stringify({ prompt_eval_count: 3 }), { status: 200 })
    expect((await createOllamaCounter({ request: ok }).count('qwen3', [{ key: 'a', kind: 'text', text: 'hi' }])).a.tokens).toBe(3)
    const show = async () => new Response(JSON.stringify({ model_info: { 'general.basename': 'Qwen3', pad: 'y'.repeat(5 * 1024 * 1024) } }), { status: 200 })
    expect(await ollamaCounter('mine', { request: show })).toBe(null)
  })

  it("xAI's tokenize-text and the responses input_tokens, each with its key", async () => {
    const xai = createXaiCounter({ key: () => 'xai-KEY', request: fakeFetch((t, init, body) => ({ body: { token_ids: body.text.split(' ') } })) })
    expect((await xai.count('grok-4', [{ key: 'a', kind: 'text', text: 'one two three' }])).a.tokens).toBe(3)
    const noKey = createXaiCounter({ key: () => null, request: fakeFetch(() => ({ body: {} })) })
    expect((await noKey.count('grok-4', [{ key: 'a', kind: 'text', text: 'x' }])).a.error).toBe('noKey')
    const bodies = []
    const openai = createResponsesCounter({
      name: 'openai',
      url: 'https://api.openai.com/v1/responses/input_tokens',
      key: () => 'OPENAI-KEY',
      request: fakeFetch((t, init, body) => {
        bodies.push({ body, auth: init.headers.authorization })
        return { body: { input_tokens: 3 + (body.instructions ? body.instructions.length : 0) + (body.tools ? body.tools.length * 4 : 0) } }
      })
    })
    const out = await openai.count('gpt-6-astra', [{ key: 'a', kind: 'text', text: 'abcd' }, { key: 't', kind: 'tools', tools: [{ name: 'x', input_schema: { type: 'object' } }] }])
    expect(out.a.tokens).toBe(4)
    expect(out.t.tokens).toBe(4)
    expect(bodies.every((b) => b.auth === 'Bearer OPENAI-KEY' && b.body.model === 'gpt-6-astra')).toBe(true)
  })
})
