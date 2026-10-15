// Claude Code usage report, read from its own conversation files on this
// computer (~/.claude/projects/**/*.jsonl; nothing is sent anywhere, no
// sign-in used): tokens and estimated cost by day, model, project and
// conversation. Parsing follows Orca's (github.com/stablyai/orca,
// src/main/claude-usage, MIT): Claude Code writes a reply's usage several
// times, so rows sharing a message id and request id are one turn, keeping
// the largest counts.
// Transcripts only grow, and there can be gigabytes of them: a file is read
// again only from where the last read stopped (whole again when its start
// changed), and the parsed turns are kept in Tessel's data folder, so a
// restart does not read everything again.
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { turnCostUsd, pricingModel } from '../shared/claudePricing'
import {
  usageDayFormatter,
  usageQueryRange,
  usageProjectKey,
  usageRootOf,
  usageScope
} from './usageReportFilters'

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']

// One transcript line -> a turn, or null.
export function parseClaudeLine(line) {
  if (!line || line.indexOf('"usage"') < 0) return null
  let r
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const m = r && r.message
  const u = m && m.usage
  if (!u || r.type !== 'assistant') return null
  const cc = u.cache_creation || {}
  return {
    key: m.id && r.requestId ? `${m.id}:${r.requestId}` : r.uuid || null,
    sessionId: r.sessionId || r.session_id || null,
    time: Date.parse(r.timestamp) || 0,
    model: m.model || null,
    cwd: r.cwd || null,
    branch: r.gitBranch || null,
    sidechain: !!r.isSidechain,
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    cacheWrite1h: n(cc.ephemeral_1h_input_tokens)
  }
}

export function claudeProjectsDir(home = os.homedir(), env = process.env) {
  const base =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()
      ? env.CLAUDE_CONFIG_DIR.trim()
      : join(home, '.claude')
  return join(base, 'projects')
}

function listJsonl(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  // A fixed order: the file that owns a turn copied into another stays the same.
  return out.sort()
}

// --- Reading a transcript ---------------------------------------------------

const CHUNK = 1024 * 1024
const PRINT = 4096 // bytes compared at a file's start and before the read offset
const USAGE = Buffer.from('"usage"')
const PARALLEL = 4
// Day and price of a turn, worked out once (dropped when its counts change).
const derived = new WeakMap()

function merge(turns, key, t) {
  const had = turns.get(key)
  if (!had) return void turns.set(key, t)
  for (const f of COUNTS) if (t[f] > had[f]) had[f] = t[f]
  derived.delete(had)
}

function take(entry, file, buf, start, end, at) {
  const t = parseClaudeLine(buf.toString('utf8', start, end))
  if (!t || !t.model || t.model === '<synthetic>') return
  // A turn without ids is keyed by where its line starts: reading the line
  // again (a last line read before it ended) finds the same turn.
  merge(entry.turns, t.key || `${file}#${at}`, t)
}

