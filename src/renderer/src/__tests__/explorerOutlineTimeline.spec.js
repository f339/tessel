import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { keyed, sortSymbols, symbolPathAt, outlineRows, matchName, allCollapsed, parentKeys, highlightParts } from '../explorer/outlineTree'
import {
  fromNow,
  timelineEntries,
  identicon,
  hash128,
  messageBlocks,
  inlineParts,
  shortStatParts,
  repoTopOf,
  repoUrlOf,
  firstLine,
  localDiffLabel
} from '../explorer/timeline'
import { symbolIcon } from '../editor/symbolKinds'
import { diffTabPath } from '../editor/editorTabs'
import { paneHeight } from '../explorer/paneResize'
import { settings } from '../settings'
import { setActiveEditor, noteCursor, clearActiveEditor, activeEditor } from '../editor/activeEditor'
import { keepSavedVersion, localHistoryState } from '../editor/localHistory'

// The Outline reads symbols through loadMonaco's outlineIfLoaded (Monaco is
// not loaded in tests): a fake outline service.
const fakeOutline = { symbols: null, canGive: true, documentSymbols: vi.fn(), canGiveSymbols: vi.fn(), onSymbolProvidersChanged: vi.fn(() => () => {}) }
vi.mock('../editor/loadMonaco', () => ({
  outlineIfLoaded: () => fakeOutline,
  loadMonaco: () => Promise.resolve(null),
  monacoIfLoaded: () => null,
  textmateIfLoaded: () => null
}))

import ExplorerOutline from '../components/ExplorerOutline.vue'
import ExplorerTimeline from '../components/ExplorerTimeline.vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'

const R = (sl, sc, el, ec) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec })
// class Zoo (1-20) { constructor (2-4), feed (5-9) { x (6) }, age (10) }, function alpha (22-30), const beta (31)
function symbols() {
  return [
    {
      name: 'Zoo',
      detail: '',
      kind: 4,
      deprecated: false,
      range: R(1, 1, 20, 2),
      selectionRange: R(1, 7, 1, 10),
      children: [
        { name: 'constructor', detail: '', kind: 8, deprecated: false, range: R(2, 3, 4, 4), selectionRange: R(2, 3, 2, 14), children: [] },
        {
          name: 'feed',
          detail: '(food)',
          kind: 5,
          deprecated: true,
          range: R(5, 3, 9, 4),
          selectionRange: R(5, 3, 5, 7),
          children: [{ name: 'x', detail: '', kind: 12, deprecated: false, range: R(6, 5, 6, 20), selectionRange: R(6, 11, 6, 12), children: [] }]
        },
        { name: 'age', detail: '', kind: 6, deprecated: false, range: R(10, 3, 10, 12), selectionRange: R(10, 3, 10, 6), children: [] }
      ]
    },
    { name: 'alpha', detail: '', kind: 11, deprecated: false, range: R(22, 1, 30, 2), selectionRange: R(22, 10, 22, 15), children: [] },
    { name: 'beta', detail: '', kind: 13, deprecated: false, range: R(31, 1, 31, 20), selectionRange: R(31, 7, 31, 11), children: [] }
  ]
}
const names = (list) => list.map((s) => s.name)

