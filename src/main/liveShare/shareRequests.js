// Live Share phase 2: the host's answers to a guest's requests on a shared
// project's files, notes and git changes.
//
// A guest's Files, editor and Changes views send requests ({ op, project,
// args }, src/shared/liveSharePath.js for the paths); the host's Live Share
// server checks who asks and how often (shareHost.js) and hands each one here
// with what the host decides: the project folders it shares ({ project id:
// folder }), the guest's rights on that project, and the share's settings.
// Nothing the guest sends is trusted:
//
// - an op this table knows, its arguments of the exact shapes it lists
//   (types, lengths, relative paths with strict segments: never absolute, a
//   drive, a share or \\?\);
// - the right it needs: reading comes with the project, saving, creating,
//   renaming and the Recycle Bin need `edit`, staging, discarding and
//   committing need `git` (requiredRight / mayRun);
// - every path through shareScope.js (inside the folder by its real path, the
//   hidden and write-protected files), right before the existing code runs on
//   it: explorer.js, editorFiles.js, sourceControl.js, fileOpen.js;
// - for a change, the right asked again right before it is made (ctx.recheck:
//   the guest's access may have been taken back while it waited);
// - answers with paths relative to the project only (a repository whose top
//   is above the project: only what is inside it, relative to it; what is
//   hidden counted, never named), without git's author emails or a remote
//   URL's credentials, cut to the limits both sides agree on (LSHARE_LIMITS);
// - errors as fixed codes (LSHARE_CODES), never the host's own text, which
//   names its folders; only git's words go out, its paths hidden and secrets
//   masked (shareChat.js), cut to 300 characters;
// - and assertNoHostPaths over every answer on its way out.
//
// handle() -> { ok: true, data } | { ok: false, code, detail? }: what the
// host's 'res' message carries.
import fs from 'fs'
import { t } from '../i18n'
import * as explorer from '../explorer'
import * as sourceControl from '../sourceControl'
import { looksBinary, hashOf, signatureOf, writeForEdit, headContent } from '../editorFiles'
import { listProjectFiles } from '../fileOpen'
import { fileKind, extOf, IMAGE_MIME } from '../../shared/fileKinds'
import { cleanRel, segmentOk, isShareProjectId, LSHARE_LIMITS as L } from '../../shared/liveSharePath'
import { guestText, cleanRoots, maskSecrets } from './shareChat'
import { createShareScope, assertNoHostPaths, writeAllowed, hiddenByName, relFrom } from './shareScope'

// --- Argument shapes -----------------------------------------------------------------
const OK = (value) => ({ ok: true, value })
const BAD = Object.freeze({ ok: false })
const opt = (check, fallback) => (v) => (v === undefined || v === null ? OK(fallback) : check(v))
const A = {
  bool: (v) => (typeof v === 'boolean' ? OK(v) : BAD),
  // A folder ('' is the project's own).
  dir: (v) => {
    const r = cleanRel(v)
    return r === null ? BAD : OK(r)
  },
  // A file or folder below the project (never the project itself).
  path: (v) => {
    const r = cleanRel(v)
    return r ? OK(r) : BAD
  },
  // Folders ('' is the project's own), each once.
  dirs: (max) => (v) => {
    if (!Array.isArray(v) || v.length > max) return BAD
    const out = new Set()
    for (const x of v) {
      const r = cleanRel(x)
      if (r === null) return BAD
      out.add(r)
    }
    return OK([...out])
  },
  paths: (max) => (v) => {
    if (!Array.isArray(v) || !v.length || v.length > max) return BAD
    const out = new Set()
    for (const x of v) {
      const r = cleanRel(x)
      if (!r) return BAD
      out.add(r)
    }
    return OK([...out])
  },
  text: (max) => (v) => (typeof v === 'string' && v.length <= max ? OK(v) : BAD),
  query: (max) => (v) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? OK(v) : BAD), // eslint-disable-line no-control-regex
  int: (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? OK(v) : BAD),
  num: (v) => (Number.isFinite(v) ? OK(v) : BAD),
  oneOf: (list) => (v) => (list.includes(v) ? OK(v) : BAD),
  commit: (v) => (sourceControl.isCommitId(v) ? OK(v) : BAD),
  hash: (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? OK(v) : BAD),
  // A new name in a folder: a segment both sides accept, and one the
  // explorer would make.
  name: (v) => {
    if (typeof v !== 'string') return BAD
    const n = v.trim()
    return segmentOk(n) && !explorer.checkName(n) ? OK(n) : BAD
  },
  // A remote branch to compare history with (origin/main).
  ref: (v) => (typeof v === 'string' && /^(?!-)[^\0\s~^:?*[\\]{1,200}$/.test(v) ? OK(v) : BAD)
}

// args as the schema says, or null. Unknown keys are left out (a newer
// guest's extras), never passed on.
export function parseArgs(schema, args) {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) return null
  const given = args || {}
  const out = {}
  for (const [key, check] of Object.entries(schema)) {
    const v = Object.hasOwn(given, key) ? given[key] : undefined
    const res = check(v)
    if (!res.ok) return null
    out[key] = res.value
  }
  return out
}

