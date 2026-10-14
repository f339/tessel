// The line of tabs above the panes (ViewTabs.vue): Terminal first, then a tab
// per file each editor has open (a preview in italics, kept by a
// double-click), then each browser.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ViewTabs from '../components/ViewTabs.vue'

const editor = {
  type: 'leaf',
  kind: 'editor',
  id: 'ed1',
  activePath: 'C:\\p\\b.js',
  files: [
    { path: 'C:\\p\\a.js', preview: true },
    { path: 'C:\\p\\b.js', preview: false }
  ]
}
const browser = { type: 'leaf', kind: 'browser', id: 'br1', url: 'https://example.com/', title: 'Example' }

describe('the line of tabs', () => {
  it('Terminal first, a tab per open file, then the browser', () => {
    const w = mount(ViewTabs, { props: { leaves: [editor, browser], shown: 'ed1' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    expect(tabs.map((t) => t.text().trim())).toEqual(['Terminal', 'a.js', 'b.js', 'Example'])
    // The editor's current file is the active tab; the preview is in italics.
    expect(tabs[2].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
    expect(tabs[1].classes()).toContain('preview')
  })

  it("a file's tab: shown, kept (double-click on a preview), closed in its editor", async () => {
    const w = mount(ViewTabs, { props: { leaves: [editor], shown: 'terminal' } })
    const a = w.findAll('[data-test="view-tab"]')[1]
    await a.trigger('click')
    expect(w.emitted('select').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    await a.trigger('dblclick')
    expect(w.emitted('keep').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    await a.find('[data-test="view-tab-close"]').trigger('click')
    expect(w.emitted('close').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    // A kept file: a double-click does nothing more.
    await w.findAll('[data-test="view-tab"]')[2].trigger('dblclick')
    expect(w.emitted('keep')).toHaveLength(1)
  })

  it('an editor with no file: one Editor tab', () => {
    const w = mount(ViewTabs, { props: { leaves: [{ ...editor, files: [], activePath: null }], shown: 'ed1' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    expect(tabs.map((t) => t.text().trim())).toEqual(['Terminal', 'Editor'])
    expect(tabs[1].classes()).toContain('active')
  })
})
