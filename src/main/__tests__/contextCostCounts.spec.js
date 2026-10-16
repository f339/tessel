// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createCountCache, createContextCounter, payloadHash, CALIBRATE_MIN } from '../contextCost/counts'
import { tokenCounterFor, ESTIMATE_FACTORS } from '../../shared/tokenCounters'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ctxcount-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// The counting process, faked: one token per word.
function fakeWorker() {
  const words = (s) => (String(s).trim() ? String(s).trim().split(/\s+/).length : 0)
  const worker = {
    calls: [],
    async request(msg) {
      worker.calls.push(msg)
      if (msg.op === 'encoding') return { counts: msg.texts.map(words) }
      if (msg.op === 'tokenizer') return { counts: msg.items.map((i) => words(i.text) + 1), templates: msg.items.map(() => true) }
      return null
    }
  }
  return worker
}
const cacheIn = () => createCountCache(join(dir, 'counts.json'))
const item = (key, text) => ({ key, kind: 'text', text })

describe('counts with the model’s own counter', () => {
  it('counts locally with a shipped encoding, exact, and keeps the count by content', async () => {
    const worker = fakeWorker()
    const counter = createContextCounter({ cache: cacheIn(), worker })
    const codex = tokenCounterFor('gpt-5.5-codex')
    const first = await counter.count([item('a', 'one two three')], codex)
    expect(first.a).toMatchObject({ tokens: 3, exact: true, source: 'local', tokenizer: 'o200k_base' })
    await counter.count([item('b', 'one two three')], codex) // same text, another key
    expect(worker.calls).toHaveLength(1)
    // Changed text: counted again (a new hash).
    const changed = await counter.count([item('a', 'one two three four')], codex)
    expect(changed.a.tokens).toBe(4)
    expect(worker.calls).toHaveLength(2)
  })

  it('keeps counts across restarts, never the text', async () => {
    const cache = cacheIn()
    const counter = createContextCounter({ cache, worker: fakeWorker() })
    await counter.count([item('a', 'secret words here')], tokenCounterFor('gpt-5'))
    cache.flush()
    const saved = fs.readFileSync(join(dir, 'counts.json'), 'utf8')
    expect(saved).not.toContain('secret')
    expect(saved).toContain(payloadHash(item('a', 'secret words here')))
    const worker = fakeWorker()
    const again = await createContextCounter({ cache: cacheIn(), worker }).count([item('x', 'secret words here')], tokenCounterFor('gpt-5'))
    expect(again.x.tokens).toBe(3)
    expect(worker.calls).toHaveLength(0)
  })

  it('offers an estimate until a downloaded tokenizer is there, then counts with it', async () => {
    let ready = false
    const files = { loaderFor: async () => (ready ? { dir: '/t/qwen3', format: 'hf' } : null) }
    const counter = createContextCounter({ cache: cacheIn(), worker: fakeWorker(), files })
    const qwen = tokenCounterFor('qwen3-coder')
    const before = await counter.count([item('a', 'one two')], qwen)
    expect(before.a).toMatchObject({ exact: false, source: 'estimate', reason: 'noTokenizer', tokenizer: 'qwen3', tokens: Math.round(2 * ESTIMATE_FACTORS.other) })
    ready = true
    const after = await counter.count([item('a', 'one two')], qwen)
    expect(after.a).toMatchObject({ exact: true, source: 'local', tokenizer: 'qwen3', template: true, tokens: 3 })
  })

  it('estimates from characters when the counting process does not answer', async () => {
    const counter = createContextCounter({ cache: cacheIn(), worker: { request: async () => null } })
    const res = await counter.count([item('a', 'abcdefgh')], tokenCounterFor('gpt-5'))
    expect(res.a).toMatchObject({ exact: false, reason: 'worker', base: 'chars', tokens: 2 })
  })
})

describe('count APIs: only on view or click, kept, estimates otherwise', () => {
  const claude = tokenCounterFor('claude-opus-5-5')

  it('asks nothing over the network without remote: an estimate marked not counted yet', async () => {
    const anthropic = { count: vi.fn(async () => ({})) }
    const counter = createContextCounter({ cache: cacheIn(), worker: fakeWorker(), apis: { anthropic } })
    const res = await counter.count([item('a', 'one two three four')], claude)
    expect(anthropic.count).not.toHaveBeenCalled()
    expect(res.a).toMatchObject({ exact: false, source: 'estimate', reason: 'notCounted', api: 'anthropic', tokens: Math.round(4 * ESTIMATE_FACTORS['anthropic-new']) })
  })

  it('counts with remote, for the model, then reuses the count without asking again', async () => {
    const anthropic = { count: vi.fn(async (model, items) => Object.fromEntries(items.map((i) => [i.key, { tokens: 42 }]))) }
    const counter = createContextCounter({ cache: cacheIn(), worker: fakeWorker(), apis: { anthropic } })
    const res = await counter.count([item('a', 'one two')], claude, { remote: true })
    expect(anthropic.count).toHaveBeenCalledWith('claude-opus-5-5', [{ key: 'a', kind: 'text', text: 'one two', tools: undefined }])
    expect(res.a).toMatchObject({ tokens: 42, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' })
    const again = await counter.count([item('b', 'one two')], claude, { remote: true })
    expect(again.b.tokens).toBe(42)
    expect(anthropic.count).toHaveBeenCalledTimes(1)
    // Another model is another count.
    await counter.count([item('a', 'one two')], tokenCounterFor('claude-sonnet-4-5'), { remote: true })
    expect(anthropic.count).toHaveBeenCalledTimes(2)
  })

  it('labels a failed count as an estimate with its reason', async () => {
    const anthropic = { count: async (model, items) => Object.fromEntries(items.map((i) => [i.key, { error: 'offline' }])) }
    const counter = createContextCounter({ cache: cacheIn(), worker: fakeWorker(), apis: { anthropic } })
    const res = await counter.count([item('a', 'one two three')], claude, { remote: true })
    expect(res.a).toMatchObject({ exact: false, source: 'estimate', reason: 'offline', base: 'o200k_base' })
    const none = await createContextCounter({ cache: cacheIn(), worker: fakeWorker() }).count([item('a', 'x y')], tokenCounterFor('grok-4'), { remote: true })
    expect(none.a.reason).toBe('noKey')
  })

  it('recalibrates the estimate from the user’s own exact counts', async () => {
    const cache = cacheIn()
    const anthropic = { count: async (model, items) => Object.fromEntries(items.map((i) => [i.key, { tokens: i.text.split(' ').length * 2 }])) }
    const counter = createContextCounter({ cache, worker: fakeWorker(), apis: { anthropic } })
    const words = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ')
    for (let i = 0; i < CALIBRATE_MIN.counts; i++) await counter.count([item(`k${i}`, words(150, `w${i}-`))], claude, { remote: true })
    expect(cache.factor('anthropic-new')).toEqual({ factor: 2, from: CALIBRATE_MIN.counts })
    const est = await counter.count([item('new', 'a b c d e')], claude)
    expect(est.new).toMatchObject({ exact: false, calibrated: true, factor: 2, tokens: 10 })
  })
})
