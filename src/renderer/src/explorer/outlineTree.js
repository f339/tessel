// The explorer's Outline as plain data (after VS Code's outlinePane.ts and
// documentSymbolsTree.ts): a file's symbols keyed, sorted, filtered and laid
// out as rows. Pure: ExplorerOutline.vue draws them.
import { t } from '../i18n'

export const OUTLINE_SORTS = ['position', 'name', 'kind']

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true }) : null
const compareNames = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0)
const startOf = (r) => (r ? [r.startLineNumber || 0, r.startColumn || 0, r.endLineNumber || 0, r.endColumn || 0] : [0, 0, 0, 0])
// VS Code's Range.compareRangesUsingStarts.
export function compareRanges(a, b) {
  const x = startOf(a)
  const y = startOf(b)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

// Each symbol gets a key that stays the same while the file is edited (its
// parents' keys, its kind and name; a number for twins), so what is folded
// or selected stays so after the symbols are read again.
export function keyed(symbols, parent = '') {
  const seen = new Map()
  return (Array.isArray(symbols) ? symbols : []).map((s) => {
    const base = `${s.kind}:${s.name}` // i18n-ignore
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    const key = `${parent}/${base}${n ? '#' + n : ''}` // i18n-ignore
    return { ...s, key, children: keyed(s.children, key) }
  })
}

// VS Code's DocumentSymbolComparator: by position (range start, then name),
// by name (then position), or by category (kind, then name).
export function sortSymbols(symbols, by = 'position') {
  const cmp =
    by === 'name'
      ? (a, b) => compareNames(a.name, b.name) || compareRanges(a.range, b.range)
      : by === 'kind'
        ? (a, b) => a.kind - b.kind || compareNames(a.name, b.name)
        : (a, b) => compareRanges(a.range, b.range) || compareNames(a.name, b.name)
  const walk = (list) => list.map((s) => ({ ...s, children: walk(s.children || []) })).sort(cmp)
  return walk(Array.isArray(symbols) ? symbols : [])
}

const inside = (r, line, column) =>
  !!r &&
  (line > r.startLineNumber || (line === r.startLineNumber && column >= r.startColumn)) &&
  (line < r.endLineNumber || (line === r.endLineNumber && column <= r.endColumn))

// Follow Cursor: the symbols containing the cursor, outermost first (the
// last one is the deepest: the one selected). [] when it is in none.
export function symbolPathAt(symbols, line, column) {
  const path = []
  let list = Array.isArray(symbols) ? symbols : []
  for (let guard = 0; guard < 200 && list.length; guard++) {
    let hit = null
    for (const s of list) if (inside(s.range, line, column) && (!hit || compareRanges(hit.range, s.range) < 0)) hit = s
    if (!hit) break
    path.push(hit.key)
    list = hit.children || []
  }
  return path
}

// The keys of every symbol that has children (Collapse All folds them all).
export function parentKeys(symbols, out = []) {
  for (const s of Array.isArray(symbols) ? symbols : []) {
    if (s.children && s.children.length) {
      out.push(s.key)
      parentKeys(s.children, out)
    }
  }
  return out
}

// VS Code's "all collapsed" (its Expand All button instead of Collapse All):
// every top level symbol that can fold is folded.
export function allCollapsed(symbols, collapsed) {
  return (Array.isArray(symbols) ? symbols : []).every((s) => !(s.children && s.children.length) || collapsed.has(s.key))
}

// Filter on Type: the letters typed, in order, in the name (a run of them
// when there is one): -> [[start, end)…] to highlight, or null.
export function matchName(name, query) {
  const q = String(query || '').toLowerCase()
  if (!q) return []
  const n = String(name || '').toLowerCase()
  const at = n.indexOf(q)
  if (at >= 0) return [[at, at + q.length]]
  const out = []
  let i = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const j = n.indexOf(ch, i)
    if (j < 0) return null
    if (out.length && out[out.length - 1][1] === j) out[out.length - 1][1] = j + 1
    else out.push([j, j + 1])
    i = j + 1
  }
  return out
}