// Reads [entry.offset, size) into entry.turns. Complete lines move
// entry.offset; a last line not ended yet is read too, and read again next
// time (the same turn: its largest counts are kept).
async function readTurns(file, entry, size) {
  const handle = await fs.promises.open(file, 'r')
  try {
    let pos = entry.offset
    let parts = [] // a line spanning chunks
    let partsStart = pos
    while (pos < size) {
      const length = Math.min(CHUNK, size - pos)
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buf, 0, length, pos)
      if (bytesRead <= 0) break
      const chunk = buf.subarray(0, bytesRead)
      const chunkStart = pos
      pos += bytesRead
      let lineStart = 0
      let next = -1 // the next '"usage"' in this chunk (Infinity: none left)
      for (;;) {
        const nl = chunk.indexOf(10, lineStart)
        if (nl < 0) break
        if (parts.length) {
          const line = Buffer.concat([...parts, chunk.subarray(0, nl)])
          if (line.indexOf(USAGE) >= 0) take(entry, file, line, 0, line.length, partsStart)
          parts = []
        } else {
          if (next < lineStart) {
            next = chunk.indexOf(USAGE, lineStart)
            if (next < 0) next = Infinity
          }
          if (next < nl) take(entry, file, chunk, lineStart, nl, chunkStart + lineStart)
        }
        lineStart = nl + 1
        entry.offset = chunkStart + lineStart
      }
      if (lineStart < chunk.length) {
        if (!parts.length) partsStart = chunkStart + lineStart
        parts.push(chunk.subarray(lineStart))
      }
    }
    if (parts.length) {
      const line = Buffer.concat(parts)
      if (line.indexOf(USAGE) >= 0) take(entry, file, line, 0, line.length, partsStart)
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function hashRange(file, start, length) {
  const hash = createHash('sha256')
  if (length > 0) {
    const handle = await fs.promises.open(file, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, start)
      hash.update(buf.subarray(0, bytesRead))
    } finally {
      await handle.close().catch(() => {})
    }
  }
  return hash.digest('hex')
}

async function prints(file, entry, size) {
  const headLength = Math.min(PRINT, size)
  const tailStart = Math.max(0, entry.offset - PRINT)
  return {
    head: [headLength, await hashRange(file, 0, headLength)],
    tail: [tailStart, entry.offset - tailStart, await hashRange(file, tailStart, entry.offset - tailStart)]
  }
}

// The file still starts with what was read and only grew: read on from there.
async function onlyGrew(file, c, size) {
  if (size < c.offset || size < c.head[0]) return false
  return (
    (await hashRange(file, 0, c.head[0])) === c.head[1] &&
    (await hashRange(file, c.tail[0], c.tail[1])) === c.tail[2]
  )
}

async function refreshFile(file, st, c) {
  const grew = c ? await onlyGrew(file, c, st.size).catch(() => false) : false
  const entry = grew
    ? { size: st.size, mtimeMs: st.mtimeMs, offset: c.offset, turns: c.turns }
    : { size: st.size, mtimeMs: st.mtimeMs, offset: 0, turns: new Map() }
  await readTurns(file, entry, st.size)
  return { ...entry, ...(await prints(file, entry, st.size)) }
}

// --- The parsed turns on disk -------------------------------------------------

const CACHE_VERSION = 1
const CACHE_LIMIT = 512 * 1024 * 1024
const count = (v) => Number.isSafeInteger(v) && v >= 0
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)

function packEntry(path, e) {
  const strings = []
  const index = new Map()
  const ref = (s) => {
    if (s === null || s === undefined) return -1
    if (!index.has(s)) index.set(s, strings.push(s) - 1)
    return index.get(s)
  }
  const turns = []
  for (const [key, t] of e.turns)
    turns.push([
      key,
      ref(t.sessionId),
      t.time,
      ref(t.model),
      ref(t.cwd),
      ref(t.branch),
      t.sidechain ? 1 : 0,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheWrite,
      t.cacheWrite1h
    ])
  return { path, size: e.size, mtimeMs: e.mtimeMs, offset: e.offset, head: e.head, tail: e.tail, strings, turns }
}

function unpackEntry(raw, dir) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') return null
  const inside = resolve(raw.path).startsWith(resolve(dir) + sep) && raw.path.endsWith('.jsonl')
  if (
    !inside ||
    !count(raw.size) ||
    !(typeof raw.mtimeMs === 'number' && Number.isFinite(raw.mtimeMs)) ||
    !count(raw.offset) ||
    raw.offset > raw.size ||
    !Array.isArray(raw.head) ||
    !(count(raw.head[0]) && raw.head[0] <= raw.size && hex(raw.head[1])) ||
    !Array.isArray(raw.tail) ||
    !(count(raw.tail[0]) && count(raw.tail[1]) && raw.tail[0] + raw.tail[1] === raw.offset && hex(raw.tail[2])) ||
    !Array.isArray(raw.strings) ||
    !raw.strings.every((s) => typeof s === 'string') ||
    !Array.isArray(raw.turns)
  )
    return null
  const str = (i) => (i === -1 ? null : Number.isSafeInteger(i) && i >= 0 && i < raw.strings.length ? raw.strings[i] : undefined)
  const turns = new Map()
  for (const row of raw.turns) {
    if (!Array.isArray(row) || row.length !== 12 || typeof row[0] !== 'string' || !row[0]) return null
    const [key, s, time, m, c, b, side, ...values] = row
    const t = { key, sessionId: str(s), time, model: str(m), cwd: str(c), branch: str(b), sidechain: side === 1 }
    if (
      [t.sessionId, t.model, t.cwd, t.branch].includes(undefined) ||
      !t.model ||
      !(typeof time === 'number' && Number.isFinite(time) && time >= 0) ||
      !values.every(count)
    )
      return null
    COUNTS.forEach((f, i) => (t[f] = values[i]))
    turns.set(key, t)
  }
  return { size: raw.size, mtimeMs: raw.mtimeMs, offset: raw.offset, head: raw.head, tail: raw.tail, turns }
}

