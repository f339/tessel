// Version history of skill folders: the user's own skills, and any skill
// they edit. When the Skills list finds a skill whose content changed since
// its last version, a new version is kept, in Tessel's data folder, never in
// the skill's own folder:
//   <root>/<key of the folder>/index.json (+ .bak)  the versions (files, hashes, when)
//   <root>/<key of the folder>/blobs/<sha>          each kept file's content, once
// Every file up to 2 MB is kept (a larger one is noted by its hash only);
// folders a tool fills (node_modules, .venv, .git…) are left out, and never
// touched. The last 30 versions and 16 MB per skill, but always the last two
// and the one being restored. A version can be compared with the one before,
// and restored: only once the current content is kept whole, never over a
// file the history does not keep, never through a link, and all or nothing
// as far as can be checked first.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { t } from './i18n'
import { SKILL_CAPS, SKIPPED_DIR, sameKey, sha256, contentHash, checkRemovable, removeTree } from './skillsManager'
import { readJsonSafe, writeJsonSafe } from './safeJson'
import { diffTexts } from '../shared/diff'

export const HISTORY_CAPS = {
  versions: 30, // versions kept per skill (always at least the last two)
  bytes: 16 * 1024 * 1024, // content kept per skill, all versions together
  fileCap: 2 * 1024 * 1024, // a larger file is noted by its hash only
  diffLines: 4000, // lines shown in one version's diff, all files together
  goneDays: 180 // a skill folder gone, and not listed for this long: its history goes
}

const DAY = 24 * 3600 * 1000
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {})
const inside = (root, file) => {
  const rel = path.relative(root, file)
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}
const byRel = (x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0)
const validIndex = (data) => !!data && typeof data === 'object' && Array.isArray(data.versions)
// Kept: its content is in blobs/ (older versions said `text` for that).
const isKept = (f) => (f.kept == null ? !!f.text : !!f.kept)
// Text: no NUL byte in its first 8 KB, and valid UTF-8.
export function isText(data) {
  if (data.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}
const lineCount = (text) => (text ? text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0) : 0)

// The files of a skill folder within SKILL_CAPS, sorted, with a signature
// of their sizes and times (when it has not moved, nothing is read again).
// Breadth first, files before folders: the SKILL.md and the files at the
// top are read whatever the caps. Links, and the folders a tool fills
// (node_modules…), are left out. truncated: some files were not read.
export async function readSkillTree(dir, caps = SKILL_CAPS) {
  const files = []
  let total = 0
  let truncated = false
  const queue = [{ abs: dir, rel: '', depth: 0 }]
  while (queue.length) {
    const { abs, rel, depth } = queue.shift()
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      if (rel) truncated = true
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const child = path.join(abs, entry.name)
      let st
      try {
        st = await fs.stat(child)
      } catch {
        truncated = true
        continue
      }
      if (files.length >= caps.files || total + st.size > caps.bytes) {
        truncated = true
        continue
      }
      total += st.size
      files.push({ rel: rel ? `${rel}/${entry.name}` : entry.name, abs: child, size: st.size, mtimeMs: st.mtimeMs })
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIR.test(entry.name)) continue
      if (depth >= caps.depth) truncated = true
      else queue.push({ abs: path.join(abs, entry.name), rel: rel ? `${rel}/${entry.name}` : entry.name, depth: depth + 1 })
    }
  }
  files.sort(byRel)
  const sig = sha256(files.map((f) => `${f.rel}\0${f.size}\0${Math.round(f.mtimeMs)}`).join('\n') + (truncated ? '\0truncated' : ''))
  return { files, total, truncated, sig }
}