describe('Outline helpers (VS Code outline)', () => {
  it('sorts by position, by name and by category, children too', () => {
    const k = keyed(symbols())
    expect(names(sortSymbols(k, 'position'))).toEqual(['Zoo', 'alpha', 'beta'])
    expect(names(sortSymbols(k, 'name'))).toEqual(['alpha', 'beta', 'Zoo'])
    // Category: SymbolKind order (class 4 < function 11 < constant 13).
    expect(names(sortSymbols(k, 'kind'))).toEqual(['Zoo', 'alpha', 'beta'])
    expect(names(sortSymbols(k, 'name')[2].children)).toEqual(['age', 'constructor', 'feed'])
    expect(names(sortSymbols(k, 'kind')[0].children)).toEqual(['feed', 'age', 'constructor']) // method 5, property 6, constructor 8
  })

  it('keys stay the same after the symbols are read again; twins get a number', () => {
    const a = keyed(symbols())
    const b = keyed(symbols())
    expect(a[0].children[1].key).toBe(b[0].children[1].key)
    const twins = keyed([
      { name: 'f', kind: 11, children: [] },
      { name: 'f', kind: 11, children: [] }
    ])
    expect(twins[0].key).not.toBe(twins[1].key)
  })

  it('Follow Cursor: the deepest symbol containing the cursor', () => {
    const k = keyed(symbols())
    const path = symbolPathAt(k, 6, 12)
    expect(path).toHaveLength(3)
    expect(path[2]).toBe(k[0].children[1].children[0].key)
    expect(symbolPathAt(k, 21, 1)).toEqual([]) // between symbols
    expect(symbolPathAt(k, 31, 5)).toEqual([k[2].key])
  })

  it('rows: folded symbols hide their children; Collapse All / Expand All', () => {
    const k = sortSymbols(keyed(symbols()))
    expect(outlineRows(k).map((r) => [r.symbol.name, r.depth])).toEqual([
      ['Zoo', 0],
      ['constructor', 1],
      ['feed', 1],
      ['x', 2],
      ['age', 1],
      ['alpha', 0],
      ['beta', 0]
    ])
    const all = new Set(parentKeys(k))
    expect(all.size).toBe(2)
    expect(allCollapsed(k, all)).toBe(true)
    expect(allCollapsed(k, new Set())).toBe(false)
    expect(names(outlineRows(k, { collapsed: all }).map((r) => r.symbol))).toEqual(['Zoo', 'alpha', 'beta'])
  })

  it('Filter on Type keeps the matches and their parents (unfolded); highlight mode keeps every row', () => {
    const k = sortSymbols(keyed(symbols()))
    const folded = new Set(parentKeys(k))
    const rows = outlineRows(k, { collapsed: folded, query: 'x' })
    expect(rows.map((r) => r.symbol.name)).toEqual(['Zoo', 'feed', 'x'])
    expect(rows[2].matches).toEqual([[0, 1]])
    const lit = outlineRows(k, { query: 'al', highlight: true })
    expect(lit).toHaveLength(7)
    expect(lit.find((r) => r.symbol.name === 'alpha').matches).toEqual([[0, 2]])
  })

  it('matches: a run of letters first, else the letters in order', () => {
    expect(matchName('constructor', 'struct')).toEqual([[3, 9]])
    expect(matchName('constructor', 'cns')).toEqual([[0, 1], [2, 4]])
    expect(matchName('alpha', 'z')).toBeNull()
    expect(highlightParts('alpha', [[0, 2]])).toEqual([
      { text: 'al', hit: true },
      { text: 'pha', hit: false }
    ])
  })

  it("symbols' icons and VS Code's dark colours", () => {
    expect(symbolIcon(4)).toEqual({ name: 'symbol-class', color: '#EE9D28' })
    expect(symbolIcon(11)).toEqual({ name: 'symbol-function', color: '#B180D7' })
    expect(symbolIcon(12)).toEqual({ name: 'symbol-variable', color: '#75BEFF' })
    expect(symbolIcon(13)).toEqual({ name: 'symbol-constant', color: null })
    expect(symbolIcon(99).name).toBe('symbol-property')
  })
})

