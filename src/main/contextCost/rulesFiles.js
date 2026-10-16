// The rules and memory files each agent reads at the start of every session
// (Settings > Context): the user's own (all projects) and the project's.
//   Claude Code  <config>/CLAUDE.md and <config>/rules/*.md; CLAUDE.md,
//                CLAUDE.local.md and .claude/CLAUDE.md in the project folder
//                and every folder above it; .claude/rules/*.md; the files
//                they import (@path, 5 levels); its auto memory (MEMORY.md,
//                the first 200 lines). A rule with `paths:` loads only for
//                those files: listed, not counted.
//   Codex        $CODEX_HOME/AGENTS.override.md or AGENTS.md; the same in each
//                folder from the git root down to the project folder, 32 KiB
//                in all (Codex's project_doc_max_bytes).
//   Gemini CLI   ~/.gemini/GEMINI.md; GEMINI.md from the project folder up to
//                its git root. Qwen Code: the same with ~/.qwen and QWEN.md.
//   Antigravity  ~/.gemini/GEMINI.md; the project's .agent/rules/*.md,
//                GEMINI.md and AGENTS.md.
//   OpenCode     ~/.config/opencode/AGENTS.md (else ~/.claude/CLAUDE.md);
//                AGENTS.md (else CLAUDE.md) up to the git root.
//   Copilot CLI  ~/.copilot/copilot-instructions.md; the project's
//                .github/copilot-instructions.md, AGENTS.md, CLAUDE.md and
//                GEMINI.md.
//   Cursor CLI   .cursorrules, .cursor/rules/*.mdc (alwaysApply ones; the
//                others load when relevant), AGENTS.md, CLAUDE.md.
//   Kimi Code    the project's AGENTS.md.
//   Cline        ~/Documents/Cline/Rules/*.md; the project's .clinerules
//                (a file, or a folder of .md files).
// Tessel's own block in a memory file (agentMemory.js, the task board rule)
// is counted apart, as Tessel's. Files are read here, in the main process,
// 256 KB at most each, 100 files and 2 MB in all per summary (READ_BUDGET),
// and read again only when their size or date changed (a bounded memo).
// Their text goes to the counter (counts.js) and nowhere else.
//
// A Claude "@path" import is followed only when it stays inside the project
// (the project folder, or its git root when that is close above it),
// Claude's config folder or ~/.claude, names a text file outside .git, and
// is no credentials file; a network, UNC or device path (\\host\share,
// //host, \\.\pipe\x) is never even looked at (a stat would reach that
// server or pipe), and neither is a link that leads to one. The others are
// listed as not followed, never read. One summary looks at IMPORT_LIMIT
// imports at most; the rest is one "N more not followed" line.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RULE_START, RULE_END } from '../agentMemory'
import { chatPathProblem } from '../../shared/chatFileLinks'

export const RULE_AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'qwen', 'opencode', 'copilot', 'cursor', 'kimi', 'cline']
export const MAX_FILE_BYTES = 256 * 1024
// What one summary reads at most (all agents together).
export const READ_BUDGET = Object.freeze({ files: 100, bytes: 2 * 1024 * 1024 })
// The imports one summary looks at (followed, refused or missing): a file
// with thousands of "@path" lines is one line of the list past these.
export const IMPORT_LIMIT = 200
const MEMO_FILES = 200
const MEMO_BYTES = 4 * 1024 * 1024
// The files an import may name: text.
const IMPORT_EXTENSIONS = new Set(['', '.md', '.markdown', '.mdc', '.txt', '.rst'])
// Links followed one after the other at most (a loop ends here).
const MAX_LINK_HOPS = 8
// How far above the project folder its git root may be and still be where
// its imports may lead.
const MAX_GIT_DEPTH = 3
const MAX_UP = 12
const MAX_DIR_FILES = 50
const CODEX_PROJECT_BYTES = 32 * 1024
const MEMORY_LINES = 200

// Claude Code's folder name for a project: every other character than a
// letter or digit becomes "-" (C:\Tessel -> C--Tessel).
export const claudeProjectSlug = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, '-')

