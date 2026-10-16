// Live Share phase 2: what of a shared project's folder a guest may reach.
//
// A guest names a file by its path relative to the project (liveSharePath.js:
// strict segments, never absolute); the host turns it into a path on its own
// disk here, and every request (shareRequests.js) goes through it. The rules:
//
// - Inside the project's folder only, by its real path. The folder is taken
//   as the window gave it (absolute, local, an existing folder) and resolved
//   once with realpath.native (a junction, an 8.3 short name). Each part of a
//   path that exists is looked at on the way down: a link or a junction is
//   followed only when it lands inside the folder. The target's real path
//   (for a new file, its folder's) must be inside it too, and a file opened
//   is checked again by its identity on disk (dev and inode) against the one
//   resolved, which narrows the gap where a folder could be swapped for a
//   junction in between.
// - Always hidden, whatever the share's settings: .git (a repository's own
//   files: hooks, config, the paths of its worktrees) and .tessel (the team's
//   inboxes, named by their secret token, its messages, the worktree setup
//   script that runs by itself), except .tessel/notes.md.
// - Hidden while "Hide ignored and secret files from guests" is on (the
//   share's setting, on by default): what git ignores (git check-ignore, run
//   with the repository's risky settings off, gitSafety.js; kept per project
//   and forgotten when its files change) and what looks like a secret by its
//   name (.env, keys, credentials, cloud folders: SECRET_*).
// - Write-protected even with the edit right, unless the guest may also type
//   (which already runs any command as the host): the files agents and tools
//   run or obey by themselves (.claude/, .mcp.json, .vscode/, git hooks
//   managers, .envrc...).
//
// Every rule is matched without case on both the path the guest gave and the
// real one (realpath.native expands 8.3 names: TESSEL~1 is .tessel), so a
// hidden file is not reached under another name. A hidden path answers as
// missing: a guest learns nothing of what is there.
//
// And on the way out, assertNoHostPaths() is the last guard over any answer:
// the project folders' paths and any drive, share or long path left in it
// become "…".
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { join, relative, isAbsolute, sep, resolve, dirname } from 'path'
import { localGitArgs } from '../gitSafety'
import { cleanEnv } from '../cleanEnv'
import { relSegments } from '../../shared/liveSharePath'

// --- Rules on relative paths (pure) ---------------------------------------------
const lower = (rel) => String(rel || '').toLowerCase()
const segsOf = (rel) => (rel ? lower(rel).split('/') : [])

// .git anywhere (a nested repository or a worktree's .git file too), and
// .tessel anywhere but its notes (the folder itself is listed, to reach them).
export function isAlwaysHidden(rel) {
  const segs = segsOf(rel)
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.git') return true
    if (segs[i] === '.tessel') {
      if (i === segs.length - 1) return false
      return !(i === segs.length - 2 && segs[i + 1] === 'notes.md')
    }
  }
  return false
}

// Names that hold secrets by convention (hidden with the setting on).
const SECRET_EXACT = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials'])
const SECRET_FOLDERS = new Set(['.aws', '.ssh', '.docker'])
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/, // .env, .env.local... (examples below are not)
  /\.(pem|key|p12|pfx|kdbx|tfvars)$/,
  /^id_(rsa|ed25519)/,
  /\.tfstate/,
  /^credentials.*\.json$/,
  /^service-account.*\.json$/
]
const SECRET_EXAMPLE = /^\.env(\..+)?\.(example|sample|template)$/
export function isSecretName(name) {
  const n = lower(name)
  if (!n) return false
  if (SECRET_EXACT.has(n) || SECRET_FOLDERS.has(n)) return true
  if (SECRET_EXAMPLE.test(n)) return false
  return SECRET_PATTERNS.some((re) => re.test(n))
}
export const isSecretRel = (rel) => segsOf(rel).some(isSecretName)

// Hidden by its path alone (no disk, no git): always, and the secret names
// while the setting is on.
export function hiddenByName(rel, settings) {
  return isAlwaysHidden(rel) || (hidesPrivate(settings) && isSecretRel(rel))
}