describe('Timeline helpers (VS Code timeline)', () => {
  const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)
  const ago = (s) => NOW - s * 1000
  it("relative times like VS Code's fromNow", () => {
    expect(fromNow(ago(10), false, false, NOW)).toBe('now')
    expect(fromNow(ago(45), false, false, NOW)).toBe('45 secs')
    expect(fromNow(ago(60), false, false, NOW)).toBe('1 min')
    expect(fromNow(ago(5 * 60), false, false, NOW)).toBe('5 mins')
    expect(fromNow(ago(3600), false, false, NOW)).toBe('1 hr')
    expect(fromNow(ago(3 * 86400), false, false, NOW)).toBe('3 days')
    expect(fromNow(ago(14 * 86400), false, false, NOW)).toBe('2 wks')
    expect(fromNow(ago(92 * 86400), false, false, NOW)).toBe('3 mos')
    expect(fromNow(ago(400 * 86400), false, false, NOW)).toBe('1 yr')
    // The hover: full words and "ago".
    expect(fromNow(ago(92 * 86400), true, true, NOW)).toBe('3 months ago')
    expect(fromNow(ago(60), true, true, NOW)).toBe('1 minute ago')
    expect(fromNow(ago(2 * 3600), false, true, NOW)).toBe('2 hours')
    expect(fromNow(NOW + 5 * 60000, false, false, NOW)).toBe('in 5 mins')
  })

  it('merges uncommitted changes, commits and saves, newest first; the same time shown once', () => {
    const commits = [
      { id: 'a'.repeat(40), author: 'Ada', email: 'ada@x.org', time: ago(3600), message: 'Fix the parser\n\nLong text' },
      { id: 'b'.repeat(40), author: 'Bob', email: 'bob@x.org', time: ago(10 * 86400), message: 'First' }
    ]
    const local = [
      { id: 'abc123', source: 'save', timestamp: ago(3500) },
      { id: 'abc456', source: 'save', timestamp: ago(5 * 86400) }
    ]
    const list = timelineEntries({ commits, uncommitted: true, local, now: NOW })
    expect(list.map((e) => [e.kind, e.label, e.description, e.relative])).toEqual([
      ['uncommitted', 'Uncommitted Changes', '', 'now'],
      ['local', 'File Saved', '', '58 mins'],
      ['commit', 'Fix the parser', 'Ada', '1 hr'],
      ['local', 'File Saved', '', '5 days'],
      ['commit', 'First', 'Bob', '1 wk']
    ])
    expect(list.map((e) => e.icon)).toEqual(['circle-outline', 'circle-outline', 'git-commit', 'circle-outline', 'git-commit'])
    const same = timelineEntries({ commits: [commits[0], { ...commits[1], time: ago(3601) }], now: NOW })
    expect(same.map((e) => e.sameTime)).toEqual([false, true])
    // Sources filtered out.
    expect(timelineEntries({ commits, uncommitted: true, local, git: false, now: NOW }).every((e) => e.kind === 'local')).toBe(true)
    expect(timelineEntries({ commits, uncommitted: true, local, history: false, now: NOW }).some((e) => e.kind === 'local')).toBe(false)
    expect(firstLine('One\nTwo')).toBe('One')
  })

  it('identicons: the same email always gives the same picture, mirrored', () => {
    const a = identicon('ada@x.org')
    expect(identicon(' ADA@x.org ')).toEqual(a)
    expect(identicon('bob@x.org')).not.toEqual(a)
    for (let row = 0; row < 5; row++) {
      expect(a.cells[row * 5]).toBe(a.cells[row * 5 + 4])
      expect(a.cells[row * 5 + 1]).toBe(a.cells[row * 5 + 3])
    }
    expect(a.color).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/)
    expect(hash128('x')).toEqual(hash128('x'))
  })

  it("a commit's message as VS Code's hover shows it: paragraphs, lists, links, emails, code, issues", () => {
    const blocks = messageBlocks('Fix the parser\n\nSee https://example.com/a.\n- one `code`\n- two #12\nThanks bob@x.org', 'https://github.com/o/r')
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'p', 'ul', 'p'])
    expect(blocks[1].parts).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: '.' }
    ])
    expect(blocks[2].items[0]).toEqual([
      { kind: 'text', text: 'one ' },
      { kind: 'code', text: 'code' }
    ])
    expect(blocks[2].items[1][1]).toEqual({ kind: 'link', text: '#12', href: 'https://github.com/o/r/issues/12' })
    expect(blocks[3].parts[1]).toEqual({ kind: 'link', text: 'bob@x.org', href: 'mailto:bob@x.org' })
    expect(inlineParts('#12')).toEqual([{ kind: 'text', text: '#12' }]) // no repository page: plain text
  })

  it('short stats, repository pages and tops', () => {
    expect(shortStatParts({ files: 1, insertions: 15, deletions: 2 }).map((p) => p.text)).toEqual(['1 file changed', '15 insertions(+)', '2 deletions(-)'])
    expect(shortStatParts({ files: 3, insertions: 1, deletions: 0 }).map((p) => p.text)).toEqual(['3 files changed', '1 insertion(+)'])
    expect(repoUrlOf('https://github.com/o/r/commit/' + 'a'.repeat(40))).toBe('https://github.com/o/r')
    expect(repoTopOf('C:\\proj\\src\\a.js', 'src/a.js')).toBe('C:\\proj')
    expect(repoTopOf('ssh://h1/srv/app/lib/b.py', 'lib/b.py')).toBe('ssh://h1/srv/app')
    expect(repoTopOf('C:\\other\\a.js', 'src/a.js')).toBeNull()
    expect(localDiffLabel('a.js', NaN)).toBe('a.js (File Saved • ) ↔ a.js')
  })

  it('a Local History diff tab has its own path; section heights are kept in range', () => {
    expect(diffTabPath('C:\\p\\a.js', 'local', 'abc123')).toBe('C:\\p\\a.js\u0000diff:local:abc123')
    expect(paneHeight(10)).toBe(44)
    expect(paneHeight(300.4)).toBe(300)
    expect(paneHeight('x')).toBe(220)
  })
})