// --- Results -------------------------------------------------------------------------
const done = (data) => ({ ok: true, data })
const fail = (code, detail) => (typeof detail === 'string' && detail ? { ok: false, code, detail } : { ok: false, code })
const join2 = (a, b) => (a ? `${a}/${b}` : b)
const clip = (s, max) => (typeof s === 'string' ? (s.length > max ? s.slice(0, max) : s) : '')
const num = (v) => (Number.isFinite(v) ? v : null)
const lower = (s) => String(s).toLowerCase()

// sourceControl's own messages a guest gets as codes (compared in the
// language they were made in: the same t() call).
const SCM_CODES = [
  ['main.scm.notRepo', 'This folder is not in a git repository.', 'not-repo'],
  ['main.scm.nothingStaged', 'Stage at least one file to commit.', 'nothing-staged'],
  ['main.scm.noMessage', 'Enter a commit message to commit.', 'no-message'],
  ['main.scm.noGitName', 'Git does not know your name yet (Tools > Git > Set name & email), then commit again.', 'no-identity'],
  ['main.scm.badCommit', 'Unknown commit.', 'bad-commit'],
  ['main.scm.notRepoFile', 'Not a file of this repository.', 'not-found'],
  ['main.scm.unknownGroup', 'Unknown change group.', 'bad-args'],
  ['main.scm.versionTooLarge', 'This version is too large to compare (over 10 MB).', 'too-large'],
  ['main.scm.noRecycleBin', 'The Recycle Bin is not available.', 'unavailable'],
  ['main.scm.invalidFolder', 'Invalid folder.', 'no-project'],
  ['main.scm.folderMissing', 'The folder is missing.', 'no-project'],
  ['main.scm.compareUnavailable', 'Branch compare unavailable', 'unavailable']
]
const scmCodeOf = (error) => {
  for (const [key, english, code] of SCM_CODES) if (error === t(key, english)) return code
  return null
}
// headContent's notes and errors, as codes the guest words itself.
const HEAD_NOTES = [
  ['main.editor.noteNotRepo', 'Not in a git repository: there is no committed version to compare with.', 'not-repo'],
  ['main.editor.noteOutside', 'Outside the repository: there is no committed version to compare with.', 'outside'],
  ['main.editor.noteNoCommit', 'No commit yet: the left side is empty.', 'no-commit'],
  ['main.editor.noteNewFile', 'Not in the last commit (a new file): the left side is empty.', 'new-file']
]
const headNoteOf = (note) => {
  for (const [key, english, code] of HEAD_NOTES) if (note === t(key, english)) return code
  return ''
}

// A web address as a guest may get it: http(s) only, no user or password,
// secrets in it masked.
export function maskUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null
  try {
    const url = new URL(u)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.username = ''
    url.password = ''
    return maskSecrets(url.toString())
  } catch {
    return null
  }
}

// --- Rights ----------------------------------------------------------------------------
const OPS = {}
// The right an op needs: 'view' (comes with the project), 'edit' or 'git';
// null for an op this table does not know.
export function requiredRight(op) {
  return typeof op === 'string' && Object.hasOwn(OPS, op) ? OPS[op].right : null
}
// May a guest with these rights (on that project) run op? Reading: yes (the
// project being one of the guest's is the caller's check); a change: only
// with its right exactly on.
export function mayRun(op, rights) {
  const right = requiredRight(op)
  if (!right) return false
  if (right === 'view') return true
  return !!rights && typeof rights === 'object' && rights[right] === true
}

// --- The ops --------------------------------------------------------------------------
// right: see above; kind: 'light' | 'heavy' | 'write' (the host's budgets);
// bulk: its answer can be large (it waits behind terminal output); serial:
// git on the project, one at a time; keep: fields left as they are by the
// last guard (a file's own text); maxBytes: the answer's size at most.
function op(name, spec) {
  const kind = spec.kind || 'light'
  OPS[name] = { kind, right: kind === 'write' ? 'edit' : 'view', bulk: false, serial: false, keep: [], maxBytes: 4 * 1024 * 1024, args: {}, ...spec }
}

// One folder listed for a guest: its entries a guest may see, by name; a
// link inside the project shown as one, a link out of it left out.
async function listFolder(env, dir, dotfiles) {
  const res = explorer.listDir({ root: env.info.real, dir: dir.real, dotfiles })
  if (!res.ok) return fail('not-found')
  const kids = []
  let hidden = 0
  for (const e of res.entries) {
    if (!segmentOk(e.name)) {
      hidden++
      continue
    }
    const k = { name: e.name, dir: !!e.dir, rel: join2(dir.rel, e.name), realRel: join2(dir.realRel, e.name), linkRel: null, link: false }
    try {
      if (fs.lstatSync(e.path).isSymbolicLink()) {
        k.link = true
        k.linkRel = relFrom(env.info.real, fs.realpathSync.native(e.path))
        if (k.linkRel === null) {
          hidden++
          continue
        }
      }
    } catch {
      hidden++
      continue
    }
    kids.push(k)
  }
  const off = await env.scope.hiddenOf(env.info, [...new Set(kids.flatMap((k) => [k.rel, k.realRel, k.linkRel]).filter(Boolean))], env.settings)
  const entries = []
  for (const k of kids) {
    if (off.has(k.rel) || off.has(k.realRel) || (k.linkRel && off.has(k.linkRel))) hidden++
    else entries.push({ name: k.name, dir: k.dir, ...(k.link ? { link: true } : {}) })
  }
  return done({ entries, truncated: !!res.truncated, hidden })
}