// The share's setting "Hide ignored and secret files from guests": on unless
// turned off.
export const DEFAULT_SHARE_SETTINGS = Object.freeze({ hideIgnored: true })
export const hidesPrivate = (settings) => !(settings && settings.hideIgnored === false)

// Files that run something, or tell an agent or a tool what to run, by
// themselves: written by a guest only with the type right too.
const PROTECTED_FOLDERS = new Set(['.claude', '.codex', '.gemini', '.cursor', '.vscode', '.husky'])
const PROTECTED_FILES = new Set(['.mcp.json', '.envrc'])
export function isProtectedRel(rel) {
  const segs = segsOf(rel)
  for (let i = 0; i < segs.length; i++) {
    if (PROTECTED_FOLDERS.has(segs[i])) return true
    if (segs[i] === '.tessel' && segs[i + 1] === 'setup.ps1') return true
  }
  return segs.length > 0 && PROTECTED_FILES.has(segs[segs.length - 1])
}
// May a guest with these rights change `rel` (the edit or git right itself is
// the caller's check)?
export const writeAllowed = (rel, rights) => !isProtectedRel(rel) || !!(rights && rights.type === true)

// --- Roots -------------------------------------------------------------------------
// The project's folder as the window gave it: absolute, local (not ssh:// or
// lshare://, not a share's long-path form), an existing folder.
// -> { root, real } | null
export function rootInfo(root) {
  if (typeof root !== 'string' || !root || root.length > 1024 || !isAbsolute(root)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root) || /^\\\\[?.]\\/.test(root)) return null
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\u0000-\u001f]/.test(root)) return null
  try {
    const real = fs.realpathSync.native(resolve(root))
    if (!fs.statSync(real).isDirectory()) return null
    // A whole drive or share is never a project.
    if (dirname(real) === real) return null
    return { root: resolve(root), real }
  } catch {
    return null
  }
}

