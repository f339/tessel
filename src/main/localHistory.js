// VS Code's Local History for Tessel's editor (its Timeline's "Local
// History"): each save keeps the file's text. Laid out as VS Code keeps it
// (workbench.localHistory: at most 50 versions a file, files up to 256 KB):
// <userData>/History/<hash of the path>/entries.json
//   { resource, entries: [{ id, source, timestamp }] }
// and one file per version named by its id. Paths are only keys here: the
// text comes from the editor, nothing is read from the path itself.
import fs from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'

const ID_RE = /^[a-z0-9]{6,32}$/

export function createLocalHistory({ dir, maxEntries = 50, maxBytes = 256 * 1024, now = () => Date.now() } = {}) {
  const folderOf = (path) => join(dir, crypto.createHash('sha256').update(String(path).toLowerCase()).digest('hex').slice(0, 24))
  const validPath = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096

  function readEntries(folder) {
    try {
      const data = JSON.parse(fs.readFileSync(join(folder, 'entries.json'), 'utf8'))
      return data && Array.isArray(data.entries) ? data : null
    } catch {
      return null
    }
  }
  function readVersion(folder, id) {
    if (!ID_RE.test(String(id || ''))) return null
    try {
      return fs.readFileSync(join(folder, id), 'utf8')
    } catch {
      return null
    }
  }

  // A save: its text kept, unless it is the same as the last one kept.
  function add({ path, text, source = 'save' } = {}) {
    if (!validPath(path) || typeof text !== 'string') return { ok: false }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: true, skipped: 'tooLarge' }
    const folder = folderOf(path)
    const data = readEntries(folder) || { resource: path, entries: [] }
    const last = data.entries[data.entries.length - 1]
    if (last && readVersion(folder, last.id) === text) return { ok: true, skipped: 'same' }
    fs.mkdirSync(folder, { recursive: true })
    const time = now()
    const id = time.toString(36) + crypto.randomBytes(3).toString('hex')
    fs.writeFileSync(join(folder, id), text, 'utf8')
    data.resource = path
    data.entries.push({ id, source: source === 'save' ? 'save' : 'other', timestamp: time })
    while (data.entries.length > maxEntries) {
      const old = data.entries.shift()
      try {
        if (ID_RE.test(old.id)) fs.unlinkSync(join(folder, old.id))
      } catch {
        /* gone already */
      }
    }
    fs.writeFileSync(join(folder, 'entries.json'), JSON.stringify(data), 'utf8')
    return { ok: true, id }
  }

  // -> { ok, entries: [{ id, source, timestamp }] }, newest first.
  function list({ path } = {}) {
    if (!validPath(path)) return { ok: false, entries: [] }
    const data = readEntries(folderOf(path))
    return { ok: true, entries: data ? data.entries.slice().reverse() : [] }
  }

  // -> { ok, text }
  function read({ path, id } = {}) {
    if (!validPath(path)) return { ok: false }
    const text = readVersion(folderOf(path), id)
    return text === null ? { ok: false } : { ok: true, text }
  }

  return { add, list, read }
}