// --- Mounted ---------------------------------------------------------------------------------
function fakeEditor(model = { id: 'm' }) {
  return {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setSelection: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    focus: vi.fn()
  }
}
async function settle(ms = 600) {
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(ms / 4)
    await flushPromises()
  }
  await nextTick()
}

describe('the Outline section', () => {
  let w
  let editor
  beforeEach(() => {
    vi.useFakeTimers()
    settings.explorerOutlineShown = true
    settings.explorerOutlineFollowCursor = true
    settings.explorerOutlineFilterOnType = true
    settings.explorerOutlineSortBy = 'position'
    fakeOutline.canGiveSymbols.mockImplementation(() => true)
    fakeOutline.documentSymbols.mockImplementation(async () => symbols())
    editor = fakeEditor()
  })
  afterEach(() => {
    w?.unmount()
    w = null
    clearActiveEditor()
    vi.useRealTimers()
    settings.explorerOutlineShown = false
    settings.explorerOutlineSortBy = 'position'
  })

  it('folded at first: its header unfolds it; without an editor, VS Code\'s message', async () => {
    settings.explorerOutlineShown = false
    w = mount(ExplorerOutline, { attachTo: document.body })
    await settle()
    expect(w.find('[data-test="outline-tree"]').exists()).toBe(false)
    await w.get('[data-test="outline-head"]').trigger('click')
    expect(settings.explorerOutlineShown).toBe(true)
    await settle()
    expect(w.get('[data-test="outline-message"]').text()).toBe('The active editor cannot provide outline information.')
  })

  it("the editor's symbols with their icons; a click shows one in the editor; Collapse All then Expand All", async () => {
    setActiveEditor({ paneId: 'e1', editor, path: 'C:\\p\\zoo.ts' })
    w = mount(ExplorerOutline, { attachTo: document.body })
    await settle()
    const rows = w.findAll('[data-test="outline-row"]')
    expect(rows.map((r) => r.get('.outline-name').text())).toEqual(['Zoo', 'constructor', 'feed', 'x', 'age', 'alpha', 'beta'])
    expect(rows[0].get('.outline-icon').attributes('data-icon')).toBe('symbol-class')
    expect(rows[0].get('.outline-icon').attributes('style')).toContain('color')
    expect(rows[2].classes()).toContain('deprecated')
    expect(rows[2].get('.outline-detail').text()).toBe('(food)')
    expect(rows[5].attributes('title')).toBe('alpha (function)')
    await rows[5].trigger('click')
    expect(editor.setSelection).toHaveBeenCalledWith({ startLineNumber: 22, startColumn: 10, endLineNumber: 22, endColumn: 10 })
    expect(editor.focus).not.toHaveBeenCalled()
    await rows[5].trigger('dblclick')
    expect(editor.setSelection).toHaveBeenLastCalledWith(R(22, 1, 30, 2))
    expect(editor.focus).toHaveBeenCalled()
    await w.get('[data-test="outline-collapse-all"]').trigger('click')
    expect(w.findAll('[data-test="outline-row"]').map((r) => r.get('.outline-name').text())).toEqual(['Zoo', 'alpha', 'beta'])
    await w.get('[data-test="outline-expand-all"]').trigger('click')
    expect(w.findAll('[data-test="outline-row"]')).toHaveLength(7)
    // A twistie folds its symbol only.
    await w.findAll('[data-test="outline-twistie"]')[2].trigger('click')
    expect(w.findAll('[data-test="outline-row"]')).toHaveLength(6)
  })

  it('Follow Cursor selects the deepest symbol around the cursor, its parents unfolded', async () => {
    setActiveEditor({ paneId: 'e1', editor, path: 'C:\\p\\zoo.ts' })
    w = mount(ExplorerOutline, { attachTo: document.body })
    await settle()
    await w.get('[data-test="outline-collapse-all"]').trigger('click')
    noteCursor('e1', 6, 12)
    await settle(40)
    const selected = w.findAll('[data-test="outline-row"]').filter((r) => r.classes().includes('selected'))
    expect(selected.map((r) => r.get('.outline-name').text())).toEqual(['x'])
    // Off: the selection stays.
    settings.explorerOutlineFollowCursor = false
    noteCursor('e1', 31, 3)
    await settle(40)
    expect(w.get('.outline-row.selected .outline-name').text()).toBe('x')
  })

  it('Filter on Type: typing in the tree filters it; Escape clears; the menu sorts by name', async () => {
    setActiveEditor({ paneId: 'e1', editor, path: 'C:\\p\\zoo.ts' })
    w = mount(ExplorerOutline, { attachTo: document.body })
    await settle()
    await w.get('[data-test="outline-tree"]').trigger('keydown', { key: 'x' })
    await nextTick()
    const input = w.get('[data-test="outline-find-input"]')
    expect(input.element.value).toBe('x')
    expect(w.findAll('[data-test="outline-row"]').map((r) => r.get('.outline-name').text())).toEqual(['Zoo', 'feed', 'x'])
    expect(w.findAll('.outline-hit').map((h) => h.text())).toEqual(['x'])
    await input.setValue('zzz')
    expect(w.text()).toContain('No results found.')
    await input.trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="outline-find"]').exists()).toBe(false)
    expect(w.findAll('[data-test="outline-row"]')).toHaveLength(7)
    // Highlight mode (Filter on Type off): every row stays.
    settings.explorerOutlineFilterOnType = false
    await w.get('[data-test="outline-tree"]').trigger('keydown', { key: 'a' })
    await nextTick()
    expect(w.findAll('[data-test="outline-row"]')).toHaveLength(7)
    expect(w.get('[data-test="outline-find-input"]').attributes('placeholder')).toBe('Type to search')
    await w.get('[data-test="outline-find-input"]').trigger('keydown', { key: 'Escape' })
    // More Actions...: Sort By: Name.
    await w.get('[data-test="outline-more"]').trigger('click')
    await nextTick()
    expect(w.get('[data-test="outline-follow"]').attributes('aria-checked')).toBe('true')
    await w.get('[data-test="outline-sort-name"]').trigger('click')
    expect(settings.explorerOutlineSortBy).toBe('name')
    await nextTick()
    expect(w.findAll('[data-test="outline-row"]').filter((r) => r.attributes('aria-level') === '1').map((r) => r.get('.outline-name').text())).toEqual(['alpha', 'beta', 'Zoo'])
  })

  it("a file no language service reads, and one with no symbols: VS Code's messages", async () => {
    fakeOutline.canGiveSymbols.mockImplementation(() => false)
    setActiveEditor({ paneId: 'e1', editor, path: 'C:\\p\\notes.txt' })
    w = mount(ExplorerOutline, { attachTo: document.body })
    await settle()
    expect(w.get('[data-test="outline-message"]').text()).toBe('The active editor cannot provide outline information.')
    fakeOutline.canGiveSymbols.mockImplementation(() => true)
    fakeOutline.documentSymbols.mockImplementation(async () => [])
    setActiveEditor({ paneId: 'e1', editor: fakeEditor({ id: 'n' }), path: 'C:\\p\\empty.ts' })
    await settle()
    expect(w.get('[data-test="outline-message"]').text()).toBe("No symbols found in document 'empty.ts'")
  })
})