// The folders from `from` up to `stop` (included) or the root, nearest first.
export function foldersUp(from, stop = null, max = MAX_UP) {
  const out = []
  let dir = path.resolve(from)
  const end = stop ? path.resolve(stop).toLowerCase() : null
  for (let i = 0; i < max; i++) {
    out.push(dir)
    if (end && dir.toLowerCase() === end) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

// Where an agent's rules may be. -> [{ path, scope, dir?, ext?, pick?, budget?, lines?, imports?, fallback? }]
//   dir: every <ext> file in that folder; pick: the first of these paths
//   that exists; budget: bytes for the whole group (Codex); lines: only the
//   first N; imports: follow @path imports (Claude); fallback: used only when
//   the agent's main user file is missing (OpenCode).
export function rulesCandidates(agent, { home = os.homedir(), env = process.env, cwd = null, gitRoot = null, claudeDir = null } = {}) {
  const out = []
  const user = (p, extra = {}) => out.push({ path: p, scope: 'user', ...extra })
  const project = (p, extra = {}) => out.push({ path: p, scope: 'project', ...extra })
  const hasProject = typeof cwd === 'string' && path.isAbsolute(cwd)
  const root = hasProject ? gitRoot || cwd : null
  const upToRoot = hasProject ? foldersUp(cwd, gitRoot || cwd) : []
  switch (agent) {
    case 'claude': {
      const config = claudeDir || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
      user(path.join(config, 'CLAUDE.md'), { imports: true })
      user(path.join(config, 'rules'), { dir: true, ext: ['.md'], imports: true })
      if (hasProject) {
        for (const d of foldersUp(cwd)) {
          project(path.join(d, 'CLAUDE.md'), { imports: true })
          project(path.join(d, 'CLAUDE.local.md'), { imports: true })
          project(path.join(d, '.claude', 'CLAUDE.md'), { imports: true })
        }
        project(path.join(root, '.claude', 'rules'), { dir: true, ext: ['.md'], imports: true })
        const memory = (d) => path.join(config, 'projects', claudeProjectSlug(d), 'memory', 'MEMORY.md')
        project(memory(cwd), { lines: MEMORY_LINES, memory: true, pick: gitRoot && gitRoot !== cwd ? [memory(cwd), memory(gitRoot)] : null })
      }
      break
    }
    case 'codex': {
      const codexHome = env.CODEX_HOME || path.join(home, '.codex')
      user(null, { pick: [path.join(codexHome, 'AGENTS.override.md'), path.join(codexHome, 'AGENTS.md')] })
      if (hasProject)
        for (const d of [...upToRoot].reverse())
          project(null, { pick: [path.join(d, 'AGENTS.override.md'), path.join(d, 'AGENTS.md')], budget: 'codex' })
      break
    }
    case 'gemini':
    case 'qwen': {
      const [dot, name] = agent === 'gemini' ? ['.gemini', 'GEMINI.md'] : ['.qwen', 'QWEN.md']
      user(path.join(home, dot, name))
      for (const d of upToRoot) project(path.join(d, name))
      break
    }
    case 'antigravity':
      user(path.join(home, '.gemini', 'GEMINI.md'))
      if (hasProject) {
        project(path.join(root, '.agent', 'rules'), { dir: true, ext: ['.md'] })
        project(path.join(root, 'GEMINI.md'))
        project(path.join(root, 'AGENTS.md'))
      }
      break
    case 'opencode': {
      const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
      user(null, { pick: [path.join(config, 'opencode', 'AGENTS.md'), path.join(home, '.claude', 'CLAUDE.md')] })
      for (const d of upToRoot) project(null, { pick: [path.join(d, 'AGENTS.md'), path.join(d, 'CLAUDE.md')] })
      break
    }
    case 'copilot':
      user(path.join(home, '.copilot', 'copilot-instructions.md'))
      if (hasProject) for (const name of [path.join('.github', 'copilot-instructions.md'), 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) project(path.join(root, name))
      break
    case 'cursor':
      if (hasProject) {
        project(path.join(root, '.cursorrules'))
        project(path.join(root, '.cursor', 'rules'), { dir: true, ext: ['.mdc', '.md'], cursor: true })
        project(path.join(root, 'AGENTS.md'))
        project(path.join(root, 'CLAUDE.md'))
      }
      break
    case 'kimi':
      if (hasProject) project(path.join(root, 'AGENTS.md'))
      break
    case 'cline':
      user(path.join(home, 'Documents', 'Cline', 'Rules'), { dir: true, ext: ['.md', '.txt'] })
      if (hasProject) {
        project(path.join(root, '.clinerules'), { either: true, ext: ['.md', '.txt'] })
      }
      break
    default:
      break
  }
  return out
}

// Credentials and keys, never read even where an agent would: SSH, cloud
// and package-manager credentials, key files, Claude's and Codex's own
// sign-ins (.credentials.json, auth.json), .env files.
const SENSITIVE_DIR = /^(?:\.(?:ssh|aws|gnupg|kube|azure|docker)|gcloud)$/i
const SENSITIVE_FILE = /^(?:\.credentials\.json|auth\.json|\.claude\.json|credentials(?:\.json)?|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|id_[a-z0-9_-]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx|ppk|asc|gpg))$/i
export function isSensitivePath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.some((part) => SENSITIVE_DIR.test(part)) || SENSITIVE_FILE.test(parts[parts.length - 1] || '')
}

const sameFolded = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
export function isInside(root, file) {
  if (!root || !file) return false
  const rel = path.relative(sameFolded(root), sameFolded(file))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

// The folder a project's imports may lead to: the project folder, or its git
// root when the project is at most MAX_GIT_DEPTH folders below it and that
// root holds neither the home folder nor a whole drive (a dotfiles
// repository in the home folder would open all of it).
export function importRoot(cwd, gitRoot, home = os.homedir()) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  const project = path.resolve(cwd)
  if (typeof gitRoot !== 'string' || !path.isAbsolute(gitRoot) || !isInside(gitRoot, project)) return project
  const git = path.resolve(gitRoot)
  const depth = path.relative(sameFolded(git), sameFolded(project)).split(/[\\/]/).filter(Boolean).length
  if (depth > MAX_GIT_DEPTH || path.dirname(git) === git || (home && isInside(git, home))) return project
  return git
}

// A path with a link to the network or a device on the way (\\host\share,
// \\?\, \??\, a device name): never followed.
const isNetworkText = (p) => /^[\\/]{2}/.test(String(p)) || /^\\\?\?\\/.test(String(p))
const hasGitPart = (p) => String(p || '').split(/[\\/]/).some((part) => part.toLowerCase() === '.git')

// Why an import is not followed, or null. Checked on the text before the
// disk is touched: 'network' (UNC, //host, \\?\, \\.\, a device name),
// 'outside' (not in an allowed folder), 'skipped' (not text, a credentials
// file, a program, anything in .git, an odd path).
export function importProblem(raw, target, roots) {
  if (isNetworkText(raw) || isNetworkText(target || '')) return 'network'
  const problem = chatPathProblem(target || '')
  if (problem === 'network') return 'network'
  if (problem) return 'skipped'
  if (isSensitivePath(target) || hasGitPart(target)) return 'skipped'
  if (!IMPORT_EXTENSIONS.has(path.extname(target).toLowerCase())) return 'skipped'
  if (!roots.some((root) => isInside(root, target))) return 'outside'
  return null
}

// The same on the import's real path (its links followed): a link named
// notes.md may lead to a program, a credentials file or .git/config.
function realImportProblem(real) {
  if (chatPathProblem(real) || isSensitivePath(real) || hasGitPart(real)) return 'skipped'
  return IMPORT_EXTENSIONS.has(path.extname(real).toLowerCase()) ? null : 'skipped'
}

// Each link on the way to a path, read (lstat, readlink) before anything
// follows it: a stat, realpath or open through a link to \\host\share or
// \\.\pipe\x would reach that server or pipe, so such a link is never
// followed, nor one Tessel cannot read. -> { problem, path }: problem null
// (path: the file with its links replaced by their targets), 'network',
// 'skipped' or 'missing'. cache: the steps already walked (one summary's).
export async function walkLinks(file, { fsApi = fs, cache = new Map(), hops = 0 } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { problem: 'skipped', path: null }
  if (isNetworkText(file) || chatPathProblem(file) === 'network') return { problem: 'network', path: null }
  const full = path.resolve(file)
  const { root } = path.parse(full)
  async function step(next, parent) {
    if (chatPathProblem(next) === 'network') return { problem: 'network', path: null } // a device name on the way
    let stat
    try {
      stat = await fsApi.lstat(next)
    } catch {
      return { problem: 'missing', path: null }
    }
    if (!stat.isSymbolicLink()) return { problem: null, path: next }
    let target
    try {
      target = await fsApi.readlink(next)
    } catch {
      return { problem: 'skipped', path: null }
    }
    if (isNetworkText(target)) return { problem: 'network', path: null }
    if (hops >= MAX_LINK_HOPS) return { problem: 'skipped', path: null }
    // The target's own links are checked the same way.
    return walkLinks(path.resolve(parent, target), { fsApi, cache, hops: hops + 1 })
  }
  let cur = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    const next = path.join(cur, part)
    const k = sameFolded(next)
    let done = cache.get(k)
    if (!done) {
      done = await step(next, cur)
      cache.set(k, done)
    }
    if (done.problem) return done
    cur = done.path
  }
  return { problem: null, path: cur }
}