op('fs.list', {
  bulk: true,
  args: { dir: opt(A.dir, ''), dotfiles: opt(A.bool, true) },
  async run(a, env) {
    const dir = await env.resolve(a.dir, { kind: 'dir' })
    if (!dir.ok) return fail(dir.code)
    return listFolder(env, dir, a.dotfiles)
  }
})

op('fs.listMany', {
  bulk: true,
  maxBytes: 8 * 1024 * 1024,
  args: { dirs: A.dirs(L.listMany), dotfiles: opt(A.bool, true), chain: opt(A.bool, false) },
  async run(a, env) {
    const results = []
    let total = 0
    for (const start of a.dirs) {
      let rel = start
      for (let guard = 0; guard <= 32; guard++) {
        if (total >= L.listManyEntries) {
          results.push({ dir: rel, ok: false, code: 'too-large' })
          break
        }
        const dir = await env.resolve(rel, { kind: 'dir' })
        const res = dir.ok ? await listFolder(env, dir, a.dotfiles) : dir
        if (!res.ok) {
          results.push({ dir: rel, ok: false, code: res.code })
          break
        }
        total += res.data.entries.length
        results.push({ dir: rel, ok: true, ...res.data })
        if (!a.chain || res.data.entries.length !== 1 || !res.data.entries[0].dir) break
        rel = join2(rel, res.data.entries[0].name)
      }
    }
    return done({ results })
  }
})

// Paths from the project's real folder, as explorer.js gives them -> wire
// paths (null: not one a guest can name).
const wireRel = (env, full) => {
  const rel = relFrom(env.info.real, full)
  return rel ? cleanRel(rel) : null
}

op('fs.searchNames', {
  kind: 'heavy',
  args: { query: A.query(L.query), dir: opt(A.dir, ''), dotfiles: opt(A.bool, true), limit: opt(A.int(1, L.results), L.results) },
  async run(a, env) {
    const scope = a.dir ? await env.resolve(a.dir, { kind: 'dir' }) : null
    if (scope && !scope.ok) return fail(scope.code)
    const res = await explorer.searchNames({ root: env.info.real, dir: scope ? scope.real : undefined, query: a.query, dotfiles: a.dotfiles, limit: explorer.SEARCH_LIMIT })
    if (!res.ok) return fail('failed')
    const found = []
    let hidden = 0
    for (const r of res.results) {
      const rel = wireRel(env, r.path)
      if (rel) found.push({ rel, dir: !!r.dir })
      else hidden++
    }
    const off = await env.scope.hiddenOf(env.info, found.map((r) => r.rel), env.settings)
    const results = []
    let truncated = !!res.truncated
    for (const r of found) {
      if (off.has(r.rel)) hidden++
      else if (results.length >= a.limit) truncated = true
      else results.push(r)
    }
    return done({ results, truncated, hidden })
  }
})

op('fs.searchContent', {
  kind: 'heavy',
  bulk: true,
  keep: ['results.*.text'],
  args: { query: A.query(L.contentQuery), limit: opt(A.int(1, L.results), L.results) },
  async run(a, env) {
    const res = await explorer.searchContent({ root: env.info.real, query: a.query, limit: explorer.SEARCH_LIMIT })
    if (!res.ok) return fail('failed')
    const found = []
    let hidden = 0
    for (const r of res.results) {
      const rel = wireRel(env, r.path)
      if (rel) found.push({ rel, line: r.line, text: clip(r.text, 1000) })
      else hidden++
    }
    const off = await env.scope.hiddenOf(env.info, [...new Set(found.map((r) => r.rel))], env.settings)
    const results = []
    let truncated = !!res.truncated
    for (const r of found) {
      if (off.has(r.rel)) hidden++
      else if (results.length >= a.limit) truncated = true
      else results.push(r)
    }
    return done({ results, truncated, hidden })
  }
})

op('fs.fileList', {
  kind: 'heavy',
  bulk: true,
  maxBytes: 8 * 1024 * 1024,
  async run(a, env) {
    const res = await listProjectFiles(env.info.real)
    if (!res.ok) return fail('not-found')
    const named = []
    let hidden = 0
    for (const f of res.files) {
      const rel = cleanRel(String(f).split(/[\\/]+/).filter(Boolean).join('/'))
      if (!rel || hiddenByName(rel, env.settings)) hidden++
      else named.push(rel)
    }
    // git's list leaves out what it ignores; a walk (git failed) does not.
    const off = res.source === 'git' ? new Set() : await env.scope.hiddenOf(env.info, named, env.settings)
    const files = []
    let truncated = !!res.truncated
    for (const rel of named) {
      if (off.has(rel)) hidden++
      else if (files.length < L.fileList) files.push(rel)
      else truncated = true
    }
    return done({ files, truncated, hidden, source: res.source === 'git' ? 'git' : 'walk' })
  }
})

