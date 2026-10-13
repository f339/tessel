import { describe, it, expect } from 'vitest'
import { stickyFolders } from '../explorerRows'
import { openEditorsOf, folderLabel } from '../explorer/openEditors'
import { diffTabPath } from '../editor/editorTabs'

const H = 22
// A: 0 (open) > B: 1..(open) > files
function tree() {
  const items = [{ depth: 0 }] // 0 A
  items.push({ depth: 1 }) // 1 B
  for (let i = 0; i < 10; i++) items.push({ depth: 2 }) // 2..11 B's files
  for (let i = 0; i < 5; i++) items.push({ depth: 1 }) // 12..16 A's files
  items.push({ depth: 0 }) // 17 C
  return items
}

describe("sticky folders (VS Code's tree sticky scroll)", () => {
  it('none at the top; the folders above the first line once scrolled', () => {
    expect(stickyFolders(tree(), 0)).toEqual([])
    // Scrolled into B's files: A and B stay, one line each.
    expect(stickyFolders(tree(), 4 * H)).toEqual([
      { at: 0, top: 0 },
      { at: 1, top: H }
    ])
  })
  it("the deepest is pushed up as its last child leaves, then only its parent stays", () => {
    // B's last file (11) under B's line: B goes up.
    const s = stickyFolders(tree(), 10 * H + 5)
    expect(s[0]).toEqual({ at: 0, top: 0 })
    expect(s[1].at).toBe(1)
    expect(s[1].top).toBeLessThan(H)
    // In A's own files: only A.
    expect(stickyFolders(tree(), 13 * H)).toEqual([{ at: 0, top: 0 }])
    // At C, a top level folder: nothing.
    expect(stickyFolders(tree(), 17 * H)).toEqual([])
  })
  it('at most 7 lines', () => {
    const deep = []
    for (let d = 0; d < 12; d++) deep.push({ depth: d })
    for (let i = 0; i < 40; i++) deep.push({ depth: 12 })
    expect(stickyFolders(deep, 30 * H)).toHaveLength(7)
  })
})

describe('Open Editors', () => {
  it("lists every editor pane's tabs and the web pages, with folder, unsaved, preview and the one in use", () => {
    const leaves = [
      {
        id: 'e1',
        kind: 'editor',
        activePath: 'C:\\p\\src\\a.ts',
        files: [
          { path: 'C:\\p\\src\\a.ts' },
          { path: 'C:\\p\\README.md', preview: true },
          { path: diffTabPath('C:\\p\\src\\b.ts', 'unstaged'), diff: { full: 'C:\\p\\src\\b.ts', area: 'unstaged' } }
        ]
      },
      { id: 't1', kind: 'agent' },
      { id: 'b1', kind: 'browser', title: 'Anticheat · Analyse', url: 'http://localhost:8471/' }
    ]
    const list = openEditorsOf({
      leaves,
      activeId: 'e1',
      root: 'C:\\p',
      isDirty: (p) => p.endsWith('a.ts'),
      label: (f) => 'b.ts (diff)'
    })
    expect(list.map((e) => [e.kind, e.name, e.folder, e.dirty, e.preview, e.active])).toEqual([
      ['file', 'a.ts', 'src', true, false, true],
      ['file', 'README.md', '', false, true, false],
      ['file', 'b.ts (diff)', 'src', false, false, false],
      ['page', 'Anticheat · Analyse', 'http://localhost:8471/', false, false, false]
    ])
    expect(list[0]).toMatchObject({ paneId: 'e1', tabPath: 'C:\\p\\src\\a.ts', path: 'C:\\p\\src\\a.ts' })
  })
  it('folders outside the project: the home folder as ~', () => {
    expect(folderLabel('/home/me/ox-update/README.md', '/srv/fx', '/home/me')).toBe('~/ox-update')
    expect(folderLabel('D:\\other\\x.txt', 'C:\\p', 'C:\\Users\\me')).toBe('D:/other')
  })
})

// --- The panel ------------------------------------------------------------------------
import { afterEach, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { settings } from '../settings'

const ROOT = 'C:\\proj'
const P = (rel) => `${ROOT}\\${rel}`
function shellApi(entries) {
  window.shellApi = {
    explorer: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async ({ dir }) => ({ ok: true, entries: entries[dir] || [] })),
      status: vi.fn(async () => ({ ok: true, repo: true, files: { [P('src\\a.ts').toLowerCase()]: 'M' } })),
      sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
      searchNames: vi.fn(async () => ({ ok: true, results: [] }))
    }
  }
}

