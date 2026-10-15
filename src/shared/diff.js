// Pure helpers for the review screen: read git's output about a task branch
// (changed files, commits, conflicts, a file's diff) into plain data. No git,
// no DOM, so the main process and the tests share them.
import { english } from './i18nText'

// `git diff --name-status --no-renames` + `git diff --numstat --no-renames`
// (+ `git diff --raw --no-abbrev` for each file's content id)
// -> [{ path, status: 'A'|'M'|'D', added, removed, binary, blob }], sorted by path.
export function parseChangedFiles(nameStatus, numstat, raw = '') {
  const byPath = new Map()
  for (const line of String(nameStatus || '').split(/\r?\n/)) {
    const m = /^([AMDTUX])\t(.+)$/.exec(line)
    if (!m) continue
    byPath.set(m[2], { path: m[2], status: m[1] === 'T' ? 'M' : m[1], added: 0, removed: 0, binary: false })
  }
  for (const line of String(numstat || '').split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const f = byPath.get(m[3]) || { path: m[3], status: 'M', added: 0, removed: 0, binary: false }
    if (m[1] === '-') f.binary = true
    else {
      f.added = Number(m[1])
      f.removed = Number(m[2])
    }
    byPath.set(m[3], f)
  }
  // `:100644 100644 <old> <new> M<tab>path`: the new content's id (the old
  // one for a deleted file), so a new commit to a file is noticed even when
  // its line counts stay the same.
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/.exec(line)
    const f = m && byPath.get(m[4])
    if (f) f.blob = m[3] === 'D' ? m[1] : m[2]
  }
  for (const f of byPath.values()) if (!f.blob) f.blob = ''
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// Commits listed with --format=%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e
// -> [{ sha, author, time (ms), subject, body }], newest first.
export function parseCommits(text) {
  return String(text || '')
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, author, ct, subject, body] = rec.split('\x1f')
      return {
        sha: (sha || '').trim(),
        author: author || '',
        time: Number(ct) * 1000 || 0,
        subject: subject || '',
        body: (body || '').trim()
      }
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha))
}

// `git merge-tree --write-tree --name-only --no-messages A B`: the first line
// is the resulting tree; with conflicts, the conflicted files follow.
export function parseMergeTree(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    if (!out.includes(line)) out.push(line)
  }
  return out
}

// `git status --porcelain=v1` -> the paths it lists (renames: the new path).
export function parseStatusPaths(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow !== -1) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    out.push(p)
  }
  return out
}

// A unified diff of one file -> { binary, hunks: [{ header, lines }] } where
// each line is { kind: 'add'|'del'|'ctx'|'note', text, old, new } with the
// old/new line numbers ('' where the side has no line).
export function parseUnifiedDiff(text) {
  const src = String(text || '')
  const result = { binary: /^Binary files .* differ$/m.test(src), hunks: [] }
  let hunk = null
  let oldNo = 0
  let newNo = 0
  for (const line of src.split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), old: '', new: newNo++ })
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: '' })
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ })
    else if (line.startsWith('\\')) hunk.lines.push({ kind: 'note', text: line.slice(1).trim(), old: '', new: '' })
  }
  return result
}