// The repository a project is in, and the project's place below its top.
// -> { top, topReal, prefix ('' or "a/b") } | { notRepo: true } | null
async function repoPlace(env) {
  if (env.place !== undefined) return env.place
  let place = null
  const r = await sourceControl.repoOf(env.info.real)
  if (r.notRepo) place = { notRepo: true }
  else if (r.top) {
    try {
      const topReal = fs.realpathSync.native(r.top)
      const prefix = relFrom(topReal, env.info.real)
      if (prefix !== null) place = { top: r.top, topReal, prefix }
    } catch {
      place = null
    }
  }
  env.place = place
  if (place && place.top) env.hostPaths.push(place.top, place.topReal)
  return place
}
// A path git gives (from the top, "/") -> the wire path in the project, or
// null (elsewhere in the repository, or not one a guest can name).
export function fromTop(place, p) {
  if (!place || typeof p !== 'string' || !p) return null
  let rel = p
  if (place.prefix) {
    const pre = `${lower(place.prefix)}/`
    if (!lower(p).startsWith(pre)) return null
    rel = p.slice(pre.length)
  }
  return cleanRel(rel) || null
}
export const toTop = (place, rel) => (place.prefix ? `${place.prefix}/${rel}` : rel)
// Inside the project at all (named or not)?
const underRoot = (place, p) => !place.prefix || lower(p).startsWith(`${lower(place.prefix)}/`)

op('fs.status', {
  kind: 'heavy',
  bulk: true,
  serial: true,
  async run(a, env) {
    const top = await explorer.gitTop(env.info.real)
    if (!top) return done({ repo: false, files: {}, hidden: 0 })
    env.hostPaths.push(top)
    const res = await explorer.projectStatus({ root: env.info.real })
    if (!res.ok) return gitFail(env, res.error)
    if (!res.repo) return done({ repo: false, files: {}, hidden: 0 })
    let topReal
    try {
      topReal = fs.realpathSync.native(top)
    } catch {
      return fail('failed')
    }
    const prefix = relFrom(topReal, env.info.real)
    if (prefix === null) return fail('failed')
    const place = { prefix }
    const files = {}
    let hidden = 0
    let count = 0
    let truncated = false
    for (const [full, letter] of Object.entries(res.files)) {
      const p = relFrom(top, full)
      if (p === null || !underRoot(place, p)) continue
      const rel = fromTop(place, p)
      if (!rel || hiddenByName(rel, env.settings) || !/^[MADRCU!]$/.test(letter)) {
        hidden++
        continue
      }
      if (count >= L.scmEntries) {
        truncated = true
        break
      }
      files[rel] = letter
      count++
    }
    return done({ repo: true, files, hidden, truncated })
  }
})

op('fs.sparse', {
  serial: true,
  async run(a, env) {
    const res = await explorer.sparseInfo({ root: env.info.real })
    if (!res.ok) return fail('failed')
    if (!res.sparse) return done({ sparse: false, dirs: [] })
    const named = res.dirs.map((d) => cleanRel(String(d.rel || '').split(/[\\/]+/).filter(Boolean).join('/'))).filter(Boolean)
    const off = await env.scope.hiddenOf(env.info, named, env.settings)
    return done({ sparse: true, dirs: named.filter((r) => !off.has(r)).slice(0, L.entries) })
  }
})

// May the guest save this file (edit, and the type right for the files that
// run things by themselves)? Checked on both names it has.
const canWrite = (env, r) => env.rights.edit === true && writeAllowed(r.rel, env.rights) && writeAllowed(r.realRel, env.rights)

op('fs.read', {
  bulk: true,
  keep: ['text'],
  args: { path: A.path },
  async run(a, env) {
    const r = await env.resolve(a.path, { kind: 'file' })
    if (!r.ok) return fail(r.code)
    const got = env.scope.readResolved(r, L.textBytes)
    if (!got.ok) return fail(got.code)
    const buf = got.buf
    if (looksBinary(buf)) return fail('binary')
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf)
    } catch {
      return fail('encoding')
    }
    return done({ text, bom, size: got.stat.size, mtimeMs: got.stat.mtimeMs, sig: signatureOf(got.stat), hash: hashOf(buf), readOnly: !canWrite(env, r) })
  }
})

op('fs.stat', {
  args: { path: A.path },
  async run(a, env) {
    const r = await env.resolve(a.path, { kind: 'any' })
    if (!r.ok) return r.code === 'not-found' ? done({ exists: false, sig: null }) : fail(r.code)
    if (!r.isFile) return done({ exists: false, sig: null })
    try {
      const st = fs.statSync(r.real)
      return done({ exists: true, size: st.size, mtimeMs: st.mtimeMs, sig: signatureOf(st) })
    } catch {
      return done({ exists: false, sig: null })
    }
  }
})

op('fs.head', {
  bulk: true,
  keep: ['text'],
  args: { path: A.path },
  async run(a, env) {
    const r = await env.resolve(a.path, { mustExist: false })
    if (!r.ok) return fail(r.code)
    if (r.exists && !r.isFile) return fail('not-file')
    const res = await headContent(r.exists ? r.real : r.entry)
    if (!res.ok) {
      if (res.error === t('main.editor.headTooLarge', 'The committed version is too large to compare (over 10 MB).')) return fail('too-large')
      if (res.error === t('main.editor.headBinary', 'The committed version is binary: it cannot be compared here.')) return fail('binary')
      return fail('failed')
    }
    const text = typeof res.text === 'string' ? res.text : ''
    if (Buffer.byteLength(text, 'utf8') > L.textBytes) return fail('too-large')
    return done({ repo: !!res.repo, isNew: !!res.isNew, text, note: headNoteOf(res.note) })
  }
})

