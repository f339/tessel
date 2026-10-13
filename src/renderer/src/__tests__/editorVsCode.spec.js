import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { symbolsAt, symbolIcon } from '../editor/symbolKinds'
import EditorBreadcrumbs from '../components/EditorBreadcrumbs.vue'

const R = (a, b, c, d) => ({ startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d })
const tree = [
  { name: 'Cache', kind: 4, range: R(1, 1, 10, 2), selectionRange: R(1, 7, 1, 12), children: [{ name: 'set', kind: 5, range: R(3, 3, 6, 4), selectionRange: R(3, 3, 3, 6), children: [] }] },
  { name: 'pad', kind: 11, range: R(12, 1, 15, 2), selectionRange: R(12, 10, 12, 13), children: [] }
]

describe("VS Code's breadcrumbs", () => {
  it('the symbols around the cursor, outermost first', () => {
    expect(symbolsAt(tree, 4, 5).map((s) => s.name)).toEqual(['Cache', 'set'])
    expect(symbolsAt(tree, 2, 1).map((s) => s.name)).toEqual(['Cache'])
    expect(symbolsAt(tree, 13, 1).map((s) => s.name)).toEqual(['pad'])
    expect(symbolsAt(tree, 11, 1)).toEqual([])
    expect(symbolsAt(null, 1, 1)).toEqual([])
  })

  it("VS Code's icon and colour for each kind", () => {
    expect(symbolIcon(4)).toEqual({ name: 'symbol-class', color: '#EE9D28' })
    expect(symbolIcon(11)).toEqual({ name: 'symbol-function', color: '#B180D7' })
    expect(symbolIcon(12)).toEqual({ name: 'symbol-variable', color: '#75BEFF' })
    expect(symbolIcon(99).name).toBe('symbol-variable')
  })

  it('folders under the project, the file with its icon, then the symbols; a symbol is shown when clicked', async () => {
    const w = mount(EditorBreadcrumbs, { props: { path: 'C:\\p\\src\\ui\\cache.ts', root: 'C:\\p', symbols: symbolsAt(tree, 4, 5) } })
    expect(w.findAll('.ed-crumb-label').map((c) => c.text())).toEqual(['src', 'ui', 'cache.ts', 'Cache', 'set'])
    expect(w.find('.ed-crumb-file [data-test="file-icon"]').exists()).toBe(true)
    await w.findAll('[data-test="crumb-symbol"]')[1].trigger('click')
    expect(w.emitted('reveal')[0][0].name).toBe('set')
    w.unmount()
  })

  it('a file on an SSH host: its folders from the project there', () => {
    const w = mount(EditorBreadcrumbs, { props: { path: 'ssh://ssh-1a2b/srv/fx/res/a.lua', root: 'ssh://ssh-1a2b/srv/fx' } })
    expect(w.findAll('.ed-crumb-label').map((c) => c.text())).toEqual(['res', 'a.lua'])
    w.unmount()
  })
})
