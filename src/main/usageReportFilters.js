// Local calendar and project filters shared by the local usage reports.
// These compare recorded metadata only: no directory traversal or auth reads.
import os from 'os'
import { join, posix, win32 } from 'path'
import { worktreeBaseDir } from '../shared/worktreeNaming'
import { t } from './i18n'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const windowsPath = (value) =>
  /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)

export function usageProjectKey(value) {
  if (typeof value !== 'string' || !value) return ''
  const windows = windowsPath(value)
  const normalized = (windows ? win32 : posix).normalize(value)
  const key = windows ? normalized.replace(/\\/g, '/').toLowerCase() : normalized
  return key.replace(/\/+$/, '') || '/'
}

function absolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\x00-\x1f]/.test(value) &&
    (windowsPath(value) || value.startsWith('/'))
  )
}

const insideKey = (key, prefix) => key === prefix || key.startsWith(prefix === '/' ? '/' : `${prefix}/`)

// cwd -> the Tessel project it counts under (a project's folder, its
// worktrees, its copies' folder all count as the project), or null when it
// is outside the scope. The deepest root holding cwd decides. Root keys are
// worked out once per query and each folder once: reports call it per turn.
// Unscoped (no roots): null, and nothing is grouped.
export function usageRootMatcher(range) {
  if (!range || range.roots === undefined) return null
  const roots = range.roots
    .map((root) => ({ key: usageProjectKey(root), project: range.projectOf?.get(usageProjectKey(root)) || root }))
    .sort((a, b) => b.key.length - a.key.length)
  const seen = new Map()
  return (cwd) => {
    if (seen.has(cwd)) return seen.get(cwd)
    let project = null
    if (absolutePath(cwd)) {
      const key = usageProjectKey(cwd)
      project = roots.find((root) => insideKey(key, root.key))?.project ?? null
    }
    seen.set(cwd, project)
    return project
  }
}

export function usageDayFormatter(timezone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  return (value) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(value)).map((p) => [p.type, p.value])
    )
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
}

// A root is a folder (its own project), or { path, project, main } for a
// folder that counts under a project: one of its worktrees or task copies
// (main: the repository's own checkout).
function rootEntry(value) {
  if (absolutePath(value)) return { path: value, project: value, main: false }
  if (
    object(value) &&
    absolutePath(value.path) &&
    (value.project === undefined || absolutePath(value.project)) &&
    (value.main === undefined || typeof value.main === 'boolean')
  )
    return { path: value.path, project: value.project || value.path, main: value.main === true }
  return null
}

function expandHome(dir) {
  if (dir === '~') return os.homedir()
  if (/^~[\\/]/.test(dir)) return join(os.homedir(), dir.slice(2))
  return dir
}

// Where Tessel puts a project's task copies (Settings > General, Workspace
// Directory; by default <parent>/<project>.worktrees, outside the project).
function copiesFolder(root, workspaceDir) {
  try {
    const base = worktreeBaseDir(root, expandHome(workspaceDir), windowsPath(root) ? win32 : posix)
    return absolutePath(base) ? base : null
  } catch {
    return null
  }
}

export function usageQueryRange(query, today, days = 30) {
  if (!object(query)) throw new Error(t('main.usage.filtersObject', 'Usage filters must be an object.'))
  const start = new Date(`${today}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - days + 1)
  const from = query.from === undefined ? start.toISOString().slice(0, 10) : query.from
  const to = query.to === undefined ? today : query.to
  if (
    (from !== null && !validDay(from)) ||
    (to !== null && !validDay(to)) ||
    (from && to && from > to)
  )
    throw new Error(t('main.usage.dateRange', 'Use an inclusive local date range (YYYY-MM-DD).'))
  for (const key of ['cwd', 'model'])
    if (query[key] != null && typeof query[key] !== 'string')
      throw new Error(t('main.usage.filtersText', 'Project and model filters must be text.'))
  const entries = Array.isArray(query.roots) && query.roots.length <= 4096 ? query.roots.map(rootEntry) : null
  if (query.roots !== undefined && (!entries || entries.includes(null)))
    throw new Error(t('main.usage.rootsAbsolute', 'Project roots must be an array of absolute paths.'))
  const range = { from, to, cwd: query.cwd || '', model: query.model || '' }
  if (!entries) return range
  // A project's folder and its repository's checkout each have a copies
  // folder: what was done in a copy merged and removed since still counts.
  const workspaceDir =
    typeof query.workspaceDir === 'string' && query.workspaceDir.length <= 1000 && !/[\x00-\x1f]/.test(query.workspaceDir)
      ? query.workspaceDir.trim()
      : ''
  const projectOf = new Map()
  const roots = []
  const put = (path, project) => {
    const key = usageProjectKey(path)
    if (projectOf.has(key)) return
    projectOf.set(key, project)
    roots.push(path)
  }
  for (const e of entries) put(e.path, e.project)
  for (const e of entries)
    if (e.main || usageProjectKey(e.project) === usageProjectKey(e.path)) {
      const copies = copiesFolder(e.path, workspaceDir)
      if (copies) put(copies, e.project)
    }
  return { ...range, roots, projectOf }
}

export function usageScope(range) {
  return range.roots === undefined ? 'all' : 'tessel-worktrees'
}