op('fs.image', {
  bulk: true,
  keep: ['dataUrl'],
  args: { path: A.path },
  async run(a, env) {
    if (fileKind(a.path) !== 'image') return fail('not-file')
    const r = await env.resolve(a.path, { kind: 'file' })
    if (!r.ok) return fail(r.code)
    const mime = IMAGE_MIME[extOf(r.realRel)] || IMAGE_MIME[extOf(a.path)]
    if (!mime) return fail('not-file')
    const got = env.scope.readResolved(r, L.imageBytes)
    if (!got.ok) return fail(got.code)
    return done({ size: got.stat.size, dataUrl: `data:${mime};base64,${got.buf.toString('base64')}` })
  }
})

// Asked again right before a change is made: the guest may have lost the
// project or the right while the request waited.
async function stillAllowed(env) {
  if (typeof env.ctx.recheck !== 'function') return true
  try {
    return (await env.ctx.recheck()) === true
  } catch {
    return false
  }
}

op('fs.write', {
  kind: 'write',
  args: { path: A.path, text: A.text(L.writeBytes), bom: opt(A.bool, false), expectHash: opt(A.hash, null) },
  async run(a, env) {
    if (Buffer.byteLength(a.text, 'utf8') + (a.bom ? 3 : 0) > L.writeBytes) return fail('too-large')
    const r = await env.resolve(a.path, { mustExist: false })
    if (!r.ok) return fail(r.code)
    if (!canWrite(env, r)) return fail('not-allowed')
    if (r.exists && r.isDir) return fail('is-folder')
    if (r.exists && !r.isFile) return fail('not-file')
    // A file there is replaced only as the guest last read it.
    if (r.exists && !a.expectHash) return fail('conflict')
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = await writeForEdit({ file: r.exists ? r.real : r.entry, text: a.text, bom: a.bom, ...(a.expectHash ? { expectHash: a.expectHash } : {}) })
    if (res.conflict) return fail('conflict')
    if (!res.ok) return fail('failed')
    if (/(^|\/)\.gitignore$/i.test(r.realRel)) env.scope.invalidate(env.info.real)
    return done({ size: res.size, mtimeMs: res.mtimeMs, sig: res.sig, hash: res.hash })
  }
})

op('fs.create', {
  kind: 'write',
  args: { dir: opt(A.dir, ''), name: A.name, folder: opt(A.bool, false) },
  async run(a, env) {
    const dir = await env.resolve(a.dir, { kind: 'dir' })
    if (!dir.ok) return fail(dir.code)
    const rel = join2(a.dir, a.name)
    const target = await env.resolve(rel, { mustExist: false })
    // A name a guest could not see once made (.git, .env...) is not made.
    if (!target.ok) return fail(target.code === 'not-found' ? 'not-allowed' : target.code)
    if (target.exists) return fail('exists')
    if (!canWrite(env, target)) return fail('not-allowed')
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = explorer.create({ root: env.info.real, dir: target.parentReal, name: a.name, folder: a.folder })
    if (!res.ok) return fail(fs.existsSync(target.entry) ? 'exists' : 'failed')
    env.scope.invalidate(env.info.real)
    return done({ rel })
  }
})

op('fs.rename', {
  kind: 'write',
  args: { path: A.path, name: A.name },
  async run(a, env) {
    const from = await env.resolve(a.path, { mustExist: true })
    if (!from.ok) return fail(from.code)
    const parent = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : ''
    const toRel = join2(parent, a.name)
    const to = await env.resolve(toRel, { mustExist: false })
    if (!to.ok) return fail(to.code === 'not-found' ? 'not-allowed' : to.code)
    // Only a change of case on Windows is the same file.
    if (to.exists && lower(to.entry) !== lower(from.entry)) return fail('exists')
    if (!canWrite(env, from) || !canWrite(env, to)) return fail('not-allowed')
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = explorer.rename({ root: env.info.real, path: from.entry, name: a.name })
    if (!res.ok) return fail('failed')
    env.scope.invalidate(env.info.real)
    return done({ rel: toRel })
  }
})

op('fs.trash', {
  kind: 'write',
  args: { path: A.path },
  async run(a, env) {
    const r = await env.resolve(a.path, { mustExist: true })
    if (!r.ok) return fail(r.code)
    if (!canWrite(env, r)) return fail('not-allowed')
    if (typeof env.ctx.trashItem !== 'function') return fail('unavailable')
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = await explorer.trash({ root: env.info.real, path: r.entry }, env.ctx.trashItem)
    if (!res.ok) return fail('failed')
    env.scope.invalidate(env.info.real)
    return done({ rel: a.path })
  }
})

// --- Notes (.tessel/notes.md, the one file of .tessel a guest sees) ---------------
const NOTES = '.tessel/notes.md'

op('notes.load', {
  keep: ['text'],
  async run(a, env) {
    const r = await env.resolve(NOTES, { mustExist: false })
    if (!r.ok && r.code !== 'not-found') return fail(r.code)
    if (!r.ok || !r.exists) return done({ exists: false, text: '', mtime: null })
    if (!r.isFile) return fail('not-file')
    const got = env.scope.readResolved(r, L.notesBytes)
    if (!got.ok) return fail(got.code)
    return done({ exists: true, text: got.buf.toString('utf8'), mtime: got.stat.mtimeMs })
  }
})