const FILE = 'C:\\proj\\src\\a.js'
const COMMITS = [
  { id: '1'.repeat(40), author: 'Ada Lovelace', email: 'ada@x.org', time: Date.now() - 3 * 3600 * 1000, message: 'Fix the parser\n\n- handle `x`\n- see #12' },
  { id: '2'.repeat(40), author: 'Bob', email: 'bob@x.org', time: Date.now() - 40 * 86400 * 1000, message: 'First' }
]
function timelineApi({ commits = COMMITS, uncommitted = true, hasMore = false, local = [{ id: 'kq1abc', source: 'save', timestamp: Date.now() - 60 * 1000 }], ok = true } = {}) {
  window.shellApi = {
    scm: {
      fileHistory: vi.fn(async () => (ok ? { ok: true, items: commits, hasMore, uncommitted, rel: 'src/a.js' } : { ok: false, error: 'This folder is not in a git repository.' })),
      commitInfo: vi.fn(async () => ({ ok: true, stats: { files: 1, insertions: 15, deletions: 2 }, webUrl: 'https://github.com/o/r/commit/' + '1'.repeat(40) }))
    },
    localHistory: { list: vi.fn(async () => ({ ok: true, entries: local })), add: vi.fn(async () => ({ ok: true, id: 'zz1234' })) },
    openExternal: vi.fn(async () => true)
  }
  return window.shellApi
}

