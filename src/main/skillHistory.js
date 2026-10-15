// Version history of skill folders: the user's own skills, and any skill
// they edit. When the Skills list finds a skill whose content changed since
// its last version, a new version is kept, in Tessel's data folder, never in
// the skill's own folder:
//   <root>/<key of the folder>/index.json   the versions (files, hashes, when)
//   <root>/<key of the folder>/blobs/<sha>  each text file's content, once
// Text files only (a binary or very large file is noted by its hash, not
// kept); the last 30 versions and 8 MB per skill. A version can be compared
// with the one before, and restored (the current content is kept first).
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { t } from './i18n'
import { SKILL_CAPS, sameKey, sha256, contentHash, checkRemovable } from './skillsManager'
import { writeFileAtomic } from './safeJson'
import { diffTexts } from '../shared/diff'

export const HISTORY_CAPS = {
  versions: 30, // versions kept per skill
  bytes: 8 * 1024 * 1024, // text kept per skill, all versions together
  textFile: 512 * 1024, // a larger file is noted by its hash only
  diffLines: 4000, // lines shown in one version's diff, all files together
  unseenDays: 90 // a skill not listed for this long loses its history
}

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {})
const inside = (root, file) => {
  const rel = path.relative(root, file)
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}
const byRel = (x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0)
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