// The rows shown: depth first, a folded symbol's children hidden. With a
// filter: only the symbols that match and their parents (unfolded), unless
// highlight is true (VS Code's find in highlight mode: every row stays,
// the matches lit).
// -> [{ key, symbol, depth, parent, hasChildren, open, matches, dim }]
export function outlineRows(symbols, { collapsed = new Set(), query = '', highlight = false } = {}) {
  const rows = []
  const filtering = !!String(query || '').trim()
  // A symbol or one of its children matches (kept while filtering).
  const keep = new Map()
  const scan = (list) => {
    let any = false
    for (const s of list) {
      const m = filtering ? matchName(s.name, query) : []
      const child = scan(s.children || [])
      const k = !filtering || !!m || child
      keep.set(s.key, { matches: m, kept: k })
      if (k) any = true
    }
    return any
  }
  scan(Array.isArray(symbols) ? symbols : [])
  const walk = (list, depth, parent) => {
    for (const s of list) {
      const info = keep.get(s.key) || { matches: [], kept: true }
      if (filtering && !highlight && !info.kept) continue
      const kids = s.children || []
      const hasChildren = kids.length > 0
      // While filtering, the parents of a match unfold to show it.
      const open = hasChildren && (filtering && !highlight ? true : !collapsed.has(s.key))
      rows.push({ key: s.key, symbol: s, depth, parent, hasChildren, open, matches: info.matches || [] })
      if (open) walk(kids, depth + 1, s.key)
    }
  }
  walk(Array.isArray(symbols) ? symbols : [], 0, null)
  return rows
}

// The name cut in pieces, the matched ones marked (drawn in bold, VS Code's
// list.highlightForeground).
export function highlightParts(name, matches) {
  const s = String(name || '')
  if (!matches || !matches.length) return [{ text: s, hit: false }]
  const out = []
  let at = 0
  for (const [a, b] of matches) {
    if (a > at) out.push({ text: s.slice(at, a), hit: false })
    out.push({ text: s.slice(a, b), hit: true })
    at = b
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false })
  return out
}

// VS Code's symbolKindNames (a row's title: "name (kind)").
export function symbolKindName(kind) {
  switch (kind) {
    case 0: return t('explorer.outline.kind.file', 'file')
    case 1: return t('explorer.outline.kind.module', 'module')
    case 2: return t('explorer.outline.kind.namespace', 'namespace')
    case 3: return t('explorer.outline.kind.package', 'package')
    case 4: return t('explorer.outline.kind.class', 'class')
    case 5: return t('explorer.outline.kind.method', 'method')
    case 6: return t('explorer.outline.kind.property', 'property')
    case 7: return t('explorer.outline.kind.field', 'field')
    case 8: return t('explorer.outline.kind.constructor', 'constructor')
    case 9: return t('explorer.outline.kind.enum', 'enumeration')
    case 10: return t('explorer.outline.kind.interface', 'interface')
    case 11: return t('explorer.outline.kind.function', 'function')
    case 12: return t('explorer.outline.kind.variable', 'variable')
    case 13: return t('explorer.outline.kind.constant', 'constant')
    case 14: return t('explorer.outline.kind.string', 'string')
    case 15: return t('explorer.outline.kind.number', 'number')
    case 16: return t('explorer.outline.kind.boolean', 'boolean')
    case 17: return t('explorer.outline.kind.array', 'array')
    case 18: return t('explorer.outline.kind.object', 'object')
    case 19: return t('explorer.outline.kind.key', 'key')
    case 20: return t('explorer.outline.kind.null', 'null')
    case 21: return t('explorer.outline.kind.enumMember', 'enumeration member')
    case 22: return t('explorer.outline.kind.struct', 'struct')
    case 23: return t('explorer.outline.kind.event', 'event')
    case 24: return t('explorer.outline.kind.operator', 'operator')
    case 25: return t('explorer.outline.kind.typeParameter', 'type parameter')
    default: return t('explorer.outline.kind.property', 'property')
  }
}