describe('the Timeline section', () => {
  let w
  beforeEach(() => {
    vi.useFakeTimers()
    settings.explorerTimelineShown = true
    settings.explorerTimelineGit = true
    settings.explorerTimelineLocal = true
  })
  afterEach(() => {
    w?.unmount()
    w = null
    clearActiveEditor()
    vi.useRealTimers()
    delete window.shellApi
    settings.explorerTimelineShown = false
    settings.explorerTimelineGit = true
    settings.explorerTimelineLocal = true
  })

  it("the file's uncommitted changes, commits and saves, newest first; a click opens that diff", async () => {
    const api = timelineApi()
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await settle()
    expect(api.scm.fileHistory).toHaveBeenCalledWith({ root: 'C:\\proj\\src', path: FILE, limit: 20 })
    const rows = w.findAll('[data-test="timeline-row"]')
    expect(rows.map((r) => r.get('.timeline-label').text())).toEqual(['Uncommitted Changes', 'File Saved', 'Fix the parser', 'First'])
    expect(rows[2].get('.timeline-description').text()).toBe('Ada Lovelace')
    expect(rows[2].get('.timeline-time').text()).toBe('3 hrs')
    expect(rows[2].get('.timeline-icon').attributes('data-icon')).toBe('git-commit')
    expect(w.get('[data-test="timeline-description"]').text()).toBe('a.js')
    await rows[2].trigger('click')
    expect(w.emitted('open-diff')[0][0]).toEqual({ root: 'C:\\proj', rel: 'src/a.js', area: 'commit', commit: COMMITS[0].id, status: 'modified', file: FILE, preview: true })
    await rows[0].trigger('click')
    expect(w.emitted('open-diff')[1][0]).toMatchObject({ root: 'C:\\proj', rel: 'src/a.js', area: 'unstaged', file: FILE })
    await rows[1].trigger('click')
    expect(w.emitted('open-diff')[2][0]).toMatchObject({ area: 'local', local: 'kq1abc', file: FILE })
  })

  it('a commit\'s hover after 500 ms: author, when, message, numbers, hash, GitHub', async () => {
    const api = timelineApi()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await settle()
    const row = w.findAll('[data-test="timeline-row"]')[2]
    await row.trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await nextTick()
    expect(document.querySelector('[data-test="timeline-hover"]')).toBeNull()
    await settle(400)
    const card = document.querySelector('[data-test="timeline-hover"]')
    expect(card).not.toBeNull()
    expect(card.getAttribute('role')).toBe('tooltip')
    expect(card.querySelector('[data-test="timeline-avatar"]')).not.toBeNull()
    expect(card.textContent).toContain('Ada Lovelace')
    expect(card.textContent).toContain('3 hours ago (')
    expect(card.querySelectorAll('li')).toHaveLength(2)
    expect(card.querySelector('code').textContent).toBe('x')
    expect(api.scm.commitInfo).toHaveBeenCalledWith({ root: 'C:\\proj\\src', commit: COMMITS[0].id })
    expect(card.querySelector('[data-test="timeline-hover-stats"]').textContent).toBe('1 file changed, 15 insertions(+), 2 deletions(-)')
    expect(card.querySelector('.stat-insertions')).not.toBeNull()
    expect(card.querySelector('[data-test="timeline-hover-hash"]').textContent).toMatch(/ 1111111$/)
    card.querySelector('[data-test="timeline-hover-copy"]').click()
    expect(writeText).toHaveBeenCalledWith(COMMITS[0].id)
    card.querySelector('[data-test="timeline-hover-github"]').click()
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/o/r/commit/' + '1'.repeat(40))
    // The issue link goes to the repository's page.
    const issue = [...card.querySelectorAll('a')].find((a) => a.textContent === '#12')
    expect(issue.getAttribute('title')).toBe('https://github.com/o/r/issues/12')
    // Kept while the pointer is on it, gone after it leaves.
    await row.trigger('mouseleave')
    card.dispatchEvent(new Event('mouseenter'))
    await settle(400)
    expect(document.querySelector('[data-test="timeline-hover"]')).not.toBeNull()
    card.dispatchEvent(new Event('mouseleave'))
    await settle(400)
    expect(document.querySelector('[data-test="timeline-hover"]')).toBeNull()
  })

  it('pin keeps the file; the filter menu leaves a source out; Load more asks for more', async () => {
    const api = timelineApi({ hasMore: true })
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await settle()
    await w.get('[data-test="timeline-pin"]').trigger('click')
    expect(w.get('[data-test="timeline-pin"]').attributes('title')).toBe('Unpin the Current Timeline')
    expect(w.get('[data-test="timeline-description"]').text()).toBe('a.js (pinned)')
    setActiveEditor({ paneId: 'e1', editor: fakeEditor({ id: 'b' }), path: 'C:\\proj\\b.js' })
    await settle()
    expect(api.scm.fileHistory.mock.calls.every((c) => c[0].path === FILE)).toBe(true)
    await w.get('[data-test="timeline-pin"]').trigger('click')
    await settle()
    expect(api.scm.fileHistory.mock.calls.at(-1)[0].path).toBe('C:\\proj\\b.js')
    // Load more.
    await w.get('[data-test="timeline-more"]').trigger('click')
    await settle()
    expect(api.scm.fileHistory.mock.calls.at(-1)[0].limit).toBe(40)
    // Filter Timeline: Git History off.
    await w.get('[data-test="timeline-filter"]').trigger('click')
    await nextTick()
    await w.get('[data-test="timeline-filter-git"]').trigger('click')
    expect(settings.explorerTimelineGit).toBe(false)
    await settle()
    expect(w.findAll('[data-test="timeline-row"]').map((r) => r.get('.timeline-label').text())).toEqual(['File Saved'])
  })

  it("VS Code's messages: no editor, nothing kept yet, every source filtered out, no Source Control", async () => {
    timelineApi({ commits: [], uncommitted: false, local: [], ok: false })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await settle()
    expect(w.get('[data-test="timeline-message"]').text()).toBe('The active editor cannot provide timeline information.')
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    await settle()
    expect(w.get('[data-test="timeline-message"]').text()).toBe(
      'Local History will track recent changes as you save them unless the file has been excluded or is too large. Source Control has not been configured.'
    )
    settings.explorerTimelineGit = false
    settings.explorerTimelineLocal = false
    await settle()
    expect(w.get('[data-test="timeline-message"]').text()).toBe('All timeline sources have been filtered out.')
  })

  it('a save kept by Local History reads the timeline again', async () => {
    const api = timelineApi()
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await settle()
    const before = api.localHistory.list.mock.calls.length
    const rev = localHistoryState.rev
    keepSavedVersion(FILE, 'text')
    await flushPromises()
    expect(api.localHistory.add).toHaveBeenCalledWith({ path: FILE, text: 'text' })
    expect(localHistoryState.rev).toBe(rev + 1)
    await settle(800)
    expect(api.localHistory.list.mock.calls.length).toBe(before + 1)
  })
})