function loadCache(cacheFile, dir) {
  const cache = new Map()
  if (!cacheFile) return cache
  try {
    const st = fs.lstatSync(cacheFile)
    if (!st.isFile() || st.size > CACHE_LIMIT) return cache
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (raw?.version !== CACHE_VERSION || raw.dir !== dir || !Array.isArray(raw.files)) return cache
    for (const f of raw.files) {
      const entry = unpackEntry(f, dir)
      if (entry) cache.set(f.path, entry)
    }
  } catch {
    // missing or unreadable: everything is read again
  }
  return cache
}

async function saveCache(cacheFile, dir, cache) {
  const payload = JSON.stringify({
    version: CACHE_VERSION,
    dir,
    files: [...cache].map(([path, e]) => packEntry(path, e))
  })
  if (payload.length > CACHE_LIMIT) return
  // Into Tessel's data folder, never a folder created for it.
  const temporary = join(dirname(cacheFile), `.claude-usage-${randomUUID()}.tmp`)
  try {
    await fs.promises.writeFile(temporary, payload, { flag: 'wx', mode: 0o600 })
    await fs.promises.rename(temporary, cacheFile)
  } catch {
    // not saved this time: the next change tries again
  } finally {
    await fs.promises.unlink(temporary).catch(() => {})
  }
}

// --- The report -------------------------------------------------------------

const empty = () => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
  unpriced: 0,
  zeroCacheReadTurns: 0
})
function add(acc, t, cost) {
  acc.turns++
  acc.input += t.input
  acc.output += t.output
  acc.cacheRead += t.cacheRead
  acc.cacheWrite += t.cacheWrite
  acc.cacheWrite1h += t.cacheWrite1h
  if (t.cacheRead === 0) acc.zeroCacheReadTurns++
  if (cost === null) acc.unpriced++
  else acc.cost += cost
}
const memo = (fn) => {
  const values = new Map()
  return (key) => {
    if (!values.has(key)) values.set(key, fn(key))
    return values.get(key)
  }
}

