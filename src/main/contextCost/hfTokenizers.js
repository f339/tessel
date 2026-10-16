// The tokenizer files of Settings > Context that do not ship with Tessel
// (catalog.js): downloaded the first time one is needed, when the user clicks
// its Download button (it says the size), never on their own, from
// huggingface.co at a pinned revision. Each file is checked against the hash
// the catalogue gives (sha256 for an LFS file, git's blob sha1 for the
// others) before it is kept, in <userData>/tokenizers/<id>/; Remove deletes
// that folder. Nothing of the user's is sent: plain GET requests, redirects
// followed only over https to Hugging Face's own hosts (huggingface.co,
// hf.co and their CDN and storage subdomains).
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { TOKENIZER_FILES } from './catalog'
import { t } from '../i18n'

const READY = 'ready.json'
const SLACK = 4096
const MAX_REDIRECTS = 5

export const fileUrl = (spec, name) => `https://huggingface.co/${spec.repo}/resolve/${spec.rev}/${name}`
// The catalogue's entry for an id, never an inherited property
// ("constructor", "__proto__").
const specOf = (id) => (typeof id === 'string' && Object.hasOwn(TOKENIZER_FILES, id) ? TOKENIZER_FILES[id] : null)

// A download may only go (or be redirected) to Hugging Face, over https.
export function allowedDownloadUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const host = u.hostname.toLowerCase()
  return ['huggingface.co', 'hf.co'].some((d) => host === d || host.endsWith(`.${d}`))
}

export function matchesHash(buffer, want) {
  if (want.sha256) return createHash('sha256').update(buffer).digest('hex') === want.sha256
  if (want.sha1) return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') === want.sha1
  return false
}

export function createHfTokenizers({ dir, request = globalThis.fetch, timeoutMs = 5 * 60 * 1000, log = null }) {
  const busy = new Map() // family -> Promise
  const familyDir = (family) => path.join(dir, family)

  async function isReady(family) {
    const spec = specOf(family)
    if (!spec) return false
    try {
      const ready = JSON.parse(await fs.readFile(path.join(familyDir(family), READY), 'utf8'))
      if (!ready || ready.rev !== spec.rev) return false
      for (const name of Object.keys(spec.files)) await fs.access(path.join(familyDir(family), name))
      return true
    } catch {
      return false
    }
  }

  async function fetchFile(spec, name, want, signal) {
    let url = fileUrl(spec, name)
    let response = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowedDownloadUrl(url)) throw new Error(t('main.context.downloadHost', 'The download was redirected outside Hugging Face; it was stopped.'))
      response = await request(url, { signal, redirect: 'manual' })
      if (response.status < 300 || response.status >= 400) break
      const next = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null
      await response.body?.cancel?.().catch(() => {})
      if (!next || hop === MAX_REDIRECTS) throw new Error(t('main.context.downloadHttp', 'Hugging Face answered HTTP {{status}}.', { status: response.status }))
      url = new URL(next, url).href
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(t('main.context.downloadHttp', 'Hugging Face answered HTTP {{status}}.', { status: response.status }))
    }
    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > want.size + SLACK) throw new Error(t('main.context.downloadTooBig', 'The file is larger than expected.'))
        chunks.push(Buffer.from(part.value))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const buffer = Buffer.concat(chunks)
    if (!matchesHash(buffer, want)) throw new Error(t('main.context.downloadHash', 'The downloaded file does not match its expected hash.'))
    return buffer
  }

  async function download(family) {
    const spec = specOf(family)
    if (!spec) return { ok: false, error: t('main.context.unknownTokenizer', 'Unknown tokenizer.') }
    if (busy.has(family)) return busy.get(family)
    const work = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const target = familyDir(family)
      try {
        const files = {}
        for (const [name, want] of Object.entries(spec.files)) files[name] = await fetchFile(spec, name, want, controller.signal)
        await fs.mkdir(target, { recursive: true })
        for (const [name, buffer] of Object.entries(files)) {
          const tmp = path.join(target, `${name}.${process.pid}.tmp`)
          try {
            await fs.writeFile(tmp, buffer)
            await fs.rename(tmp, path.join(target, name))
          } catch (err) {
            await fs.rm(tmp, { force: true }).catch(() => {})
            throw err
          }
        }
        await fs.writeFile(path.join(target, READY), JSON.stringify({ rev: spec.rev, at: Date.now() }))
        log?.info?.('context', `tokenizer ${family} downloaded (${spec.repo}@${spec.rev.slice(0, 12)})`) // i18n-ignore
        return { ok: true }
      } catch (err) {
        const error = err && err.name === 'AbortError' ? t('main.context.downloadTimeout', 'The download took too long.') : (err && err.message) || String(err)
        log?.warn?.('context', `tokenizer ${family} download failed: ${error}`) // i18n-ignore
        return { ok: false, error }
      } finally {
        clearTimeout(timer)
      }
    })()
    busy.set(family, work)
    try {
      return await work
    } finally {
      busy.delete(family)
    }
  }

  // The folder and what is directly in it: files, and links unlinked (never
  // followed: Electron's recursive delete would empty a junction's target).
  async function remove(family) {
    const spec = specOf(family)
    if (!spec) return { ok: false, error: t('main.context.unknownTokenizer', 'Unknown tokenizer.') }
    const target = familyDir(family)
    let entries
    try {
      entries = await fs.readdir(target, { withFileTypes: true })
    } catch {
      return { ok: true } // nothing there
    }
    for (const e of entries) {
      const p = path.join(target, e.name)
      if (e.isSymbolicLink()) await fs.unlink(p).catch(() => fs.rmdir(p).catch(() => {}))
      else if (e.isFile()) await fs.rm(p, { force: true }).catch(() => {})
    }
    try {
      await fs.rmdir(target)
      return { ok: true }
    } catch {
      return { ok: false, error: t('main.context.removeFailed', 'The tokenizer folder could not be removed.') }
    }
  }

  return {
    // -> { [id]: { repo, licence, bytes, ready, busy } }
    async status() {
      const out = {}
      for (const [family, spec] of Object.entries(TOKENIZER_FILES)) {
        out[family] = {
          repo: spec.repo,
          licence: spec.licence,
          bytes: Object.values(spec.files).reduce((sum, f) => sum + f.size, 0),
          ready: await isReady(family),
          busy: busy.has(family)
        }
      }
      return out
    },
    // What the counting process loads, once downloaded and checked; else null.
    async loaderFor(family) {
      if (!(await isReady(family))) return null
      const spec = specOf(family)
      return { dir: familyDir(family), format: spec.format || 'hf', noTemplate: !!spec.noTemplate }
    },
    download,
    remove
  }
}
