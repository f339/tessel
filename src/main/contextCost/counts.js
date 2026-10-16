// Token counts of Settings > Context, each with where it comes from. The
// counter src/shared/tokenCounters.js gives a model is used whenever it can:
//   local - in the counting process (worker.js): the shipped OpenAI
//           encodings always, a downloaded tokenizer once it is there
//           (until then an estimate that offers the download);
//   api   - over the network, only when `remote` is asked (the page or a
//           Measure was opened or clicked), else the count kept from a
//           previous time, else an estimate marked "not counted yet".
// Every count is kept by the hash of what was counted and the counter (its
// tokenizer, or API and model) in <userData>/context-cost/counts.json, never
// the text: the same file is never counted twice, and a changed file is
// counted again because its hash changed.
// An exact count out of reach (offline, signed out, no key, rate limited, a
// tokenizer not downloaded) gives an estimate: o200k times the family's
// factor, with the reason. Each exact API count is also counted with o200k,
// so the factor is recalibrated from this user's own text once there are a
// few (CALIBRATE_MIN): the agents' logs only give whole requests, whose
// parts cannot be told apart, so they cannot calibrate a part.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { TOKENIZERS, estimateFrom } from '../../shared/tokenCounters'
import { writeFileAtomic } from '../safeJson'

const MAX_ENTRIES = 8000
const SAVE_DELAY_MS = 1500
export const CALIBRATE_MIN = { counts: 3, tokens: 300 }

export const payloadText = (item) => (item.kind === 'tools' ? JSON.stringify(item.tools || []) : String(item.text || ''))
export const payloadHash = (item) => createHash('sha256').update(`${item.kind}\n`).update(payloadText(item)).digest('hex')