describe('in the explorer', () => {
  let w
  afterEach(() => {
    w?.unmount()
    clearActiveEditor()
    vi.useRealTimers()
    delete window.shellApi
    settings.explorerTimelineShown = false
    settings.explorerOutlineShown = false
  })
  it('Outline and Timeline under the folder; a Timeline diff goes out of the explorer', async () => {
    vi.useFakeTimers()
    const api = timelineApi()
    api.explorer = {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async () => ({ ok: true, entries: [] })),
      status: vi.fn(async () => ({ ok: true, repo: true, files: {} })),
      sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] }))
    }
    settings.explorerOutlineShown = false
    settings.explorerTimelineShown = true
    setActiveEditor({ paneId: 'e1', editor: fakeEditor(), path: FILE })
    w = mount(ExplorerPanel, { props: { root: 'C:\\proj' }, attachTo: document.body })
    await settle()
    expect(w.get('[data-test="outline-head"]').text()).toContain('Outline')
    expect(w.get('[data-test="outline-head"]').attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test="timeline-sash"]').exists()).toBe(true)
    await w.findAll('[data-test="timeline-row"]')[2].trigger('click')
    expect(w.emitted('open-diff')[0][0]).toMatchObject({ area: 'commit', file: FILE })
    expect(activeEditor.path).toBe(FILE)
  })
})