// A file's text, read again only when its size or date changed. The memo
// keeps the most recent MEMO_FILES files, MEMO_BYTES of text at most.
export function createFileReader({ fsApi = fs, maxBytes = MAX_FILE_BYTES, memoFiles = MEMO_FILES, memoBytes = MEMO_BYTES } = {}) {
  const memo = new Map() // path -> { mtimeMs, size, text, truncated }, oldest first
  let memoTotal = 0
  const drop = (file) => {
    const old = memo.get(file)
    if (!old) return
    memoTotal -= old.text.length
    memo.delete(file)
  }
  function keep(file, entry) {
    drop(file)
    memo.set(file, entry)
    memoTotal += entry.text.length
    while (memo.size > memoFiles || memoTotal > memoBytes) drop(memo.keys().next().value)
  }
  // Why a path is not looked at: a link on the way leads to the network or a
  // device ('network'), cannot be read ('skipped'), or it is 'missing'.
  const linkProblem = async (file, cache = new Map()) => (await walkLinks(file, { fsApi, cache })).problem
  const safe = async (file, cache) => !(await linkProblem(file, cache))
  // cache (here and below): the links already checked, one summary's.
  async function read(file, cache = new Map()) {
    // Never a network or device path (a stat would reach it), nor a link to one.
    if (chatPathProblem(file) === 'network') return null
    if (!(await safe(file, cache))) {
      drop(file)
      return null
    }
    let stat
    try {
      stat = await fsApi.stat(file)
    } catch {
      drop(file)
      return null
    }
    if (!stat.isFile()) return null
    const seen = memo.get(file)
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) {
      keep(file, seen) // the most recent again
      return seen
    }
    let text
    let truncated
    try {
      const handle = await fsApi.open(file, 'r')
      try {
        const want = Math.min(stat.size, maxBytes)
        const buffer = Buffer.alloc(want)
        const { bytesRead } = await handle.read(buffer, 0, want, 0)
        text = buffer.subarray(0, bytesRead).toString('utf8')
        truncated = stat.size > maxBytes
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, text, truncated }
    keep(file, entry)
    return entry
  }
  // The file's real path (links followed, once checked), or null.
  async function real(file, cache = new Map()) {
    if (!(await safe(file, cache))) return null
    try {
      return await fsApi.realpath(file)
    } catch {
      return null
    }
  }
  async function list(dir, exts, cache = new Map()) {
    if (!(await safe(dir, cache))) return []
    try {
      const entries = await fsApi.readdir(dir, { withFileTypes: true })
      return entries
        .filter((e) => e.isFile() && exts.some((x) => e.name.toLowerCase().endsWith(x)))
        .map((e) => path.join(dir, e.name))
        .sort()
        .slice(0, MAX_DIR_FILES)
    } catch {
      return []
    }
  }
  async function isDir(p, cache = new Map()) {
    if (!(await safe(p, cache))) return false
    try {
      return (await fsApi.stat(p)).isDirectory()
    } catch {
      return false
    }
  }
  return { read, real, list, isDir, linkProblem, forget: drop, clear: () => (memo.clear(), (memoTotal = 0)), memoSize: () => ({ files: memo.size, bytes: memoTotal }) }
}

