// The explorer's Timeline as plain data (after VS Code's timelinePane.ts, its
// git extension's timelineProvider.ts and hover.ts, and its Local History's
// localHistoryTimeline.ts): a file's commits and saved versions merged, their
// relative times (VS Code's fromNow, base/common/date.ts), a commit's hover
// (its author's identicon, its message as simple Markdown). Pure.
import { t, intlLocale } from '../i18n'
import { dateTimeFormat } from '../../../shared/intlCache'

const MINUTE = 60
const HOUR = MINUTE * 60
const DAY = HOUR * 24
const WEEK = DAY * 7
const MONTH = DAY * 30
const YEAR = DAY * 365

// One unit's words: short ("5 mins", the rows), full ("5 minutes", read
// aloud) and full with "ago" ("5 minutes ago", the hover).
function unitText(unit, n, form) {
  const one = n === 1
  const count = { count: n }
  switch (unit) {
    case 'sec':
      if (form === 'ago') return one ? t('explorer.time.secondAgo', '{{count}} second ago', count) : t('explorer.time.secondsAgo', '{{count}} seconds ago', count)
      if (form === 'full') return one ? t('explorer.time.second', '{{count}} second', count) : t('explorer.time.seconds', '{{count}} seconds', count)
      return one ? t('explorer.time.sec', '{{count}} sec', count) : t('explorer.time.secs', '{{count}} secs', count)
    case 'min':
      if (form === 'ago') return one ? t('explorer.time.minuteAgo', '{{count}} minute ago', count) : t('explorer.time.minutesAgo', '{{count}} minutes ago', count)
      if (form === 'full') return one ? t('explorer.time.minute', '{{count}} minute', count) : t('explorer.time.minutes', '{{count}} minutes', count)
      return one ? t('explorer.time.min', '{{count}} min', count) : t('explorer.time.mins', '{{count}} mins', count)
    case 'hr':
      if (form === 'ago') return one ? t('explorer.time.hourAgo', '{{count}} hour ago', count) : t('explorer.time.hoursAgo', '{{count}} hours ago', count)
      if (form === 'full') return one ? t('explorer.time.hour', '{{count}} hour', count) : t('explorer.time.hours', '{{count}} hours', count)
      return one ? t('explorer.time.hr', '{{count}} hr', count) : t('explorer.time.hrs', '{{count}} hrs', count)
    case 'day':
      if (form === 'ago') return one ? t('explorer.time.dayAgo', '{{count}} day ago', count) : t('explorer.time.daysAgo', '{{count}} days ago', count)
      return one ? t('explorer.time.day', '{{count}} day', count) : t('explorer.time.days', '{{count}} days', count)
    case 'wk':
      if (form === 'ago') return one ? t('explorer.time.weekAgo', '{{count}} week ago', count) : t('explorer.time.weeksAgo', '{{count}} weeks ago', count)
      if (form === 'full') return one ? t('explorer.time.week', '{{count}} week', count) : t('explorer.time.weeks', '{{count}} weeks', count)
      return one ? t('explorer.time.wk', '{{count}} wk', count) : t('explorer.time.wks', '{{count}} wks', count)
    case 'mo':
      if (form === 'ago') return one ? t('explorer.time.monthAgo', '{{count}} month ago', count) : t('explorer.time.monthsAgo', '{{count}} months ago', count)
      if (form === 'full') return one ? t('explorer.time.month', '{{count}} month', count) : t('explorer.time.months', '{{count}} months', count)
      return one ? t('explorer.time.mo', '{{count}} mo', count) : t('explorer.time.mos', '{{count}} mos', count)
    default:
      if (form === 'ago') return one ? t('explorer.time.yearAgo', '{{count}} year ago', count) : t('explorer.time.yearsAgo', '{{count}} years ago', count)
      if (form === 'full') return one ? t('explorer.time.year', '{{count}} year', count) : t('explorer.time.years', '{{count}} years', count)
      return one ? t('explorer.time.yr', '{{count}} yr', count) : t('explorer.time.yrs', '{{count}} yrs', count)
  }
}