// The cache: { v: 1, counts: [[key, tokens, template]...] newest last,
// calibration: { factorKey: [exactSum, o200kSum, n] } }.
export function createCountCache(file, { maxEntries = MAX_ENTRIES, timers = globalThis } = {}) {
  const map = new Map()
  const calibration = new Map()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && data.v === 1 && Array.isArray(data.counts))
      for (const row of data.counts) if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1])) map.set(row[0], { tokens: row[1], template: row[2] === 1 })
    if (data && data.calibration && typeof data.calibration === 'object')
      for (const [k, v] of Object.entries(data.calibration)) if (Array.isArray(v) && v.every(Number.isFinite)) calibration.set(k, v)
  } catch {
    // none yet, or unreadable: counted again
  }
  let timer = null
  function save() {
    timer = null
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(
        file,
        JSON.stringify({ v: 1, counts: [...map].map(([k, v]) => [k, v.tokens, v.template ? 1 : 0]), calibration: Object.fromEntries(calibration) })
      )
    } catch {
      // kept in memory; written with the next count
    }
  }
  function later() {
    if (timer) return
    timer = timers.setTimeout(save, SAVE_DELAY_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  return {
    get: (key) => map.get(key) || null,
    set(key, value) {
      map.delete(key)
      map.set(key, value)
      while (map.size > maxEntries) map.delete(map.keys().next().value)
      later()
    },
    // One more exact count and its o200k count, for a family's factor.
    calibrate(factorKey, exact, o200k) {
      const [e, o, n] = calibration.get(factorKey) || [0, 0, 0]
      calibration.set(factorKey, [e + exact, o + o200k, n + 1])
      later()
    },
    // -> the calibrated factor, or null while there are too few counts.
    factor(factorKey) {
      const row = calibration.get(factorKey)
      if (!row || row[2] < CALIBRATE_MIN.counts || row[1] < CALIBRATE_MIN.tokens) return null
      return { factor: Math.round((row[0] / row[1]) * 1000) / 1000, from: row[2] }
    },
    flush() {
      if (!timer) return
      timers.clearTimeout(timer)
      save()
    },
    size: () => map.size
  }
}

// worker: workerClient.js (request(msg) -> reply | null); apis: { anthropic,
// google, xai, meta, openai } counters (count(model, items)); files:
// hfTokenizers.js (loaderFor).
export function createContextCounter({ cache, worker, apis = {}, files = null }) {
  // Counts in the counting process, the kept ones first.
  async function local(counterId, list, message) {
    const out = new Map()
    const missing = []
    for (const item of list) {
      const hit = cache.get(`${counterId}|${item.hash}`)
      if (hit) out.set(item.key, hit)
      else missing.push(item)
    }
    if (missing.length) {
      const reply = await worker.request(message(missing))
      if (!reply || !Array.isArray(reply.counts)) return { out, failed: true }
      missing.forEach((item, i) => {
        const value = { tokens: Number(reply.counts[i]) || 0, template: !!(reply.templates && reply.templates[i]) }
        cache.set(`${counterId}|${item.hash}`, value)
        out.set(item.key, value)
      })
    }
    return { out, failed: false }
  }
  const o200k = (list) => local('local:o200k_base', list, (missing) => ({ op: 'encoding', encoding: 'o200k_base', texts: missing.map(payloadText) }))

  // The o200k count each estimate starts from (characters / 4 if even the
  // counting process is out of reach), times the family's factor, the
  // calibrated one once there is one.
  async function estimates(list, counter, reason, results) {
    if (!list.length) return
    const { out } = await o200k(list)
    const calibrated = counter.factorKey ? cache.factor(counter.factorKey) : null
    const factor = calibrated ? calibrated.factor : counter.factor || 1.1
    for (const item of list) {
      const base = out.get(item.key)
      results[item.key] = {
        tokens: base ? estimateFrom(base.tokens, factor) : Math.ceil(payloadText(item).length / 4),
        exact: false,
        source: 'estimate',
        base: base ? 'o200k_base' : 'chars',
        factor: base ? factor : 0.25,
        calibrated: !!(base && calibrated),
        wanted: counter.kind === 'local' ? `local:${counter.tokenizer}` : counter.kind === 'api' ? counter.api : null,
        tokenizer: counter.tokenizer || null,
        api: counter.api || null,
        model: counter.model || null,
        reason: typeof reason === 'function' ? reason(item) : reason
      }
    }
  }

  // items: [{ key, kind: 'text' | 'tools', text?, tools? }]
  // counter: tokenCounters.js tokenCounterFor(...)
  // -> { [key]: { tokens, exact, source: 'local' | 'api' | 'estimate', ... } }
  // auth: the call's sign-in choices, passed to the count API (index.js).
  async function count(items, counter, { remote = false, auth = null } = {}) {
    const list = items.map((item) => ({ ...item, hash: payloadHash(item) }))
    const results = {}
    if (counter.kind === 'local') {
      const spec = TOKENIZERS[counter.tokenizer]
      let message
      if (spec && spec.shipped) message = (missing) => ({ op: 'encoding', encoding: counter.tokenizer, texts: missing.map(payloadText) })
      else {
        const loader = files ? await files.loaderFor(counter.tokenizer) : null
        if (!loader) {
          await estimates(list, counter, 'noTokenizer', results)
          return results
        }
        message = (missing) => ({ op: 'tokenizer', loader, items: missing.map(({ kind, text, tools }) => ({ kind, text, tools })) })
      }
      const { out, failed } = await local(counter.id, list, message)
      const left = []
      for (const item of list) {
        const hit = out.get(item.key)
        if (hit) results[item.key] = { tokens: hit.tokens, exact: true, source: 'local', tokenizer: counter.tokenizer, template: hit.template, model: counter.model || null }
        else left.push(item)
      }
      if (failed) await estimates(left, counter, 'worker', results)
      return results
    }
    if (counter.kind === 'api') {
      const service = apis[counter.api] || null
      const missing = []
      for (const item of list) {
        const hit = cache.get(`${counter.id}|${item.hash}`)
        if (hit) results[item.key] = { tokens: hit.tokens, exact: true, source: 'api', api: counter.api, model: counter.model }
        else missing.push(item)
      }
      if (!missing.length) return results
      // Not the agent's own provider (index.js ownProviderOnly): never asked.
      if (counter.noRemote) {
        await estimates(missing, counter, counter.noRemote, results)
        return results
      }
      if (!remote || !service) {
        await estimates(missing, counter, service ? 'notCounted' : 'noKey', results)
        return results
      }
      let answers = {}
      try {
        answers = await service.count(
          counter.model,
          missing.map(({ key, kind, text, tools }) => ({ key, kind, text, tools })),
          auth || {}
        )
      } catch {
        answers = {}
      }
      const failed = []
      const counted = []
      for (const item of missing) {
        const a = answers[item.key]
        if (a && Number.isFinite(a.tokens)) {
          cache.set(`${counter.id}|${item.hash}`, { tokens: a.tokens, template: false })
          results[item.key] = { tokens: a.tokens, exact: true, source: 'api', api: counter.api, model: counter.model }
          counted.push(item)
        } else failed.push(item)
      }
      if (counted.length && counter.factorKey) {
        const { out } = await o200k(counted)
        for (const item of counted) {
          const base = out.get(item.key)
          if (base && base.tokens > 0) cache.calibrate(counter.factorKey, results[item.key].tokens, base.tokens)
        }
      }
      await estimates(failed, counter, (item) => (answers[item.key] && answers[item.key].error) || 'unavailable', results)
      return results
    }
    await estimates(list, counter, 'noCounter', results)
    return results
  }

  return { count }
}