op('notes.save', {
  kind: 'write',
  args: { text: A.text(L.notesBytes), baseMtime: opt(A.num, null) },
  async run(a, env) {
    if (Buffer.byteLength(a.text, 'utf8') > L.notesBytes) return fail('too-large')
    let r = await env.resolve(NOTES, { mustExist: false })
    if (!r.ok && r.code === 'not-found') {
      // No .tessel folder yet: made, as the host's own first open does.
      const folder = await env.resolve('.tessel', { mustExist: false })
      if (!folder.ok) return fail(folder.code)
      if (folder.exists && !folder.isDir) return fail('not-found')
      if (!folder.exists) {
        if (!(await stillAllowed(env))) return fail('revoked')
        try {
          fs.mkdirSync(folder.entry)
        } catch {
          return fail('failed')
        }
      }
      r = await env.resolve(NOTES, { mustExist: false })
    }
    if (!r.ok) return fail(r.code)
    if (r.exists) {
      if (!r.isFile) return fail('not-file')
      // Changed since the guest's copy (an agent wrote in it): not written.
      let mtime
      try {
        mtime = fs.statSync(r.real).mtimeMs
      } catch {
        return fail('failed')
      }
      if (a.baseMtime === null || Math.abs(mtime - a.baseMtime) > 1) return fail('conflict')
    }
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = await writeForEdit({ file: r.exists ? r.real : r.entry, text: a.text })
    if (!res.ok) return fail('failed')
    return done({ mtime: res.mtimeMs })
  }
})

// --- Git -------------------------------------------------------------------------------
// git failed: a code when it is one of sourceControl's own messages, else
// 'git' with git's words, paths hidden and secrets masked, cut.
function gitFail(env, error) {
  const code = scmCodeOf(error)
  if (code) return fail(code)
  return fail('git', guestText(String(error || ''), cleanRoots([env.info.real, env.info.root]), L.detail))
}

// The repository's entries ({ path, oldPath?, ... } from its top) a guest
// gets: inside the project only, relative to it, the hidden ones counted.
function projectEntries(env, place, list, fields) {
  const entries = []
  let hidden = 0
  let truncated = false
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.path !== 'string' || !underRoot(place, e.path)) continue
    const rel = fromTop(place, e.path)
    if (!rel || hiddenByName(rel, env.settings)) {
      hidden++
      continue
    }
    if (entries.length >= L.scmEntries) {
      truncated = true
      break
    }
    const out = { path: rel }
    // An old name elsewhere or hidden is left out (never named).
    const oldRel = typeof e.oldPath === 'string' ? fromTop(place, e.oldPath) : null
    if (oldRel && !hiddenByName(oldRel, env.settings)) out.oldPath = oldRel
    for (const f of fields) {
      const v = e[f]
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[f] = v
      else if (v === null && (f === 'added' || f === 'removed')) out[f] = null
      else if (typeof v === 'string' && /^[\w-]{1,40}$/.test(v)) out[f] = v
    }
    entries.push(out)
  }
  return { entries, hidden, truncated }
}

// Before a change on files: each is one a guest may see (by name, and on
// disk where it is there; a file deleted with its folder by name).
async function visiblePaths(env, rels) {
  const off = await env.scope.hiddenOf(env.info, rels, env.settings)
  if (off.size) return false
  for (const rel of rels) if (!(await env.resolve(rel, { mustExist: 'any' })).ok) return false
  return true
}

// The place of the project in its repository, or the answer to give.
async function placeOrFail(env) {
  const place = await repoPlace(env)
  if (!place) return { failed: fail('failed') }
  if (place.notRepo) return { failed: fail('not-repo') }
  return { place }
}

const ref = (r) =>
  r && typeof r === 'object' && typeof r.id === 'string'
    ? { id: clip(r.id, 300), name: clip(r.name, 300), revision: clip(r.revision, 64), category: clip(r.category, 20) }
    : undefined

op('scm.status', {
  kind: 'heavy',
  bulk: true,
  serial: true,
  async run(a, env) {
    const res = await sourceControl.scmStatus({ root: env.info.real })
    if (!res.ok) return gitFail(env, res.error)
    if (!res.repo) return done({ repo: false })
    const { place, failed } = await placeOrFail(env)
    if (failed) return failed
    const { entries, hidden, truncated } = projectEntries(env, place, res.entries, ['area', 'status', 'conflict', 'conflictStatus', 'conflictKind', 'added', 'removed', 'binary'])
    return done({
      repo: true,
      branch: typeof res.branch === 'string' ? clip(res.branch, 300) : null,
      detached: !!res.detached,
      head: sourceControl.isCommitId(res.head) ? res.head : null,
      hasCommits: !!res.hasCommits,
      upstream: typeof res.upstream === 'string' ? clip(res.upstream, 300) : null,
      hasUpstream: !!res.hasUpstream,
      ahead: num(res.ahead) ?? 0,
      behind: num(res.behind) ?? 0,
      operation: ['merge', 'rebase', 'cherry-pick'].includes(res.operation) ? res.operation : null,
      remotes: (Array.isArray(res.remotes) ? res.remotes : []).filter((r) => typeof r === 'string').slice(0, 50).map((r) => clip(r, 200)),
      entries,
      hidden,
      truncated
    })
  }
})