// Is p the base folder or inside it (Windows: without case)?
export function within(base, p) {
  const rel = relative(base, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
// p's path from base with "/" ('' for base itself); null when outside.
export function relFrom(base, p) {
  if (!within(base, p)) return null
  const rel = relative(base, p)
  return rel ? rel.split(sep).join('/') : ''
}

const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino

// --- Git check-ignore ----------------------------------------------------------------
const IGNORE_TTL_MS = 30000
const IGNORE_CACHE_MAX = 50000
const IGNORE_TIMEOUT_MS = 10000

// git check-ignore -z --stdin over rels (paths from cwd): -> Set of the
// ignored ones | null (git failed: the caller hides them all).
export function checkIgnore(cwd, safety, rels) {
  return new Promise((done) => {
    let child
    try {
      child = spawn('git', ['-C', cwd, ...safety, 'check-ignore', '-z', '--stdin'], {
        windowsHide: true,
        env: { ...cleanEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      })
    } catch {
      return done(null)
    }
    let out = ''
    let finished = false
    const finish = (v) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(v)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone already
      }
      finish(null)
    }, IGNORE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s) => {
      out += s
      if (out.length > 64 * 1024 * 1024) {
        try {
          child.kill()
        } catch {
          // gone already
        }
        finish(null)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(null))
    child.stdin.on('error', () => {})
    // 0: some ignored, 1: none; anything else is git failing.
    child.on('close', (code) => finish(code === 0 || code === 1 ? new Set(out.split('\0').filter(Boolean)) : null))
    child.stdin.end(rels.join('\0') + '\0')
  })
}

// --- The scope -----------------------------------------------------------------------
// One per host: the roots' real paths and each project's ignored files, kept
// between requests. ignoreCheck(cwd, safety, rels) and gitTop(root) can be
// given (tests); git by default.
export function createShareScope({ ignoreCheck = checkIgnore, gitTop = defaultGitTop } = {}) {
  const roots = new Map() // root as given -> { root, real }
  const ignores = new Map() // real root -> { at, repo: Promise<{ top, safety } | null>, known: Map rel -> bool }

  function root(path) {
    if (roots.has(path)) return roots.get(path)
    const info = rootInfo(path)
    if (info) {
      roots.set(path, info)
      if (roots.size > 64) roots.delete(roots.keys().next().value)
    }
    return info
  }

  function ignoreState(real) {
    let s = ignores.get(real)
    if (!s || Date.now() - s.at > IGNORE_TTL_MS || s.known.size > IGNORE_CACHE_MAX) {
      s = { at: Date.now(), repo: null, known: new Map() }
      ignores.set(real, s)
      if (ignores.size > 64) ignores.delete(ignores.keys().next().value)
    }
    if (!s.repo) {
      s.repo = (async () => {
        const top = await gitTop(real)
        if (!top) return null
        return { top, safety: await localGitArgs(top, { ask: false }) }
      })().catch(() => null)
    }
    return s
  }

  // Which of rels (paths from the root's real path) git ignores: -> Set. Not
  // a repository: none. git failing: all of them (not kept: asked again).
  async function ignoredOf(info, rels) {
    const list = [...new Set(rels.filter((r) => typeof r === 'string' && r))]
    if (!list.length) return new Set()
    const s = ignoreState(info.real)
    const repo = await s.repo
    if (!repo) return new Set()
    const out = new Set()
    const ask = []
    for (const r of list) {
      const k = lower(r)
      if (s.known.has(k)) {
        if (s.known.get(k)) out.add(r)
      } else ask.push(r)
    }
    if (ask.length) {
      const hits = await ignoreCheck(info.real, repo.safety, ask)
      if (!hits) {
        for (const r of ask) out.add(r)
        return out
      }
      const hitKeys = new Set([...hits].map(lower))
      for (const r of ask) {
        const ignored = hitKeys.has(lower(r))
        s.known.set(lower(r), ignored)
        if (ignored) out.add(r)
      }
    }
    return out
  }

  // The project's files changed (its watch), or its folder: what was kept
  // about it is read again.
  function invalidate(path) {
    if (path === undefined) {
      roots.clear()
      ignores.clear()
      return
    }
    const info = roots.get(path)
    roots.delete(path)
    ignores.delete(path)
    if (info) ignores.delete(info.real)
  }

  // Of these paths (from the root: lexical and real alike), the ones a guest
  // may not see. -> Set
  async function hiddenOf(info, rels, settings) {
    const out = new Set()
    const rest = []
    for (const r of rels) {
      if (hiddenByName(r, settings)) out.add(r)
      else rest.push(r)
    }
    if (hidesPrivate(settings) && rest.length) for (const r of await ignoredOf(info, rest)) out.add(r)
    return out
  }

  // A guest's path in the project at `rootPath` -> where it is on disk.
  // mustExist: true (it must be there), false (a file or folder about to be
  // made: its folder must be there) or 'any' (a path git still names, like a
  // file deleted with its folder: the part that is there is checked, the
  // rest by name). kind: 'file' | 'dir' | 'any'.
  // -> { ok: true, rel, realRel, real, entry, parentReal, exists, isDir,
  //      isFile, size, id, rootReal }
  //  | { ok: false, code } ('no-project' | 'bad-path' | 'not-found' |
  //    'not-file')
  // real: the target's real path (null when it does not exist yet); entry:
  // the name itself in its folder's real path (a link stays the link: what a
  // rename or the Recycle Bin acts on).
  async function resolveRel(rootPath, rel, { settings, mustExist = true, kind = 'any' } = {}) {
    const info = root(rootPath)
    if (!info) return { ok: false, code: 'no-project' }
    const segs = relSegments(rel)
    if (!segs) return { ok: false, code: 'bad-path' }
    if (hiddenByName(rel, settings)) return { ok: false, code: 'not-found' }
    const missing = { ok: false, code: 'not-found' }
    // Down from the root, each part as it is on disk; a link only when it
    // lands inside the folder (then followed from where it lands).
    let dir = info.real
    let found = 0
    for (let i = 0; i < segs.length; i++) {
      const next = join(dir, segs[i])
      let l
      try {
        l = fs.lstatSync(next)
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) break
        return missing
      }
      let target = next
      if (l.isSymbolicLink()) {
        try {
          target = fs.realpathSync.native(next)
        } catch {
          return missing // a link to nothing
        }
        if (!within(info.real, target)) return missing
      }
      found = i + 1
      if (i < segs.length - 1) {
        try {
          if (!fs.statSync(target).isDirectory()) return missing
        } catch {
          return missing
        }
        dir = target
      }
    }
    const exists = found === segs.length
    if (!exists && (mustExist === true || (mustExist !== 'any' && found < segs.length - 1))) return missing
    let parentReal = null
    let real = null
    let realRel
    let entry
    try {
      if (!segs.length) {
        real = info.real
        entry = info.real
        realRel = ''
      } else {
        // dir: the entry's folder when it is there, else the deepest folder
        // that is (the rest of the path is missing).
        const dirReal = fs.realpathSync.native(dir)
        if (!within(info.real, dirReal)) return missing
        const tail = exists ? [segs[segs.length - 1]] : segs.slice(found)
        entry = join(dirReal, ...tail)
        parentReal = tail.length > 1 ? join(dirReal, ...tail.slice(0, -1)) : dirReal
        if (exists) {
          real = fs.realpathSync.native(entry)
          if (!within(info.real, real)) return missing
          realRel = relFrom(info.real, real)
        } else {
          const p = relFrom(info.real, dirReal)
          realRel = [p, ...tail].filter(Boolean).join('/')
        }
      }
    } catch {
      return missing
    }
    if (realRel === null || hiddenByName(realRel, settings)) return missing
    if (hidesPrivate(settings) && (await ignoredOf(info, [rel, realRel])).size) return missing
    let id = null
    let isDir = false
    let isFile = false
    let size = 0
    if (exists) {
      try {
        id = fs.statSync(real, { bigint: true })
        isDir = id.isDirectory()
        isFile = id.isFile()
        size = Number(id.size)
      } catch {
        return missing
      }
      if (kind === 'file' && !isFile) return { ok: false, code: isDir ? 'not-file' : 'not-found' }
      if (kind === 'dir' && !isDir) return missing
    }
    return { ok: true, rel, realRel, real, entry, parentReal, exists, isDir, isFile, size, id, rootReal: info.real }
  }

  // A file resolved above, read through one handle: it must still be the
  // same file (dev, inode) and still resolve inside the folder.
  // -> { ok: true, buf, stat } | { ok: false, code } ('not-found' |
  //    'not-file' | 'too-large' | 'failed')
  function readResolved(resolved, maxBytes) {
    if (!resolved || !resolved.ok || !resolved.exists || !resolved.real) return { ok: false, code: 'not-found' }
    let fd
    try {
      fd = fs.openSync(resolved.real, 'r')
    } catch (err) {
      return { ok: false, code: err && err.code === 'ENOENT' ? 'not-found' : 'failed' }
    }
    try {
      const id = fs.fstatSync(fd, { bigint: true })
      if (!sameFile(id, resolved.id)) return { ok: false, code: 'not-found' }
      if (!id.isFile()) return { ok: false, code: 'not-file' }
      let now
      try {
        now = fs.realpathSync.native(resolved.real)
      } catch {
        return { ok: false, code: 'not-found' }
      }
      if (!within(resolved.rootReal, now)) return { ok: false, code: 'not-found' }
      if (id.size > BigInt(maxBytes)) return { ok: false, code: 'too-large' }
      const stat = fs.fstatSync(fd)
      const buf = Buffer.alloc(Number(id.size))
      let n = 0
      while (n < buf.length) {
        const got = fs.readSync(fd, buf, n, buf.length - n, n)
        if (!got) break
        n += got
      }
      return { ok: true, buf: buf.subarray(0, n), stat }
    } catch {
      return { ok: false, code: 'failed' }
    } finally {
      try {
        fs.closeSync(fd)
      } catch {
        // closed
      }
    }
  }

  return { root, resolve: resolveRel, readResolved, hiddenOf, ignoredOf, invalidate }
}