// The git root above a folder (a .git folder or file), or null. lstat: a
// .git that is a link is not followed (it may lead to a network share).
export async function findGitRoot(cwd, fsApi = fs) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  for (const d of foldersUp(cwd, null, 24)) {
    try {
      await fsApi.lstat(path.join(d, '.git'))
      return d
    } catch {
      // not here
    }
  }
  return null
}

// Tessel's task board block, apart from the user's text.
export function splitTesselBlock(text) {
  const a = text.indexOf(RULE_START)
  const b = text.indexOf(RULE_END)
  if (a < 0 || b < a) return { own: text, tessel: '' }
  return { own: (text.slice(0, a) + text.slice(b + RULE_END.length)).trim() ? text.slice(0, a) + text.slice(b + RULE_END.length) : '', tessel: text.slice(a, b + RULE_END.length) }
}

// The "@path" imports of a Claude memory file as written, outside code, one
// at a time (a file may hold thousands: readRules stops resolving them at
// its limit and only counts the rest).
export function* importTexts(text) {
  let fenced = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const plain = line.replace(/`[^`]*`/g, ' ')
    for (const m of plain.matchAll(/(?:^|\s)@((?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])?[\w.\-\\/]+)/g)) {
      const raw = m[1]
      if (!/[\\/]|\.\w+$/.test(raw)) continue // "@someone" in a sentence
      yield raw
    }
  }
}

// Where an import leads: relative to the file, from home (~/), or absolute.
// -> { raw, path }; a network path is kept as written (path: null), never
// resolved.
export function importTarget(raw, file, home = os.homedir()) {
  if (/^[\\/]{2}/.test(raw)) return { raw, path: null }
  const target = raw.startsWith('~') ? path.join(home, raw.slice(2)) : path.isAbsolute(raw) ? raw : path.resolve(path.dirname(file), raw)
  return { raw, path: path.normalize(target) }
}

// -> [{ raw, path }], every import of the text.
export function claudeImports(text, file, home = os.homedir()) {
  return Array.from(importTexts(text), (raw) => importTarget(raw, file, home))
}

// Frontmatter switches: Claude's `paths:` (a conditional rule) and Cursor's
// `alwaysApply: true`.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  const body = m ? m[1] : ''
  return { paths: /^paths\s*:/m.test(body), alwaysApply: /^alwaysApply\s*:\s*true\b/m.test(body), hasFrontmatter: !!m }
}

// What one summary may still read: { files, bytes, imports } left, shared by
// every agent of the summary (readRules' opts.budget), with the links it
// already checked.
export const readBudget = () => ({ ...READ_BUDGET, imports: IMPORT_LIMIT, seen: new Set(), links: new Map() })

// -> [{ id, path, scope, text, loaded, note, tessel?, count? }] for one
// agent: the files that exist, in the order the agent reads them. note:
// 'memory' (first 200 lines), 'truncated' (cut to a size limit), 'onDemand'
// (loaded only when relevant), 'import' (imported by another file),
// 'outside' (an import outside the project, not followed), 'skipped' (an
// import not followed: not text, a credentials file, a network path),
// 'limit' (not read: the summary's limit was reached), 'more' (the imports
// past IMPORT_LIMIT, not looked at: count, no path). The ones not read have
// no text.
export async function readRules(agent, opts = {}, reader = createFileReader()) {
  const home = opts.home || os.homedir()
  const env = opts.env || process.env
  const gitRoot = opts.gitRoot !== undefined ? opts.gitRoot : await findGitRoot(opts.cwd)
  const budget = opts.budget || readBudget()
  if (!Number.isFinite(budget.imports)) budget.imports = IMPORT_LIMIT
  if (!(budget.links instanceof Map)) budget.links = new Map()
  const links = budget.links
  const out = []
  const seen = new Set()
  const key = (p) => path.resolve(p).toLowerCase()
  // Where an import may lead: the project, Claude's config folder, ~/.claude;
  // each also by its real path (a project opened through a junction, a
  // ~/.claude behind one), read once, when the first import comes.
  const folders = [importRoot(opts.cwd, gitRoot, home), opts.claudeDir || env.CLAUDE_CONFIG_DIR || null, path.join(home, '.claude')].filter(Boolean)
  let roots = null
  const importRoots = () =>
    (roots ||= Promise.all(folders.map((f) => reader.real(f, links))).then((reals) => [...new Set([...folders, ...reals.filter(Boolean)])]))
  const notRead = (id, file, scope, note) => out.push({ id, path: file, scope, text: '', loaded: false, note })
  let codexBudget = CODEX_PROJECT_BYTES
  let more = 0 // imports past the summary's limit
  // -> true when the file exists (read or not).
  async function add(file, cand, note = null, depth = 0) {
    if (!file || seen.has(key(file))) return false
    // Kept even when missing: each path is looked up once.
    seen.add(key(file))
    const id = `${agent}:${key(file)}`
    const isImport = note === 'import'
    // An import is looked up only while the summary may still read, and a
    // missing one costs a file too (thousands of them would each be a
    // lookup).
    if (isImport && !budget.seen.has(key(file)) && (budget.files <= 0 || budget.bytes <= 0)) return !!notRead(id, file, cand.scope, 'limit')
    // An import through a link to the network or a device: listed, not followed.
    const linked = isImport ? await reader.linkProblem(file, links) : null
    if (linked === 'network' || linked === 'skipped') return !!notRead(id, file, cand.scope, linked === 'network' ? 'outside' : 'skipped')
    const real = linked ? null : await reader.real(file, links)
    if (!real) {
      if (isImport) budget.files -= 1
      return false
    }
    if (isImport) {
      const problem = realImportProblem(real)
      if (problem) return !!notRead(id, file, cand.scope, problem)
      // A link out of the allowed folders is an import outside too.
      if (!(await importRoots()).some((root) => isInside(root, real))) return !!notRead(id, file, cand.scope, 'outside')
    } else if (isSensitivePath(real)) return true
    const counted = budget.seen.has(key(real))
    if (!counted && (budget.files <= 0 || budget.bytes <= 0)) return !!notRead(id, file, cand.scope, 'limit')
    const entry = await reader.read(file, links)
    if (!entry) return true
    if (!counted) {
      budget.seen.add(key(real))
      budget.seen.add(key(file)) // also as written: the next agent's import of it costs nothing
      budget.files -= 1
      budget.bytes -= entry.text.length
    }
    let text = entry.text
    let finalNote = note || (entry.truncated ? 'truncated' : null)
    let loaded = true
    if (cand.lines) {
      const lines = text.split(/\r?\n/)
      if (lines.length > cand.lines) {
        text = lines.slice(0, cand.lines).join('\n')
        finalNote = 'memory'
      } else finalNote = finalNote || 'memory'
    }
    if (cand.budget === 'codex') {
      const bytes = Buffer.byteLength(text)
      if (bytes > codexBudget) {
        text = Buffer.from(text).subarray(0, Math.max(0, codexBudget)).toString('utf8')
        finalNote = 'truncated'
      }
      codexBudget = Math.max(0, codexBudget - bytes)
    }
    if (cand.cursor) {
      const fm = frontmatter(text)
      if (file.toLowerCase().endsWith('.mdc') && !fm.alwaysApply) {
        loaded = false
        finalNote = 'onDemand'
      }
    } else if (cand.imports && cand.dir && frontmatter(text).paths) {
      loaded = false
      finalNote = 'onDemand'
    }
    const { own, tessel } = splitTesselBlock(text)
    out.push({ id: `${agent}:${key(file)}`, path: file, scope: cand.scope, text: own, loaded, note: finalNote })
    if (tessel) out.push({ id: `${agent}:${key(file)}#tessel`, path: file, scope: cand.scope, text: tessel, loaded: true, note: null, tessel: true })
    if (cand.imports && depth < 5) {
      for (const raw of importTexts(own)) {
        // Past the summary's limit: counted, not even resolved.
        if (budget.imports <= 0) {
          more++
          continue
        }
        const imp = importTarget(raw, file, home)
        const shown = imp.path || imp.raw
        if (seen.has(key(shown))) continue
        budget.imports -= 1
        const problem = importProblem(imp.raw, imp.path, await importRoots())
        if (problem) {
          seen.add(key(shown))
          notRead(`${agent}:${key(shown)}`, shown, cand.scope, problem === 'network' ? 'outside' : problem)
        } else await add(imp.path, { ...cand, dir: false }, 'import', depth + 1)
      }
    }
    return true
  }
  for (const cand of rulesCandidates(agent, { ...opts, home, gitRoot })) {
    if (cand.pick) {
      for (const p of cand.pick) if (await add(p, cand)) break
    } else if (cand.dir) {
      for (const f of await reader.list(cand.path, cand.ext, links)) await add(f, cand)
    } else if (cand.either) {
      if (await reader.isDir(cand.path, links)) for (const f of await reader.list(cand.path, cand.ext, links)) await add(f, cand)
      else await add(cand.path, cand)
    } else await add(cand.path, cand)
  }
  if (more) out.push({ id: `${agent}:more`, path: '', scope: null, text: '', loaded: false, note: 'more', count: more })
  return out
}