// caseInsensitive: file names compared as Windows and macOS do.
export function createSkillHistory(
  root,
  { caps = HISTORY_CAPS, skillCaps = SKILL_CAPS, now = () => Date.now(), caseInsensitive = process.platform === 'win32' || process.platform === 'darwin' } = {}
) {
  const keyOf = (rel) => (caseInsensitive ? rel.toLowerCase() : rel)
  const folderOf = (dir) => path.join(root, createHash('sha256').update(sameKey(dir)).digest('hex').slice(0, 24))
  const blobPath = (hdir, sha) => path.join(hdir, 'blobs', sha)
  const indexFile = (hdir) => path.join(hdir, 'index.json')
  const noVersion = () => fail(t('main.skills.history.noVersion', 'This version is no longer in the history.'), 'SKILL_HISTORY_NO_VERSION')

  // -> { index (null: none yet), from: 'file' | 'backup' | null }. A damaged
  // file falls back to its last good copy; one that cannot be read at all
  // (a lock that lasts, a folder in its place) stops everything: nothing is
  // written or deleted on a history that was not read.
  function loadIndex(hdir) {
    try {
      const res = readJsonSafe(indexFile(hdir), validIndex)
      return { index: res.data, from: res.from }
    } catch {
      throw fail(t('main.skills.history.unreadable', 'The history of this skill could not be read. Try again in a moment.'), 'SKILL_HISTORY_UNREADABLE')
    }
  }
  function saveIndex(hdir, index) {
    fsSync.mkdirSync(hdir, { recursive: true })
    writeJsonSafe(indexFile(hdir), index, validIndex)
  }
  async function readBlob(hdir, sha) {
    try {
      return await fs.readFile(blobPath(hdir, sha))
    } catch {
      return null
    }
  }
  // A kept content, checked against its hash (never a damaged one).
  async function blobOf(hdir, f) {
    if (!isKept(f)) return null
    const data = await readBlob(hdir, f.sha)
    return data && sha256(data) === f.sha ? data : null
  }

  // One change at a time: two lists at once must not both add a version.
  let queue = Promise.resolve()
  const serial = (fn) => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  const summary = (index) => {
    const last = index.versions[index.versions.length - 1]
    return {
      hash: last ? last.hash : null,
      versions: index.versions.length,
      changedAt: last ? last.changedAt : null,
      firstAt: index.versions.length ? index.versions[0].at : null
    }
  }

  // The oldest versions go first, beyond the count or the content kept;
  // never the last two, nor one in `keep` (the one being restored).
  function pruneVersions(index, keep) {
    const removable = (v, i) => i < index.versions.length - 2 && !keep.includes(v.id)
    const dropOldest = () => {
      const i = index.versions.findIndex(removable)
      if (i < 0) return false
      index.versions.splice(i, 1)
      return true
    }
    const keptBytes = () => {
      const seen = new Map()
      for (const v of index.versions) for (const f of v.files) if (isKept(f)) seen.set(f.sha, f.size)
      return [...seen.values()].reduce((n, s) => n + s, 0)
    }
    while (index.versions.length > caps.versions && dropOldest());
    while (keptBytes() > caps.bytes && dropOldest());
  }
  // Contents no version uses are deleted, after the index is saved: those
  // of the saved index and of its backup copy stay.
  async function collectBlobs(hdir, index) {
    const used = new Set(index.versions.flatMap((v) => v.files.filter(isKept).map((f) => f.sha)))
    try {
      const bak = JSON.parse(fsSync.readFileSync(`${indexFile(hdir)}.bak`, 'utf8'))
      if (validIndex(bak)) for (const v of bak.versions) for (const f of v.files || []) used.add(f.sha)
    } catch {
      // no backup copy
    }
    let names = []
    try {
      names = await fs.readdir(path.join(hdir, 'blobs'))
    } catch {
      // no contents yet
    }
    for (const name of names) if (!used.has(name)) await fs.rm(blobPath(hdir, name), { force: true }).catch(() => {})
  }

  // Keeps the folder's content as a new version when it changed.
  // -> summary + { saved, truncated, complete (the newest version holds all
  // of it), entries: [{ rel, abs, sha, size, text, kept }] of what is there }
  async function snapshotNow(dir, { note = null, name = null, keep = [] } = {}) {
    const hdir = folderOf(dir)
    const { index: loaded, from } = loadIndex(hdir)
    const index = loaded || { dir: path.resolve(dir), name, versions: [] }
    if (name) index.name = name
    const tree = await readSkillTree(dir, skillCaps)
    const at = now()
    const last = index.versions[index.versions.length - 1] || null
    const seenDue = () => {
      const due = !index.seenAt || at - index.seenAt > DAY
      index.seenAt = at
      return due
    }
    const result = (version, entries, saved = true) => ({
      ...summary(index),
      saved,
      truncated: tree.truncated,
      complete: saved && !tree.truncated && !!version && version.files.every(isKept),
      entries
    })
    const withAbs = (version) => {
      const abs = new Map(tree.files.map((f) => [f.rel, f.abs]))
      return version.files.map((f) => ({ ...f, abs: abs.get(f.rel), kept: isKept(f) }))
    }
    // Gone or unreadable (no SKILL.md): nothing to keep.
    if (!tree.files.some((f) => /^skill\.md$/i.test(f.rel))) return result(null, null, false)
    if (last && index.sig === tree.sig) {
      if (seenDue()) saveIndex(hdir, index)
      return result(last, withAbs(last))
    }
    const files = []
    for (const f of tree.files) {
      let data
      try {
        data = await fs.readFile(f.abs)
      } catch {
        tree.truncated = true
        continue
      }
      files.push({ rel: f.rel, abs: f.abs, size: data.length, sha: sha256(data), data, mtimeMs: f.mtimeMs })
    }
    const hash = contentHash(files)
    if (last && last.hash === hash && !last.truncated === !tree.truncated) {
      index.sig = tree.sig
      seenDue()
      saveIndex(hdir, index)
      return result(last, withAbs(last))
    }
    // A new version: each file's content kept once (up to the file cap),
    // the lines it added and removed counted against the version before.
    fsSync.mkdirSync(path.join(hdir, 'blobs'), { recursive: true })
    const before = new Map(last ? last.files.map((f) => [f.rel, f]) : [])
    const entries = []
    const stats = { added: 0, removed: 0, modified: 0, plus: 0, minus: 0 }
    for (const f of files) {
      const kept = f.size <= caps.fileCap
      const text = isText(f.data)
      if (kept && !fsSync.existsSync(blobPath(hdir, f.sha))) {
        // Whole or not at all: written aside, then renamed.
        const part = `${blobPath(hdir, f.sha)}.part-${randomBytes(4).toString('hex')}`
        await fs.writeFile(part, f.data)
        await fs.rename(part, blobPath(hdir, f.sha))
      }
      entries.push({ rel: f.rel, size: f.size, sha: f.sha, text, kept })
      const old = before.get(f.rel)
      if (!old) {
        stats.added++
        if (text) stats.plus += lineCount(f.data.toString('utf8'))
      } else if (old.sha !== f.sha) {
        stats.modified++
        const oldData = old.text ? await readBlob(hdir, old.sha) : null
        if (text && oldData) {
          const d = diffTexts(oldData.toString('utf8'), f.data.toString('utf8'), { maxLines: 0 })
          stats.plus += d.added
          stats.minus += d.removed
        }
      }
    }
    const names = new Set(files.map((f) => f.rel))
    for (const old of before.values()) {
      if (names.has(old.rel)) continue
      stats.removed++
      const oldData = old.text ? await readBlob(hdir, old.sha) : null
      if (oldData) stats.minus += lineCount(oldData.toString('utf8'))
    }
    // When it changed: its newest file, unless a file was only removed.
    const newest = files.reduce((n, f) => Math.max(n, f.mtimeMs || 0), 0)
    const changedAt = newest && (!last || newest > last.changedAt) ? Math.round(newest) : at
    const version = {
      id: `${at.toString(36)}-${hash.slice(0, 8)}`,
      at,
      changedAt,
      hash,
      files: entries,
      stats,
      first: !last,
      truncated: tree.truncated || undefined,
      note: note || undefined
    }
    index.versions.push(version)
    index.sig = tree.sig
    seenDue()
    pruneVersions(index, keep)
    saveIndex(hdir, index)
    // Contents are deleted only on a history read whole from its file.
    if (from === 'file') await collectBlobs(hdir, index)
    const abs = new Map(files.map((f) => [f.rel, f.abs]))
    return result(
      version,
      entries.map((e) => ({ ...e, abs: abs.get(e.rel) }))
    )
  }

  // dir -> { hash, versions, changedAt, firstAt, saved, truncated, complete }:
  // a new version when its content changed. note: why it changed ({ kind:
  // 'install' | 'update' | 'restore', … }), kept only on a new version.
  // Throws when the history cannot be read.
  const track = (dir, opts) =>
    serial(async () => {
      const res = await snapshotNow(dir, opts)
      delete res.entries
      return res
    })

  // The listed skills, each with its history and, for one Tessel added, a
  // `modified` flag when it no longer matches what was installed. The agent's
  // own skills (synced, built in) are left alone. A copy recorded before
  // Tessel kept the installed content takes its content now as installed
  // (the record read again just before, only the hash added).
  let pruned = false
  async function annotate(skills, { sources = null } = {}) {
    for (const skill of skills) {
      if (skill.managed) continue
      try {
        const sum = await track(skill.dir, { name: skill.name })
        skill.history = { versions: sum.versions, changedAt: sum.changedAt, firstAt: sum.firstAt }
        skill.hash = sum.hash
        const source = (sources && sources.get(skill.dir)) || skill.source
        if (source && sum.hash) {
          if (source.hash) skill.modified = sum.hash !== source.hash
          else {
            skill.modified = false
            const fresh = sources && sum.saved && !sum.truncated ? sources.get(skill.dir) : null
            if (fresh && !fresh.hash) sources.set(skill.dir, { ...fresh, hash: sum.hash, hashAdopted: true })
          }
        }
      } catch {
        skill.history = null
      }
    }
    if (!pruned) {
      pruned = true
      await pruneGone().catch(() => {})
    }
    return skills
  }

  // dir -> { versions: newest first, with what each changed }
  function list(dir) {
    const { index } = loadIndex(folderOf(dir))
    const versions = index ? index.versions : []
    return {
      dir,
      versions: versions
        .map((v, i) => {
          const prev = versions[i - 1]
          const was = new Map(prev ? prev.files.map((f) => [f.rel, f.sha]) : [])
          const changed = prev
            ? [
                ...v.files.filter((f) => was.get(f.rel) !== f.sha).map((f) => f.rel),
                ...prev.files.filter((f) => !v.files.some((x) => x.rel === f.rel)).map((f) => f.rel)
              ]
            : v.files.map((f) => f.rel)
          return {
            id: v.id,
            at: v.at,
            changedAt: v.changedAt,
            stats: v.stats,
            first: !!v.first,
            oldest: i === 0 && !v.first,
            latest: i === versions.length - 1,
            note: v.note || null,
            files: changed.slice(0, 50),
            fileCount: changed.length
          }
        })
        .reverse()
    }
  }

  // A version against the one before it (the oldest kept: against nothing).
  // -> { id, previous, files: [{ path, status, binary, notKept, hunks, added, removed, truncated }] }
  async function diff(dir, id) {
    const hdir = folderOf(dir)
    const { index } = loadIndex(hdir)
    const at = index ? index.versions.findIndex((v) => v.id === id) : -1
    if (at < 0) throw noVersion()
    const version = index.versions[at]
    const prev = index.versions[at - 1] || null
    const was = new Map(prev ? prev.files.map((f) => [f.rel, f]) : [])
    const is = new Map(version.files.map((f) => [f.rel, f]))
    const paths = [...new Set([...was.keys(), ...is.keys()])].sort()
    const files = []
    let budget = caps.diffLines
    for (const rel of paths) {
      const a = was.get(rel) || null
      const b = is.get(rel) || null
      if (a && b && a.sha === b.sha) continue
      const status = !a ? 'A' : !b ? 'D' : 'M'
      const entry = { path: rel, status, binary: false, notKept: false, hunks: [], added: 0, removed: 0, truncated: false }
      if ((a && !isKept(a)) || (b && !isKept(b))) entry.notKept = true
      else if ((a && !a.text) || (b && !b.text)) entry.binary = true
      else {
        const oldData = a ? await readBlob(hdir, a.sha) : Buffer.alloc(0)
        const newData = b ? await readBlob(hdir, b.sha) : Buffer.alloc(0)
        if (!oldData || !newData) entry.notKept = true
        else {
          const d = diffTexts(oldData.toString('utf8'), newData.toString('utf8'), { maxLines: Math.max(0, budget) })
          Object.assign(entry, { hunks: d.hunks, added: d.added, removed: d.removed, truncated: d.truncated })
          budget -= d.hunks.reduce((n, h) => n + h.lines.length, 0)
        }
      }
      files.push(entry)
    }
    return { id: version.id, previous: prev ? prev.id : null, files }
  }

  // Is something in the way of writing `rel` (not there yet)? A link on the
  // way, a file where a folder goes (unless it is deleted first), or a
  // folder where the file goes (unless all it holds is deleted first).
  async function inTheWay(target, rel, deleting) {
    const parts = rel.split('/')
    let abs = target
    for (let i = 0; i < parts.length; i++) {
      abs = path.join(abs, parts[i])
      const st = await fs.lstat(abs).catch(() => null)
      if (!st) return false
      const key = keyOf(parts.slice(0, i + 1).join('/'))
      if (st.isSymbolicLink()) return true
      if (i < parts.length - 1) {
        if (st.isDirectory()) continue
        return !(st.isFile() && deleting.has(key))
      }
      if (st.isFile()) return !deleting.has(key)
      if (st.isDirectory()) return !(await emptiesOut(abs, key, deleting))
      return true
    }
    return false
  }
  async function emptiesOut(abs, key, deleting) {
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const sub = `${key}/${keyOf(entry.name)}`
      if (entry.isSymbolicLink()) return false
      if (entry.isDirectory()) {
        if (!(await emptiesOut(path.join(abs, entry.name), sub, deleting))) return false
      } else if (!entry.isFile() || !deleting.has(sub)) return false
    }
    return true
  }
  // The folders of `rel`, made inside the skill, each a real folder there.
  async function makeParents(target, realTarget, rel) {
    const parts = rel.split('/').slice(0, -1)
    let abs = target
    for (const part of parts) {
      abs = path.join(abs, part)
      const st = await fs.lstat(abs).catch(() => null)
      if (!st) await fs.mkdir(abs)
      else if (st.isSymbolicLink() || !st.isDirectory()) throw blockedError([rel])
    }
    const real = await fs.realpath(abs)
    if (real !== realTarget && !inside(realTarget, real)) throw blockedError([rel])
  }
  const blockedError = (files) =>
    fail(
      t('main.skills.history.blocked', 'This version cannot be restored: {{files}} is in the way (now a folder, a file or a link).', {
        files: files.slice(0, 3).join(', ')
      }),
      'SKILL_HISTORY_BLOCKED'
    )
  // A file's name given the version's case ("skill.md" back from "SKILL.md").
  async function fixCase(abs, rel) {
    const to = path.join(path.dirname(abs), path.posix.basename(rel))
    if (to === abs) return
    const tmp = `${abs}.tessel-case-${randomBytes(4).toString('hex')}`
    await fs.rename(abs, tmp)
    await fs.rename(tmp, to)
  }

  // Puts a version's files back in the skill folder (one directly in a known
  // root, never a link). First the current content is kept as a version, and
  // it must be kept whole; then everything is checked (each file to write is
  // kept and intact, each file replaced or removed is kept, nothing in the
  // way): any problem, and nothing changes. A file the version lacks that
  // the history does not keep is left in place (`kept`).
  async function restore(dir, id, opts = {}) {
    await checkRemovable(dir, opts)
    const target = path.resolve(dir)
    return serial(async () => {
      const hdir = folderOf(target)
      const before = loadIndex(hdir).index
      if (!before || !before.versions.some((v) => v.id === id)) throw noVersion()
      // The version restored stays, whatever the current one pushes out.
      const snap = await snapshotNow(target, { keep: [id] })
      if (!snap.saved || snap.truncated || !snap.entries)
        throw fail(
          t('main.skills.history.incomplete', 'The current content could not be kept whole in the history (too many files), so nothing was restored.'),
          'SKILL_HISTORY_INCOMPLETE'
        )
      const index = loadIndex(hdir).index
      const version = index && index.versions.find((v) => v.id === id)
      if (!version) throw noVersion()
      const isSaved = (c) => c.kept && fsSync.existsSync(blobPath(hdir, c.sha))
      const current = new Map(snap.entries.filter((e) => e.abs).map((e) => [keyOf(e.rel), e]))
      const wanted = new Map(version.files.map((f) => [keyOf(f.rel), f]))
      const deletes = []
      const kept = []
      for (const [key, c] of current) {
        if (wanted.has(key)) continue
        if (isSaved(c)) deletes.push(c)
        else kept.push(c.rel)
      }
      const deleting = new Set(deletes.map((c) => keyOf(c.rel)))
      const writes = []
      const renames = []
      const missing = []
      const notKept = []
      const blocked = []
      for (const [key, f] of wanted) {
        const c = current.get(key)
        if (c && c.sha === f.sha) {
          if (path.posix.basename(c.rel) !== path.posix.basename(f.rel)) renames.push({ abs: c.abs, rel: f.rel })
          continue
        }
        if (c && !isSaved(c)) {
          notKept.push(c.rel)
          continue
        }
        const data = await blobOf(hdir, f)
        if (!data) {
          missing.push(f.rel)
          continue
        }
        if (!c && (await inTheWay(target, f.rel, deleting))) {
          blocked.push(f.rel)
          continue
        }
        writes.push({ rel: f.rel, abs: c ? c.abs : path.resolve(target, ...f.rel.split('/')), data, recase: !!c && c.rel !== f.rel })
      }
      if (missing.length)
        throw fail(
          t('main.skills.history.cannotRestore', 'This version cannot be restored: {{files}} was not kept in the history (too large).', {
            files: missing.slice(0, 3).join(', ')
          }),
          'SKILL_HISTORY_MISSING'
        )
      if (notKept.length)
        throw fail(
          t('main.skills.history.notKeptFiles', 'Restoring would replace {{files}}, which is too large to keep in the history, so nothing was restored.', {
            files: notKept.slice(0, 3).join(', ')
          }),
          'SKILL_HISTORY_NOT_KEPT'
        )
      if (blocked.length) throw blockedError(blocked)
      if (writes.some((w) => !inside(target, w.abs))) throw blockedError(writes.filter((w) => !inside(target, w.abs)).map((w) => w.rel))
      const realTarget = await fs.realpath(target)
      try {
        // Removed first (a file where a folder goes), each kept in the history.
        for (const c of deletes) {
          await fs.unlink(c.abs)
          for (let up = path.dirname(c.abs); inside(target, up); up = path.dirname(up)) {
            try {
              await fs.rmdir(up)
            } catch {
              break
            }
          }
        }
        for (const w of writes) {
          await makeParents(target, realTarget, w.rel)
          const st = await fs.lstat(w.abs).catch(() => null)
          if (st && !st.isFile()) throw blockedError([w.rel])
          await fs.writeFile(w.abs, w.data)
          if (w.recase) await fixCase(w.abs, w.rel)
        }
        for (const r of renames) await fixCase(r.abs, r.rel)
      } catch (err) {
        throw fail(
          t('main.skills.history.partial', 'The restore stopped part way: {{error}} The content from before is in the history.', {
            error: (err && err.message) || String(err)
          }),
          'SKILL_RESTORE_PARTIAL'
        )
      }
      const sum = await snapshotNow(target, { note: { kind: 'restore', from: version.id, fromAt: version.changedAt } })
      return { ok: true, kept, versions: sum.versions }
    })
  }

  // The history of a skill whose folder is gone (deleted, a removed
  // worktree) and that was not listed for a long time is deleted. A skill
  // still there keeps its history, listed or not; a folder on a drive that
  // is not there now is never taken for gone.
  async function pruneGone() {
    let names
    try {
      names = await fs.readdir(root)
    } catch {
      return
    }
    const limit = now() - caps.goneDays * DAY
    for (const name of names) {
      const hdir = path.join(root, name)
      let index
      try {
        index = loadIndex(hdir).index
      } catch {
        continue
      }
      if (!index || !index.dir || (index.seenAt || 0) >= limit) continue
      let gone = false
      try {
        await fs.stat(index.dir)
      } catch (err) {
        gone = !!err && err.code === 'ENOENT' && fsSync.existsSync(path.parse(path.resolve(index.dir)).root)
      }
      if (gone) await removeTree(hdir).catch(() => {})
    }
  }

  return { track, annotate, list, diff, restore, prune: pruneGone, folderOf }
}