// The repository's top for a folder, or null (not one, no git).
function defaultGitTop(cwd) {
  return new Promise((done) => {
    let child
    let out = ''
    try {
      child = spawn('git', ['-C', cwd, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { windowsHide: true, env: cleanEnv(process.env) })
    } catch {
      return done(null)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone already
      }
    }, IGNORE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s) => {
      if (out.length < 8192) out += s
    })
    child.stderr.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 && out.trim() ? resolve(out.trim()) : null)
    })
  })
}

// --- The last guard on the way out ---------------------------------------------------
const HIDDEN = '…'
const PATH_CHAR = `[^\\s"'<>|*?]`
// A space inside a path: followed by more of it with a separator.
const PATH_SPACE = `[ \\t](?=[^\\s"'<>|*?\\\\/]*[\\\\/])`
const PATH_BODY = `(?:${PATH_CHAR}|${PATH_SPACE})*`
const HOST_PATHS = [
  // C:\..., C:/..., also inside file:///C:/...
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_BODY}`, 'g'),
  // \\server\share\..., \\?\..., \\.\...
  new RegExp(`\\\\\\\\(?:[?.]\\\\)?[^\\s\\\\/"'<>|*?]+${PATH_BODY}`, 'g'),
  // //server/share/... (not an address's //host)
  new RegExp(`(?<![:\\w/])//[^\\s/"'<>|*?]+/${PATH_BODY}`, 'g')
]