describe('ExplorerPanel like VS Code', () => {
  let w
  beforeEach(() => {
    settings.explorerOpenEditorsShown = true
    settings.explorerFolderShown = true
  })
  afterEach(() => {
    w?.unmount()
    delete window.shellApi
    settings.explorerOpenEditorsShown = true
    settings.explorerFolderShown = true
  })
  const editors = [
    { key: 'e|a', kind: 'file', paneId: 'e', tabPath: P('src\\a.ts'), path: P('src\\a.ts'), name: 'a.ts', folder: 'src', dirty: true, preview: false, active: false },
    { key: 'e|r', kind: 'file', paneId: 'e', tabPath: P('README.md'), path: P('README.md'), name: 'README.md', folder: '', dirty: false, preview: true, active: true },
    { key: 'b|page', kind: 'page', paneId: 'b', path: null, name: 'Anticheat', folder: 'http://localhost:8471/', dirty: false, active: false }
  ]

  it('Open Editors: each file and page, its folder, unsaved and preview; a click shows it, its × closes it', async () => {
    shellApi({ [ROOT]: [] })
    w = mount(ExplorerPanel, { props: { root: ROOT, openEditors: editors }, attachTo: document.body })
    await flushPromises()
    const rows = w.findAll('[data-test="open-editor"]')
    expect(rows.map((r) => r.get('.open-editor-name').text())).toEqual(['a.ts', 'README.md', 'Anticheat'])
    expect(rows[0].get('.open-editor-folder').text()).toBe('src')
    expect(rows[0].classes()).toContain('dirty')
    expect(rows[0].get('.explorer-git').text()).toBe('M') // its git letter
    expect(rows[1].classes()).toEqual(expect.arrayContaining(['preview', 'active']))
    expect(w.get('[data-test="open-editors-unsaved"]').text()).toBe('1 unsaved')
    await rows[1].trigger('click')
    expect(w.emitted('activate-editor')[0][0].key).toBe('e|r')
    await rows[2].get('[data-test="open-editor-close"]').trigger('click')
    expect(w.emitted('close-editor')[0][0].key).toBe('b|page')
    expect(w.emitted('activate-editor')).toHaveLength(1) // the × does not also show it
    await w.get('[data-test="open-editors-save-all"]').trigger('click')
    expect(w.emitted('save-all')).toHaveLength(1)
    // Folded by its header, and kept so.
    await w.get('[data-test="open-editors-head"]').trigger('click')
    expect(w.find('[data-test="open-editor"]').exists()).toBe(false)
    expect(settings.explorerOpenEditorsShown).toBe(false)
  })

  it("the folder's header names the SSH host and folds the tree", async () => {
    shellApi({ [ROOT]: [{ name: 'src', path: P('src'), dir: true }] })
    w = mount(ExplorerPanel, { props: { root: ROOT, remoteLabel: 'fivem-afterlife' }, attachTo: document.body })
    await flushPromises()
    expect(w.get('[data-test="explorer-folder-head"] .explorer-title').text()).toBe('proj [SSH: fivem-afterlife]')
    expect(w.find('.explorer-files').exists()).toBe(true)
    await w.get('[data-test="explorer-folder-head"]').trigger('click')
    expect(w.find('.explorer-files').exists()).toBe(false)
  })

  it('folders above the first line stay at the top while scrolling; a click brings the folder back', async () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.txt`, path: P(`src\\f${i}.txt`), dir: false }))
    shellApi({ [ROOT]: [{ name: 'src', path: P('src'), dir: true }, { name: 'z.md', path: P('z.md'), dir: false }], [P('src')]: files })
    w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
    await flushPromises()
    await w.findAll('.explorer-files .explorer-row').find((r) => r.text().includes('src')).trigger('click')
    await flushPromises()
    const tree = w.get('.explorer-files').element
    tree.scrollTop = 10 * 22
    tree.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 40))
    const sticky = w.findAll('[data-test="explorer-sticky"] .explorer-sticky-row')
    expect(sticky.map((s) => s.get('.explorer-name').text())).toEqual(['src'])
    await sticky[0].trigger('click')
    expect(tree.scrollTop).toBe(0)
  })

  it('the right-click menu stays in the window', async () => {
    shellApi({ [ROOT]: [{ name: 'a.txt', path: P('a.txt'), dir: false }] })
    w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
    await flushPromises()
    const proto = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList && this.classList.contains('explorer-menu') ? { width: 260, height: 400, top: 0, left: 0, right: 260, bottom: 400 } : proto.call(this)
    }
    try {
      const row = w.findAll('.explorer-files .explorer-row')[0]
      await row.trigger('contextmenu', { clientX: window.innerWidth - 50, clientY: window.innerHeight - 20 })
      await flushPromises()
      const style = w.get('.explorer-menu').attributes('style')
      const top = parseFloat(/top: ([\d.-]+)px/.exec(style)[1])
      const left = parseFloat(/left: ([\d.-]+)px/.exec(style)[1])
      expect(top + 400).toBeLessThanOrEqual(window.innerHeight)
      expect(left + 260).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto
    }
  })
})

describe('Codicon.vue', () => {
  it("one glyph, and no codicon-* class (Monaco's stylesheet would draw the icon a second time)", async () => {
    const { default: Codicon } = await import('../components/Codicon.vue')
    const w = mount(Codicon, { props: { name: 'new-file' } })
    expect(w.text()).toBe(String.fromCodePoint(0xea7f))
    expect(w.classes().some((c) => c.startsWith('codicon-'))).toBe(false)
    w.unmount()
  })
})