op('scm.versions', {
  bulk: true,
  serial: true,
  keep: ['original', 'modified'],
  maxBytes: 6 * 1024 * 1024,
  args: {
    path: A.path,
    area: A.oneOf(['staged', 'unstaged', 'untracked', 'commit', 'branch']),
    oldPath: opt(A.path, null),
    commit: opt(A.commit, null),
    base: opt(A.commit, null)
  },
  async run(a, env) {
    const { place, failed } = await placeOrFail(env)
    if (failed) return failed
    const r = await env.resolve(a.path, { mustExist: 'any' })
    if (!r.ok) return fail(r.code)
    if (r.exists && !r.isFile) return fail('not-file')
    if (a.oldPath && !(await env.resolve(a.oldPath, { mustExist: 'any' })).ok) return fail('not-found')
    const res = await sourceControl.scmFileVersions({
      root: env.info.real,
      path: toTop(place, a.path),
      area: a.area,
      ...(a.oldPath ? { oldPath: toTop(place, a.oldPath) } : {}),
      ...(a.commit ? { commit: a.commit } : {}),
      ...(a.base ? { base: a.base } : {})
    })
    if (!res.ok) return gitFail(env, res.error)
    if (res.binary) return done({ binary: true, rel: a.path, exists: !!res.exists })
    const original = typeof res.original === 'string' ? res.original : ''
    const modified = typeof res.modified === 'string' ? res.modified : ''
    if (Buffer.byteLength(original, 'utf8') > L.textBytes || Buffer.byteLength(modified, 'utf8') > L.textBytes) return fail('too-large')
    return done({ original, modified, rel: a.path, exists: !!res.exists })
  }
})

op('scm.history', {
  kind: 'heavy',
  bulk: true,
  serial: true,
  args: { limit: opt(A.int(1, L.historyLimit), 50), base: opt(A.ref, null) },
  async run(a, env) {
    const res = await sourceControl.scmHistory({ root: env.info.real, limit: a.limit, ...(a.base ? { base: a.base } : {}) })
    if (!res.ok) return gitFail(env, res.error)
    // No author emails: name, time and message only.
    const items = (Array.isArray(res.items) ? res.items : []).slice(0, a.limit).map((c) => ({
      id: c.id,
      parentIds: (Array.isArray(c.parentIds) ? c.parentIds : []).filter(sourceControl.isCommitId).slice(0, 16),
      subject: clip(c.subject, 1000),
      message: clip(c.message, L.message),
      author: clip(c.author, 200),
      displayId: clip(c.displayId, 16),
      timestamp: num(c.timestamp) ?? undefined,
      references: (Array.isArray(c.references) ? c.references : []).slice(0, 50).map(ref).filter(Boolean)
    }))
    return done({
      items,
      currentRef: ref(res.currentRef),
      remoteRef: ref(res.remoteRef),
      baseRef: ref(res.baseRef),
      mergeBase: sourceControl.isCommitId(res.mergeBase) ? res.mergeBase : undefined,
      hasMore: !!res.hasMore,
      limit: num(res.limit) ?? a.limit
    })
  }
})

op('scm.commitFiles', {
  serial: true,
  args: { commit: A.commit },
  async run(a, env) {
    const res = await sourceControl.scmCommitFiles({ root: env.info.real, commit: a.commit })
    if (!res.ok) return gitFail(env, res.error)
    const { place, failed } = await placeOrFail(env)
    if (failed) return failed
    const { entries, hidden, truncated } = projectEntries(env, place, res.entries, ['status', 'added', 'removed'])
    return done({ entries, commit: res.commit, parent: sourceControl.isCommitId(res.parent) ? res.parent : null, hidden, truncated })
  }
})

op('scm.branchCompare', {
  kind: 'heavy',
  serial: true,
  async run(a, env) {
    const res = await sourceControl.scmBranchCompare({ root: env.info.real })
    if (!res.ok) return gitFail(env, res.error)
    if (!res.base) return done({ base: null })
    const { place, failed } = await placeOrFail(env)
    if (failed) return failed
    const { entries, hidden, truncated } = projectEntries(env, place, res.files, ['status', 'added', 'removed', 'binary'])
    // A project below its repository's top: the line totals would count the
    // rest of the repository too, so none.
    const whole = !place.prefix
    return done({
      base: clip(res.base, 300),
      mergeBase: res.mergeBase,
      ahead: num(res.ahead) ?? 0,
      behind: num(res.behind) ?? 0,
      added: whole ? num(res.added) : null,
      removed: whole ? num(res.removed) : null,
      reviewUrl: maskUrl(res.reviewUrl),
      onBase: !!res.onBase,
      head: sourceControl.isCommitId(res.head) ? res.head : null,
      files: entries,
      filesTruncated: !!res.filesTruncated || truncated,
      hidden
    })
  }
})

op('scm.fileHistory', {
  kind: 'heavy',
  serial: true,
  args: { path: A.path, limit: opt(A.int(1, L.historyLimit), 50) },
  async run(a, env) {
    const { place, failed } = await placeOrFail(env)
    if (failed) return failed
    const r = await env.resolve(a.path, { mustExist: 'any' })
    if (!r.ok) return fail(r.code)
    const res = await sourceControl.scmFileHistory({ root: env.info.real, path: toTop(place, a.path), limit: a.limit })
    if (!res.ok) return gitFail(env, res.error)
    const items = (Array.isArray(res.items) ? res.items : []).slice(0, a.limit).map((c) => ({ id: c.id, author: clip(c.author, 200), time: num(c.time) ?? 0, message: clip(c.message, L.message) }))
    return done({ items, hasMore: !!res.hasMore, uncommitted: !!res.uncommitted, rel: a.path })
  }
})