// The ways a host folder may be written: as given, with "/", and as Git Bash
// writes it (/c/Users/...); without case.
function needlesOf(paths) {
  const out = new Set()
  for (const p of paths) {
    if (typeof p !== 'string' || p.length < 4) continue
    const base = p.replace(/[\\/]+$/, '')
    for (const v of [base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')]) {
      out.add(v.toLowerCase())
      const m = /^([A-Za-z]):[\\/](.*)$/.exec(v)
      if (m) out.add(`/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.toLowerCase())
    }
  }
  // Longest first: a folder inside another is replaced whole.
  return [...out].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length)
}

function scrub(text, needles, count) {
  let out = text
  for (const n of needles) {
    let low = out.toLowerCase()
    let at = low.indexOf(n)
    while (at >= 0) {
      out = out.slice(0, at) + HIDDEN + out.slice(at + n.length)
      count.hits++
      low = out.toLowerCase()
      at = low.indexOf(n, at + HIDDEN.length)
    }
  }
  for (const re of HOST_PATHS) {
    out = out.replace(re, () => {
      count.hits++
      return HIDDEN
    })
  }
  return out
}

// Every string of an answer (keys too) without the host's folders: the
// roots' paths (as given and real, and any other host folder given with
// them, like a repository's top or the home folder) and any drive, share or
// long path become "…". keep: dotted paths of fields left as they are (a
// file's own text, which the guest may save back: "text", "results.*.text").
// -> { value, hits } (hits: how many were replaced, for the log).
export function assertNoHostPaths(payload, roots, { keep = [] } = {}) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : []
  const needles = needlesOf([...list, os.homedir()])
  const kept = keep.map((k) => k.split('.'))
  const count = { hits: 0 }
  const isKept = (path) => kept.some((k) => k.length === path.length && k.every((part, i) => part === path[i]))
  const walk = (v, path, depth) => {
    if (typeof v === 'string') return scrub(v, needles, count)
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? null : v
    if (depth > 32) return null
    if (Array.isArray(v)) return v.map((x) => walk(x, [...path, '*'], depth + 1))
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      const key = scrub(k, needles, count)
      out[key] = isKept([...path, k]) && typeof x === 'string' ? x : walk(x, [...path, k], depth + 1)
    }
    return out
  }
  return { value: walk(payload, [], 0), hits: count.hits }
}