// Two texts compared without git (a skill's versions) -> the same shape as
// parseUnifiedDiff, plus the lines added and removed. The common start and
// end are set aside first; the middle is compared line by line (longest
// common subsequence) when small enough, else shown as replaced whole.
// maxLines: the lines kept in the hunks (truncated: true beyond).
export function diffTexts(oldText, newText, { context = 3, maxCells = 1_000_000, maxLines = 5000 } = {}) {
  const split = (s) => {
    const text = String(s == null ? '' : s)
    if (!text) return []
    const lines = text.split(/\r?\n/)
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  const a = split(oldText)
  const b = split(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  // Every line in order: { kind, text, old, new } (1-based numbers).
  const ops = []
  for (let i = 0; i < start; i++) ops.push({ kind: 'ctx', text: a[i], old: i + 1, new: i + 1 })
  const n = endA - start
  const m = endB - start
  if (n * m <= maxCells) {
    const width = m + 1
    const dp = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * width + j] = a[start + i] === b[start + j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ kind: 'ctx', text: a[start + i], old: start + i + 1, new: start + j + 1 })
        i++
        j++
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        ops.push({ kind: 'del', text: a[start + i], old: start + i + 1, new: '' })
        i++
      } else {
        ops.push({ kind: 'add', text: b[start + j], old: '', new: start + j + 1 })
        j++
      }
    }
    for (; i < n; i++) ops.push({ kind: 'del', text: a[start + i], old: start + i + 1, new: '' })
    for (; j < m; j++) ops.push({ kind: 'add', text: b[start + j], old: '', new: start + j + 1 })
  } else {
    for (let i = start; i < endA; i++) ops.push({ kind: 'del', text: a[i], old: i + 1, new: '' })
    for (let j = start; j < endB; j++) ops.push({ kind: 'add', text: b[j], old: '', new: j + 1 })
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: 'ctx', text: a[i], old: i + 1, new: j + 1 })

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'add') added++
    else if (op.kind === 'del') removed++
  }
  // Hunks: each change with `context` lines around it, close ones merged.
  const hunks = []
  let kept = 0
  let truncated = false
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === 'ctx') {
      i++
      continue
    }
    const from = Math.max(0, i - context)
    let to = i
    let last = i
    while (to < ops.length && to - last <= context * 2) {
      if (ops[to].kind !== 'ctx') last = to
      to++
    }
    const end = Math.min(ops.length, last + context + 1)
    let lines = ops.slice(from, end)
    // Past the lines allowed: this hunk cut short, and no other.
    if (kept + lines.length > maxLines) {
      truncated = true
      lines = lines.slice(0, Math.max(0, maxLines - kept))
      if (!lines.length) break
    }
    kept += lines.length
    const oldLines = lines.filter((l) => l.old !== '')
    const newLines = lines.filter((l) => l.new !== '')
    const before = (key) => {
      for (let k = from - 1; k >= 0; k--) if (ops[k][key] !== '') return ops[k][key]
      return 0
    }
    const oldStart = oldLines.length ? oldLines[0].old : before('old')
    const newStart = newLines.length ? newLines[0].new : before('new')
    hunks.push({ header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`, lines }) // i18n-ignore diff header
    if (truncated) break
    i = end
  }
  return { binary: false, hunks, added, removed, truncated }
}

// Can the task branch be merged now? -> the reason it cannot ('' when it
// can), for the Merge button. t: the main process's t() (review.js; English
// without it).
export function mergeBlocker(info, t = english) {
  if (!info || !info.ok) return (info && info.error) || t('main.review.readBranch', 'Could not read the branch.')
  if (info.uncommitted && info.uncommitted.length) {
    const count = info.uncommitted.length
    return count > 1
      ? t('main.review.uncommitted', "{{count}} files are not committed in the agent's copy.", { count })
      : t('main.review.uncommitted', "{{count}} file is not committed in the agent's copy.", { count })
  }
  if (!info.files || !info.files.length) return t('main.review.noChanges', 'The branch has no changes to merge.')
  if (info.rootBranch !== info.target)
    return t('main.review.rootOnBranch', 'The project folder is on branch {{branch}}, not {{target}}.', {
      branch: info.rootBranch || t('main.review.noBranch', '(none)'),
      target: info.target
    })
  if (info.conflicts && info.conflicts.length) return t('main.review.conflictsWith', 'Conflicts with {{target}}.', { target: info.target })
  if (info.dirtyOverlap && info.dirtyOverlap.length)
    return t('main.review.dirtyOverlap', 'Unsaved changes in the project folder touch the same files: {{files}}.', {
      files: info.dirtyOverlap.join(', ')
    })
  return ''
}