op('scm.commitInfo', {
  serial: true,
  args: { commit: A.commit },
  async run(a, env) {
    const res = await sourceControl.scmCommitInfo({ root: env.info.real, commit: a.commit })
    if (!res.ok) return gitFail(env, res.error)
    const s = res.stats || {}
    return done({ stats: { files: num(s.files) ?? 0, insertions: num(s.insertions) ?? 0, deletions: num(s.deletions) ?? 0 }, webUrl: maskUrl(res.webUrl) })
  }
})

// Stage, unstage, discard: the files a guest names, each one it may see.
function changeOp(name, call) {
  op(name, {
    kind: 'write',
    right: 'git',
    serial: true,
    args: { paths: A.paths(L.pathsPerCall) },
    async run(a, env) {
      const { place, failed } = await placeOrFail(env)
      if (failed) return failed
      if (!(await visiblePaths(env, a.paths))) return fail('not-found')
      if (!(await stillAllowed(env))) return fail('revoked')
      const res = await call({ root: env.info.real, paths: a.paths.map((p) => toTop(place, p)) }, env)
      if (!res.ok) return gitFail(env, res.error)
      return done(name === 'scm.discard' ? { restored: num(res.restored) ?? 0, trashed: num(res.trashed) ?? 0 } : {})
    }
  })
}
changeOp('scm.stage', (q) => sourceControl.scmStage(q))
changeOp('scm.unstage', (q) => sourceControl.scmUnstage(q))
changeOp('scm.discard', (q, env) => sourceControl.scmDiscard(q, env.ctx.trashItem))

op('scm.commit', {
  kind: 'write',
  right: 'git',
  serial: true,
  args: { message: A.text(L.message) },
  async run(a, env) {
    if (!a.message.replace(/\0/g, '').trim()) return fail('no-message')
    const { failed } = await placeOrFail(env)
    if (failed) return failed
    if (!(await stillAllowed(env))) return fail('revoked')
    const res = await sourceControl.scmCommit({ root: env.info.real, message: a.message })
    if (!res.ok) return gitFail(env, res.error)
    return done({ sha: sourceControl.isCommitId(res.sha) ? res.sha : null })
  }
})

// What the host's server needs to know of each op (its budgets): { right,
// kind, bulk }.
export const SHARE_OPS = Object.freeze(Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, Object.freeze({ right: v.right, kind: v.kind, bulk: v.bulk })])))

// --- The handler ---------------------------------------------------------------------
// The project's folder from the host's list ({ id: folder } or a Map).
function rootOf(roots, project) {
  if (!isShareProjectId(project) || !roots) return null
  const v = roots instanceof Map ? roots.get(project) : Object.hasOwn(roots, project) ? roots[project] : null
  return typeof v === 'string' ? v : null
}

// createShareRequests({ scope?, log? }) -> { handle(req, ctx), scope }
// req: { op, project, args } as the guest sent it.
// ctx: { roots, rights, settings, trashItem?, recheck? }: the host's.
export function createShareRequests({ scope = createShareScope(), log = null } = {}) {
  const chains = new Map() // project's real folder -> the git work queued on it
  function serial(key, fn) {
    const prev = chains.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => {},
      () => {}
    )
    chains.set(key, tail)
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return next
  }

  async function handle(req, ctx = {}) {
    const { op: name, project, args } = req && typeof req === 'object' ? req : {}
    const spec = typeof name === 'string' && Object.hasOwn(OPS, name) ? OPS[name] : null
    if (!spec) return fail('bad-op')
    const a = parseArgs(spec.args, args)
    if (!a) return fail('bad-args')
    const rootPath = rootOf(ctx.roots, project)
    if (!rootPath) return fail('no-project')
    const rights = ctx.rights && typeof ctx.rights === 'object' ? ctx.rights : {}
    if (!mayRun(name, rights)) return fail('forbidden')
    const info = scope.root(rootPath)
    if (!info) return fail('no-project')
    const settings = ctx.settings && typeof ctx.settings === 'object' ? ctx.settings : {}
    const env = {
      info,
      rights,
      settings,
      ctx,
      scope,
      place: undefined,
      hostPaths: [info.root, info.real],
      resolve: (rel, opts = {}) => scope.resolve(rootPath, rel, { settings, ...opts })
    }
    let res
    try {
      res = await (spec.serial ? serial(lower(info.real), () => spec.run(a, env)) : spec.run(a, env))
    } catch (err) {
      if (log && log.warn) log.warn('liveshare', `request ${name} failed: ${err && err.message}`) // i18n-ignore log line
      return fail('failed')
    }
    if (!res || typeof res !== 'object') return fail('failed')
    if (!res.ok) {
      const code = typeof res.code === 'string' ? res.code : 'failed'
      if (!res.detail) return fail(code)
      return fail(code, assertNoHostPaths(res.detail, env.hostPaths).value)
    }
    const { value, hits } = assertNoHostPaths(res.data, env.hostPaths, { keep: spec.keep })
    if (hits && log && log.warn) log.warn('liveshare', `answer to ${name}: ${hits} host path(s) replaced`) // i18n-ignore log line
    let size
    try {
      size = Buffer.byteLength(JSON.stringify(value), 'utf8')
    } catch {
      return fail('failed')
    }
    if (size > spec.maxBytes) return fail('too-large')
    return done(value)
  }

  return { handle, scope }
}