// A reader that keeps parsed files between calls (a changed file is read on
// from where it stopped) and, with cacheFile, between runs of Tessel.
// Filtering never changes deduplication ownership.
export function createClaudeUsageReport({
  dir = claudeProjectsDir(),
  days = 30,
  now = Date.now,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  cacheFile = null,
  saveDelay = 3000
} = {}) {
  let cache = null // file -> { size, mtimeMs, offset, head, tail, turns }
  let dirty = false
  let timer = null
  let saving = Promise.resolve()
  let queue = Promise.resolve()
  const dayOf = usageDayFormatter(timezone)
  const modelOf = memo((model) => pricingModel(model) || model)

  function save() {
    clearTimeout(timer)
    timer = null
    if (!cacheFile || !dirty || !cache) return saving
    dirty = false
    const snapshot = new Map(cache)
    saving = saving.then(() => saveCache(cacheFile, dir, snapshot))
    return saving
  }
  function schedule() {
    if (!cacheFile || timer) return
    timer = setTimeout(save, saveDelay)
    timer.unref?.()
  }

  async function scan() {
    cache ??= loadCache(cacheFile, dir)
    const files = listJsonl(dir)
    const seen = new Set(files)
    for (const f of [...cache.keys()])
      if (!seen.has(f)) {
        cache.delete(f)
        dirty = true
      }
    const changed = []
    for (const f of files) {
      let st
      try {
        st = fs.statSync(f)
      } catch {
        continue
      }
      const c = cache.get(f)
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) changed.push([f, st, c])
    }
    let next = 0
    const worker = async () => {
      while (next < changed.length) {
        const [f, st, c] = changed[next++]
        try {
          cache.set(f, await refreshFile(f, st, c))
          dirty = true
        } catch {
          // unreadable right now: its last reading (if any) is kept
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, changed.length) }, worker))
    if (dirty) schedule()
    return files
  }

  async function build(query) {
    const time = now()
    // Reject malformed renderer filters before touching any log file.
    const range = usageQueryRange(query, dayOf(time), days)
    const files = await scan()
    // One turn once across files (a resumed or forked conversation copies
    // earlier turns into its new file): the first file, in path order, owns
    // it, with the largest counts of its copies (a copy can stop mid-reply).
    const all = new Map()
    for (const f of files) {
      const entry = cache.get(f)
      if (!entry) continue
      for (const [k, t] of entry.turns) {
        const had = all.get(k)
        if (!had) all.set(k, t)
        else if (COUNTS.some((c) => t[c] > had[c])) {
          const fuller = { ...had }
          for (const c of COUNTS) fuller[c] = Math.max(had[c], t[c])
          all.set(k, fuller)
        }
      }
    }
    const projectKey = memo(usageProjectKey)
    const rootOf = memo((cwd) => usageRootOf(cwd, range.roots))
    const wantedCwd = range.cwd ? projectKey(range.cwd) : ''

    const totals = empty()
    const allTotals = empty()
    const allSessions = new Set()
    const byDay = new Map()
    const byModel = new Map()
    const byProject = new Map()
    const bySession = new Map()
    for (const t of all.values()) {
      let d = derived.get(t)
      if (!d || d.timezone !== timezone)
        derived.set(t, (d = { timezone, day: dayOf(t.time), cost: turnCostUsd(t.model, t) }))
      const { day, cost } = d
      add(allTotals, t, cost)
      if (t.sessionId) allSessions.add(t.sessionId)
      const model = modelOf(t.model)
      const root = range.roots ? rootOf(t.cwd) : null
      if (
        (range.from && day < range.from) ||
        (range.to && day > range.to) ||
        (wantedCwd && projectKey(t.cwd) !== wantedCwd) ||
        (range.model && t.model !== range.model && model !== range.model) ||
        (range.roots && !root)
      )
        continue
      add(totals, t, cost)
      if (!byDay.has(day)) byDay.set(day, { day, ...empty() })
      add(byDay.get(day), t, cost)
      if (!byModel.has(model)) byModel.set(model, { model, ...empty(), sessions: new Set() })
      add(byModel.get(model), t, cost)
      if (t.sessionId) byModel.get(model).sessions.add(t.sessionId)
      // Scoped to Tessel's projects: a project's sub-folders and worktrees
      // inside it count as that project.
      const project = root || t.cwd || '(unknown folder)'
      const key = projectKey(project)
      if (!byProject.has(key))
        byProject.set(key, {
          cwd: project,
          label: project.split(/[\\/]/).filter(Boolean).at(-1) || project,
          ...empty(),
          sessions: new Set()
        })
      add(byProject.get(key), t, cost)
      if (t.sessionId) byProject.get(key).sessions.add(t.sessionId)
      if (t.sessionId) {
        if (!bySession.has(t.sessionId))
          bySession.set(t.sessionId, {
            id: t.sessionId,
            cwd: t.cwd,
            branch: t.branch,
            model,
            first: t.time,
            last: t.time,
            ...empty()
          })
        const s = bySession.get(t.sessionId)
        add(s, t, cost)
        s.first = Math.min(s.first, t.time)
        if (t.time >= s.last)
          Object.assign(s, {
            last: t.time,
            model,
            cwd: t.cwd || s.cwd,
            branch: t.branch || s.branch
          })
      }
    }
    const byCost = (a, b) => b.cost - a.cost
    const withSessionCount = ({ sessions, ...entry }) => ({ ...entry, sessions: sessions.size })
    return {
      ok: true,
      source: 'claude-local',
      provider: 'claude',
      generatedAt: new Date(time).toISOString(),
      timezone,
      range: { from: range.from, to: range.to },
      scope: usageScope(range),
      days:
        range.from && range.to
          ? Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1
          : null,
      files: files.length,
      totals: { ...totals, sessions: bySession.size },
      lastDays: { ...totals, sessions: bySession.size },
      allTotals: { ...allTotals, sessions: allSessions.size },
      byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      byModel: [...byModel.values()].map(withSessionCount).sort(byCost),
      byProject: [...byProject.values()].map(withSessionCount).sort(byCost),
      sessions: [...bySession.values()].sort((a, b) => b.last - a.last || a.id.localeCompare(b.id))
    }
  }

  // One scan at a time: the Overview and a provider pane asking together
  // read each changed file once.
  function report(query = {}) {
    const run = queue.then(() => build(query))
    queue = run.catch(() => {})
    return run
  }
  // Writes the parsed turns now (tests, quitting).
  report.flush = () => queue.then(save)
  return report
}