// The files of a skill folder within SKILL_CAPS (links and .git left out),
// sorted, and a signature of their sizes and times: when it has not moved,
// nothing is read again.
export async function readSkillTree(dir, caps = SKILL_CAPS) {
  const files = []
  let total = 0
  let truncated = false
  async function walk(abs, rel, depth) {
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= caps.files) {
        truncated = true
        return
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const child = path.join(abs, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (depth >= caps.depth) truncated = true
        else await walk(child, childRel, depth + 1)
      } else if (entry.isFile()) {
        let st
        try {
          st = await fs.stat(child)
        } catch {
          continue
        }
        if (total + st.size > caps.bytes) {
          truncated = true
          continue
        }
        total += st.size
        files.push({ rel: childRel, abs: child, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  await walk(dir, '', 0)
  files.sort(byRel)
  const sig = sha256(files.map((f) => `${f.rel}\0${f.size}\0${Math.round(f.mtimeMs)}`).join('\n'))
  return { files, total, truncated, sig }
}

// -> { track, annotate, list, diff, restore, prune }
export function createSkillHistory(root, { caps = HISTORY_CAPS, skillCaps = SKILL_CAPS, now = () => Date.now() } = {}) {
  const folderOf = (dir) => path.join(root, createHash('sha256').update(sameKey(dir)).digest('hex').slice(0, 24))
  const blobPath = (hdir, sha) => path.join(hdir, 'blobs', sha)
  function loadIndex(hdir) {
    try {
      const data = JSON.parse(fsSync.readFileSync(path.join(hdir, 'index.json'), 'utf8'))
      return data && Array.isArray(data.versions) ? data : null
    } catch {
      return null
    }
  }
  function saveIndex(hdir, index) {
    fsSync.mkdirSync(hdir, { recursive: true })
    writeFileAtomic(path.join(hdir, 'index.json'), JSON.stringify(index))
  }
  async function readBlob(hdir, sha) {
    try {
      return await fs.readFile(blobPath(hdir, sha), 'utf8')
    } catch {
      return null
    }
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

  // The oldest versions go first, beyond the count or the text kept; the
  // newest always stays. Then the contents no version uses are deleted.
  async function prune(hdir, index) {
    const keptBytes = () => {
      const seen = new Map()
      for (const v of index.versions) for (const f of v.files) if (f.text) seen.set(f.sha, f.size)
      return [...seen.values()].reduce((n, s) => n + s, 0)
    }
    while (index.versions.length > caps.versions) index.versions.shift()
    while (index.versions.length > 1 && keptBytes() > caps.bytes) index.versions.shift()
    const used = new Set(index.versions.flatMap((v) => v.files.filter((f) => f.text).map((f) => f.sha)))
    let names = []
    try {
      names = await fs.readdir(path.join(hdir, 'blobs'))
    } catch {
      // no contents yet
    }
    for (const name of names) if (!used.has(name)) await fs.rm(blobPath(hdir, name), { force: true }).catch(() => {})
  }

  async function trackNow(dir, { note = null, name = null } = {}) {
    const hdir = folderOf(dir)
    const index = loadIndex(hdir) || { dir: path.resolve(dir), name, versions: [] }
    if (name) index.name = name
    const tree = await readSkillTree(dir, skillCaps)
    const last = index.versions[index.versions.length - 1] || null
    const at = now()
    // Seen again: noted at most once a day (no write on every list).
    const seen = () => {
      const due = !index.seenAt || at - index.seenAt > 24 * 3600 * 1000
      index.seenAt = at
      return due
    }
    // Gone or unreadable (no SKILL.md): nothing to keep.
    if (!tree.files.some((f) => /^skill\.md$/i.test(f.rel))) return summary(index)
    if (last && index.sig === tree.sig) {
      if (seen()) saveIndex(hdir, index)
      return summary(index)
    }
    const files = []
    for (const f of tree.files) {
      let data
      try {
        data = await fs.readFile(f.abs)
      } catch {
        continue
      }
      files.push({ rel: f.rel, size: data.length, sha: sha256(data), data, mtimeMs: f.mtimeMs })
    }
    const hash = contentHash(files)
    index.sig = tree.sig
    if (last && last.hash === hash) {
      seen()
      saveIndex(hdir, index)
      return summary(index)
    }
    // A new version: each text file's content kept once, the lines it
    // added and removed counted against the version before.
    fsSync.mkdirSync(path.join(hdir, 'blobs'), { recursive: true })
    const before = new Map(last ? last.files.map((f) => [f.rel, f]) : [])
    const entries = []
    const stats = { added: 0, removed: 0, modified: 0, plus: 0, minus: 0 }
    for (const f of files) {
      const text = f.size <= caps.textFile && isText(f.data)
      if (text && !fsSync.existsSync(blobPath(hdir, f.sha))) {
        // Whole or not at all: written aside, then renamed.
        const part = `${blobPath(hdir, f.sha)}.part-${process.pid}`
        await fs.writeFile(part, f.data)
        await fs.rename(part, blobPath(hdir, f.sha))
      }
      entries.push({ rel: f.rel, size: f.size, sha: f.sha, text })
      const old = before.get(f.rel)
      if (!old) {
        stats.added++
        if (text) stats.plus += lineCount(f.data.toString('utf8'))
      } else if (old.sha !== f.sha) {
        stats.modified++
        const oldText = old.text ? await readBlob(hdir, old.sha) : null
        if (text && oldText != null) {
          const d = diffTexts(oldText, f.data.toString('utf8'), { maxLines: 0 })
          stats.plus += d.added
          stats.minus += d.removed
        }
      }
    }
    const names = new Set(files.map((f) => f.rel))
    for (const old of before.values()) {
      if (names.has(old.rel)) continue
      stats.removed++
      const oldText = old.text ? await readBlob(hdir, old.sha) : null
      if (oldText != null) stats.minus += lineCount(oldText)
    }
    // When it changed: its newest file, unless a file was only removed.
    const newest = files.reduce((n, f) => Math.max(n, f.mtimeMs || 0), 0)
    const changedAt = newest && (!last || newest > last.changedAt) ? Math.round(newest) : at
    index.versions.push({
      id: `${at.toString(36)}-${hash.slice(0, 8)}`,
      at,
      changedAt,
      hash,
      files: entries,
      stats,
      first: !last,
      truncated: tree.truncated || undefined,
      note: note || undefined
    })
    seen()
    await prune(hdir, index)
    saveIndex(hdir, index)
    return summary(index)
  }

  // dir -> { hash, versions, changedAt, firstAt }: a new version when its
  // content changed. note: why it changed ({ kind: 'install' | 'update' |
  // 'restore', … }), kept only on a new version.
  const track = (dir, opts) => serial(() => trackNow(dir, opts))

  // The listed skills, each with its history and, for one Tessel added, a
  // `modified` flag when it no longer matches what was installed. The agent's
  // own skills (synced, built in) are left alone. A copy recorded before
  // Tessel kept the installed content takes its content now as installed.
  let pruned = false
  async function annotate(skills, { sources = null } = {}) {
    if (!pruned) {
      pruned = true
      await pruneUnseen().catch(() => {})
    }
    for (const skill of skills) {
      if (skill.managed) continue
      try {
        const sum = await track(skill.dir, { name: skill.name })
        skill.history = { versions: sum.versions, changedAt: sum.changedAt, firstAt: sum.firstAt }
        skill.hash = sum.hash
        if (skill.source && sum.hash) {
          if (skill.source.hash) skill.modified = sum.hash !== skill.source.hash
          else {
            skill.modified = false
            if (sources) sources.set(skill.dir, { ...skill.source, hash: sum.hash, hashAdopted: true })
          }
        }
      } catch {
        skill.history = null
      }
    }
    return skills
  }

  // dir -> { versions: newest first, with what each changed }
  function list(dir) {
    const index = loadIndex(folderOf(dir))
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
  // -> { id, previous, files: [{ path, status, binary, hunks, added, removed, truncated }] }
  async function diff(dir, id) {
    const hdir = folderOf(dir)
    const index = loadIndex(hdir)
    const at = index ? index.versions.findIndex((v) => v.id === id) : -1
    if (at < 0) throw fail(t('main.skills.history.noVersion', 'This version is no longer in the history.'))
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
      const entry = { path: rel, status, binary: false, hunks: [], added: 0, removed: 0, truncated: false }
      if ((a && !a.text) || (b && !b.text)) entry.binary = true
      else {
        const oldText = a ? await readBlob(hdir, a.sha) : ''
        const newText = b ? await readBlob(hdir, b.sha) : ''
        if (oldText == null || newText == null) entry.binary = true
        else {
          const d = diffTexts(oldText, newText, { maxLines: Math.max(0, budget) })
          Object.assign(entry, { hunks: d.hunks, added: d.added, removed: d.removed, truncated: d.truncated })
          budget -= d.hunks.reduce((n, h) => n + h.lines.length, 0)
        }
      }
      files.push(entry)
    }
    return { id: version.id, previous: prev ? prev.id : null, files }
  }

  // Puts a version's files back in the skill folder (one directly in a known
  // root, never a link), after keeping the current content as a version.
  // Files the version lacks are removed when the history keeps them; a
  // binary or large one is left in place (`kept`).
  async function restore(dir, id, opts = {}) {
    await checkRemovable(dir, opts)
    const target = path.resolve(dir)
    return serial(async () => {
      await trackNow(target)
      const hdir = folderOf(target)
      const index = loadIndex(hdir)
      const version = index && index.versions.find((v) => v.id === id)
      if (!version) throw fail(t('main.skills.history.noVersion', 'This version is no longer in the history.'))
      const tree = await readSkillTree(target, skillCaps)
      const current = new Map()
      for (const f of tree.files) {
        try {
          const data = await fs.readFile(f.abs)
          current.set(f.rel, { abs: f.abs, sha: sha256(data), text: data.length <= caps.textFile && isText(data) })
        } catch {
          // unreadable: treated as absent
        }
      }
      // Every file of the version: already there, or kept whole (checked).
      const contents = new Map()
      const missing = []
      for (const f of version.files) {
        if (current.get(f.rel) && current.get(f.rel).sha === f.sha) continue
        const data = f.text ? await fs.readFile(blobPath(hdir, f.sha)).catch(() => null) : null
        if (data && sha256(data) === f.sha) contents.set(f.rel, data)
        else missing.push(f)
      }
      if (missing.length)
        throw fail(
          t('main.skills.history.cannotRestore', 'This version cannot be restored: {{files}} was not kept (binary or too large).', {
            files: missing.slice(0, 3).map((f) => f.rel).join(', ')
          }),
          'SKILL_HISTORY_MISSING'
        )
      // Never through a link: each folder written to is really in the skill.
      const realTarget = await fs.realpath(target)
      for (const [rel, data] of contents) {
        const file = path.resolve(target, ...rel.split('/'))
        if (!inside(target, file)) continue
        await fs.mkdir(path.dirname(file), { recursive: true })
        const realDir = await fs.realpath(path.dirname(file))
        if (realDir !== realTarget && !inside(realTarget, realDir)) continue
        const st = await fs.lstat(file).catch(() => null)
        if (st && !st.isFile()) continue
        await fs.writeFile(file, data)
      }
      const wanted = new Set(version.files.map((f) => f.rel))
      const kept = []
      for (const [rel, cur] of current) {
        if (wanted.has(rel)) continue
        if (!cur.text) {
          kept.push(rel)
          continue
        }
        await fs.rm(cur.abs, { force: true })
        // Folders left empty go too (never the skill folder itself).
        for (let up = path.dirname(cur.abs); inside(target, up); up = path.dirname(up)) {
          try {
            await fs.rmdir(up)
          } catch {
            break
          }
        }
      }
      const sum = await trackNow(target, { note: { kind: 'restore', from: version.id, fromAt: version.changedAt } })
      return { ok: true, kept, versions: sum.versions }
    })
  }

  // Histories of skills not listed for a long time (removed, or a project
  // never opened again) are deleted.
  async function pruneUnseen() {
    let names
    try {
      names = await fs.readdir(root)
    } catch {
      return
    }
    const limit = now() - caps.unseenDays * 24 * 3600 * 1000
    for (const name of names) {
      const hdir = path.join(root, name)
      const index = loadIndex(hdir)
      if (index && (index.seenAt || 0) < limit) await fs.rm(hdir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { track, annotate, list, diff, restore, prune: pruneUnseen, folderOf }
}
