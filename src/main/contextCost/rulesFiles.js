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
// (its git root), Claude's config folder or ~/.claude, names a text file, and
// is no credentials file; a network, UNC or device path (\\host\share,
// //host, \\.\pipe\x) is never even looked at (a stat would reach that
// server or pipe). The others are listed as not followed, never read.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RULE_START, RULE_END } from '../agentMemory'
import { chatPathProblem } from '../../shared/chatFileLinks'

export const RULE_AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'qwen', 'opencode', 'copilot', 'cursor', 'kimi', 'cline']
export const MAX_FILE_BYTES = 256 * 1024
// What one summary reads at most (all agents together).
export const READ_BUDGET = Object.freeze({ files: 100, bytes: 2 * 1024 * 1024 })
const MEMO_FILES = 200
const MEMO_BYTES = 4 * 1024 * 1024
// The files an import may name: text.
const IMPORT_EXTENSIONS = new Set(['', '.md', '.markdown', '.mdc', '.txt', '.rst'])
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

// Why an import is not followed, or null. Checked on the text before the
// disk is touched: 'network' (UNC, //host, \\?\, \\.\, a device name),
// 'outside' (not in an allowed folder), 'skipped' (not text, a credentials
// file, a program, an odd path).
export function importProblem(raw, target, roots) {
  if (/^[\\/]{2}/.test(String(raw)) || /^[\\/]{2}/.test(String(target || ''))) return 'network'
  const problem = chatPathProblem(target || '')
  if (problem === 'network') return 'network'
  if (problem) return 'skipped'
  if (isSensitivePath(target)) return 'skipped'
  if (!IMPORT_EXTENSIONS.has(path.extname(target).toLowerCase())) return 'skipped'
  if (!roots.some((root) => isInside(root, target))) return 'outside'
  return null
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
  async function read(file) {
    // Never a network or device path (a stat would reach it).
    if (chatPathProblem(file) === 'network') return null
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
  // The file's real path (links followed), or null.
  async function real(file) {
    try {
      return await fsApi.realpath(file)
    } catch {
      return null
    }
  }
  async function list(dir, exts) {
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
  async function isDir(p) {
    try {
      return (await fsApi.stat(p)).isDirectory()
    } catch {
      return false
    }
  }
  return { read, real, list, isDir, forget: drop, clear: () => (memo.clear(), (memoTotal = 0)), memoSize: () => ({ files: memo.size, bytes: memoTotal }) }
}

// The git root above a folder (a .git folder or file), or null.
export async function findGitRoot(cwd, fsApi = fs) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  for (const d of foldersUp(cwd, null, 24)) {
    try {
      await fsApi.stat(path.join(d, '.git'))
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

// "@path" imports of a Claude memory file, outside code: relative to the
// file, from home (~/), or absolute. -> [{ raw, path }]; a network path is
// kept as written (path: null), never resolved.
export function claudeImports(text, file, home = os.homedir()) {
  const out = []
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
      if (/^[\\/]{2}/.test(raw)) {
        out.push({ raw, path: null })
        continue
      }
      const target = raw.startsWith('~') ? path.join(home, raw.slice(2)) : path.isAbsolute(raw) ? raw : path.resolve(path.dirname(file), raw)
      out.push({ raw, path: path.normalize(target) })
    }
  }
  return out
}

// Frontmatter switches: Claude's `paths:` (a conditional rule) and Cursor's
// `alwaysApply: true`.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  const body = m ? m[1] : ''
  return { paths: /^paths\s*:/m.test(body), alwaysApply: /^alwaysApply\s*:\s*true\b/m.test(body), hasFrontmatter: !!m }
}

// What one summary may still read: { files, bytes } left, shared by every
// agent of the summary (readRules' opts.budget).
export const readBudget = () => ({ ...READ_BUDGET, seen: new Set() })

// -> [{ id, path, scope, text, loaded, note, tessel? }] for one agent: the
// files that exist, in the order the agent reads them. note: 'memory'
// (first 200 lines), 'truncated' (cut to a size limit), 'onDemand' (loaded
// only when relevant), 'import' (imported by another file), 'outside' (an
// import outside the project, not followed), 'skipped' (an import not
// followed: not text, a credentials file, a network path), 'limit' (not read:
// the summary's limit was reached). The ones not read have no text.
export async function readRules(agent, opts = {}, reader = createFileReader()) {
  const home = opts.home || os.homedir()
  const env = opts.env || process.env
  const gitRoot = opts.gitRoot !== undefined ? opts.gitRoot : await findGitRoot(opts.cwd)
  const budget = opts.budget || readBudget()
  const out = []
  const seen = new Set()
  const key = (p) => path.resolve(p).toLowerCase()
  // Where an import may lead: the project, Claude's config folder, ~/.claude.
  const projectRoot = typeof opts.cwd === 'string' && path.isAbsolute(opts.cwd) ? gitRoot || opts.cwd : null
  const importRoots = [projectRoot, opts.claudeDir || env.CLAUDE_CONFIG_DIR || null, path.join(home, '.claude')].filter(Boolean)
  const notRead = (id, file, scope, note) => out.push({ id, path: file, scope, text: '', loaded: false, note })
  let codexBudget = CODEX_PROJECT_BYTES
  // -> true when the file exists (read or not).
  async function add(file, cand, note = null, depth = 0) {
    if (!file || seen.has(key(file))) return false
    const real = await reader.real(file)
    if (!real) return false
    seen.add(key(file))
    if (isSensitivePath(real)) return true
    // A link out of the allowed folders is an import outside too.
    if (note === 'import' && !importRoots.some((root) => isInside(root, real))) return !!notRead(`${agent}:${key(file)}`, file, cand.scope, 'outside')
    const counted = budget.seen.has(key(real))
    if (!counted && (budget.files <= 0 || budget.bytes <= 0)) return !!notRead(`${agent}:${key(file)}`, file, cand.scope, 'limit')
    const entry = await reader.read(file)
    if (!entry) return true
    if (!counted) {
      budget.seen.add(key(real))
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
      for (const imp of claudeImports(own, file, home)) {
        const problem = importProblem(imp.raw, imp.path, importRoots)
        if (problem) {
          const shown = imp.path || imp.raw
          if (!seen.has(key(shown))) {
            seen.add(key(shown))
            notRead(`${agent}:${key(shown)}`, shown, cand.scope, problem === 'network' ? 'outside' : problem)
          }
        } else await add(imp.path, { ...cand, dir: false }, 'import', depth + 1)
      }
    }
    return true
  }
  for (const cand of rulesCandidates(agent, { ...opts, home, gitRoot })) {
    if (cand.pick) {
      for (const p of cand.pick) if (await add(p, cand)) break
    } else if (cand.dir) {
      for (const f of await reader.list(cand.path, cand.ext)) await add(f, cand)
    } else if (cand.either) {
      if (await reader.isDir(cand.path)) for (const f of await reader.list(cand.path, cand.ext)) await add(f, cand)
      else await add(cand.path, cand)
    } else await add(cand.path, cand)
  }
  return out
}