// VS Code's fromNow(date, appendAgoLabel, useFullTimeWords): "now" under 30
// seconds; then secs, mins, hrs, days, wks, mos (30 days), yrs (365 days).
// The Timeline's rows: fromNow(time) ("5 mins"); its hovers:
// fromNow(time, true, true) ("5 minutes ago").
export function fromNow(time, ago = false, full = false, now = Date.now()) {
  if (!Number.isFinite(time)) return t('explorer.time.unknown', 'unknown')
  const seconds = Math.round((now - time) / 1000)
  // A time to come (a clock behind): "in 5 mins".
  if (seconds < -30) return t('explorer.time.in', 'in {{time}}', { time: fromNow(now + seconds * 1000, false, full, now) })
  if (seconds < 30) return t('explorer.time.now', 'now')
  const form = ago ? 'ago' : full ? 'full' : 'short'
  if (seconds < MINUTE) return unitText('sec', seconds, form)
  if (seconds < HOUR) return unitText('min', Math.round(seconds / MINUTE), form)
  if (seconds < DAY) return unitText('hr', Math.round(seconds / HOUR), form)
  if (seconds < WEEK) return unitText('day', Math.round(seconds / DAY), form)
  if (seconds < MONTH) return unitText('wk', Math.round(seconds / WEEK), form)
  if (seconds < YEAR) return unitText('mo', Math.round(seconds / MONTH), form)
  return unitText('yr', Math.round(seconds / YEAR), form)
}

// "June 15, 2026 at 5:26 PM" in the interface's language (VS Code's hovers:
// year, long month, day, hour and minute).
export function longDate(time, locale = intlLocale()) {
  try {
    return dateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' }).format(new Date(time))
  } catch {
    return new Date(time).toLocaleString()
  }
}

// A Local History version's diff tab: "a.js (File Saved • June 15, 2026 at
// 5:26 PM) ↔ a.js" (VS Code's localHistoryCompareToFileEditorLabel).
export function localDiffLabel(name, time) {
  const date = Number.isFinite(time) ? longDate(time).replace(/[\\/]/g, '-') : ''
  return t('editor.tab.localDiff', '{{name}} ({{source}} • {{date}}) ↔ {{name}}', { name, source: t('explorer.timeline.fileSaved', 'File Saved'), date })
}

// A commit's label: the first line of its message (VS Code's GitTimelineItem).
export function firstLine(message) {
  const s = String(message || '')
  const i = s.indexOf('\n')
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

// The Timeline's entries, newest first: "Uncommitted Changes" (now) when the
// file has changes not committed, the commits that changed it, the versions
// kept at its saves. Each with its relative time, hidden when the same as the
// entry above (VS Code's timeline-timestamp--duplicate).
// -> [{ id, kind: 'uncommitted' | 'commit' | 'local', label, description, time, icon, relative, relativeFull, sameTime, commit? , localId? }]
export function timelineEntries({ commits = [], uncommitted = false, local = [], git = true, history = true, now = Date.now() } = {}) {
  const out = []
  if (git && uncommitted)
    out.push({ id: 'working', kind: 'uncommitted', label: t('explorer.timeline.uncommitted', 'Uncommitted Changes'), description: '', time: now, icon: 'circle-outline' })
  if (git)
    for (const c of commits)
      out.push({ id: 'commit:' + c.id, kind: 'commit', label: firstLine(c.message), description: c.author || '', time: c.time, icon: 'git-commit', commit: c }) // i18n-ignore
  if (history)
    for (const e of local)
      out.push({ id: 'local:' + e.id, kind: 'local', label: t('explorer.timeline.fileSaved', 'File Saved'), description: '', time: e.timestamp, icon: 'circle-outline', localId: e.id }) // i18n-ignore
  // Newest first; the same time keeps the order above (uncommitted, commits, saves).
  const sorted = out.map((e, i) => ({ e, i })).sort((a, b) => b.e.time - a.e.time || a.i - b.i).map((x) => x.e)
  let last
  for (const e of sorted) {
    e.relative = fromNow(e.time, false, false, now)
    e.relativeFull = fromNow(e.time, false, true, now)
    e.sameTime = last !== undefined && e.relative === last
    last = e.relative
  }
  return sorted
}

// --- A commit's hover -----------------------------------------------------------------

// A string's 128-bit hash (cyrb128): four 32-bit numbers, the same for the
// same string everywhere.
export function hash128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

// A GitHub-style identicon made here from the author's email (no network):
// 5 x 5 blocks, the left three columns from the hash and mirrored to the
// right, one colour from the hash. -> { color, cells: 25 booleans, row by row }
export function identicon(seed) {
  const [a, b] = hash128(String(seed || '').trim().toLowerCase())
  const cells = new Array(25).fill(false)
  for (let i = 0; i < 15; i++) {
    const on = ((a >>> i) & 1) === 1
    const col = Math.floor(i / 5) // 0, 1, 2
    const row = i % 5
    cells[row * 5 + col] = on
    cells[row * 5 + (4 - col)] = on
  }
  const hue = b % 360
  const sat = 45 + ((b >>> 9) % 20)
  const light = 50 + ((b >>> 17) % 15)
  return { color: `hsl(${hue}, ${sat}%, ${light}%)`, cells } // i18n-ignore
}

// "1 file changed, 15 insertions(+), 2 deletions(-)" in parts (insertions
// green, deletions red); none for a missing number, as git says it.
export function shortStatParts(stats) {
  if (!stats) return []
  const files = Number(stats.files) || 0
  const ins = Number(stats.insertions) || 0
  const del = Number(stats.deletions) || 0
  const parts = [
    {
      kind: 'files',
      text: files === 1 ? t('explorer.timeline.fileChanged', '{{count}} file changed', { count: files }) : t('explorer.timeline.filesChanged', '{{count}} files changed', { count: files })
    }
  ]
  if (ins)
    parts.push({
      kind: 'insertions',
      text: ins === 1 ? t('explorer.timeline.insertion', '{{count}} insertion(+)', { count: ins }) : t('explorer.timeline.insertions', '{{count}} insertions(+)', { count: ins })
    })
  if (del)
    parts.push({
      kind: 'deletions',
      text: del === 1 ? t('explorer.timeline.deletion', '{{count}} deletion(-)', { count: del }) : t('explorer.timeline.deletions', '{{count}} deletions(-)', { count: del })
    })
  return parts
}

// A line's text in pieces: links (http, https), email addresses, `code`,
// and "#123" (an issue, a link when the repository's page is known).
const INLINE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|`[^`]+`|#\d+\b)/g
export function inlineParts(text, repoUrl = null) {
  const s = String(text || '')
  const out = []
  let at = 0
  for (const m of s.matchAll(INLINE)) {
    const v = m[0]
    if (m.index > at) out.push({ kind: 'text', text: s.slice(at, m.index) })
    if (/^https?:/i.test(v)) out.push({ kind: 'link', text: v, href: v })
    else if (v.startsWith('`')) out.push({ kind: 'code', text: v.slice(1, -1) })
    else if (v.startsWith('#')) out.push(repoUrl ? { kind: 'link', text: v, href: `${repoUrl}/issues/${v.slice(1)}` } : { kind: 'text', text: v }) // i18n-ignore
    else out.push({ kind: 'link', text: v, href: 'mailto:' + v })
    at = m.index + v.length
  }
  if (at < s.length) out.push({ kind: 'text', text: s.slice(at) })
  return out
}

// The commit's message as VS Code's hover shows it (each line its own
// paragraph; "- " or "* " lines a list): -> [{ kind: 'p', parts } | { kind: 'ul', items: [parts] }]
export function messageBlocks(message, repoUrl = null) {
  const blocks = []
  for (const raw of String(message || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const item = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (item) {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ul') last.items.push(inlineParts(item[1], repoUrl))
      else blocks.push({ kind: 'ul', items: [inlineParts(item[1], repoUrl)] })
    } else blocks.push({ kind: 'p', parts: inlineParts(line.trim(), repoUrl) })
  }
  return blocks
}

// The repository's page from a commit's page (https://github.com/o/r/commit/…).
export function repoUrlOf(webUrl) {
  const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/commit\/[0-9a-f]+$/i.exec(String(webUrl || ''))
  return m ? m[1] : null
}

// The repository's top folder from a file and its path in the repository
// (git's "rel", always with /): null when they do not fit.
export function repoTopOf(file, rel) {
  const f = String(file || '')
  const r = String(rel || '')
  if (!f || !r) return null
  const sep = f.startsWith('ssh://') || !f.includes('\\') ? '/' : '\\'
  const tail = sep + r.split('/').join(sep)
  if (f.length <= tail.length || f.slice(-tail.length).toLowerCase() !== tail.toLowerCase()) return null
  return f.slice(0, f.length - tail.length)
}

// A file's folder and name ('C:\\a\\b.js' -> ['C:\\a', 'b.js']; ssh://… too).
export function splitPath(file) {
  const f = String(file || '')
  const i = Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'))
  return i > 0 ? [f.slice(0, i), f.slice(i + 1)] : ['', f]
}
