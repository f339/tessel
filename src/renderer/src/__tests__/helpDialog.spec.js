// Keyboard shortcuts and help (HelpDialog.vue, helpShortcuts.js): one key
// cap per key of a chord, "or" between alternatives (never drawn as a key),
// key names in French, the search over what a shortcut does and its keys,
// Escape clearing a search before it closes, and no logs buttons (General
// has them).
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import HelpDialog from '../components/HelpDialog.vue'
import { chordsOf, filterShortcuts, shortcutGroups } from '../helpShortcuts'
import { setMessages } from '../i18n'
import frApp from '../i18n/locales/fr/app.json'

afterEach(() => {
  setMessages('en', {})
  document.body.innerHTML = ''
})

const rowOf = (w, text) => w.findAll('[data-test="help-row"]').find((r) => r.text().includes(text))
const keysOf = (row) => row.findAll('kbd').map((k) => k.text())

describe('HelpDialog', () => {
  it('one key cap per key; alternatives with "or", the slash never a key', () => {
    expect(chordsOf('Ctrl+Shift+T')).toEqual([['Ctrl', 'Shift', 'T']])
    expect(chordsOf('F7 / Shift+F7')).toEqual([['F7'], ['Shift', 'F7']])
    expect(chordsOf('Ctrl+=')).toEqual([['Ctrl', '=']])
    const w = mount(HelpDialog, { attachTo: document.body })
    expect(keysOf(rowOf(w, 'New pane'))).toEqual(['Ctrl', 'Shift', 'T'])
    const diff = rowOf(w, 'Next / previous change')
    expect(keysOf(diff)).toEqual(['F7', 'Shift', 'F7'])
    expect(diff.find('.hd-or').text()).toBe('or')
    expect(keysOf(diff)).not.toContain('/')
    // No logs buttons: Settings > General has them.
    expect(w.text()).not.toContain('Open logs folder')
    expect(w.text()).not.toContain('Copy diagnostics')
    w.unmount()
  })

  it('key names in French', () => {
    setMessages('fr', frApp)
    const w = mount(HelpDialog, { attachTo: document.body })
    expect(keysOf(rowOf(w, 'Nouveau panneau'))).toEqual(['Ctrl', 'Maj', 'T'])
    expect(keysOf(w.findAll('[data-test="help-row"]').find((r) => r.text().includes('Pg préc')))).toContain('Pg préc')
    expect(w.find('.hd-or').text()).toBe('ou')
    w.unmount()
  })

  it('the search filters by what a shortcut does or by its keys; nothing found says so', async () => {
    const groups = shortcutGroups()
    expect(filterShortcuts(groups, 'split').flatMap((g) => g.rows.map((r) => r.text))).toEqual(['Split right', 'Split down'])
    expect(filterShortcuts(groups, 'shift+f7').flatMap((g) => g.rows.map((r) => r.keys))).toEqual(['F7 / Shift+F7'])
    const w = mount(HelpDialog, { attachTo: document.body })
    // The search box has the keyboard.
    expect(document.activeElement).toBe(w.find('[data-test="help-search"]').element)
    await w.find('[data-test="help-search"]').setValue('workspace')
    const rows = w.findAll('[data-test="help-row"]').map((r) => r.text())
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((t) => /workspace/i.test(t))).toBe(true)
    await w.find('[data-test="help-search"]').setValue('zzz')
    expect(w.find('[data-test="help-none"]').text()).toBe('No shortcut matches.')
    // Escape clears the search first, then closes.
    await w.find('[data-test="help-dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="help-search"]').element.value).toBe('')
    expect(w.emitted('close')).toBeUndefined()
    await w.find('[data-test="help-dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('accents and case do not matter in the search (French)', () => {
    setMessages('fr', frApp)
    const found = filterShortcuts(shortcutGroups(), 'precedent').flatMap((g) => g.rows.map((r) => r.text))
    expect(found.length).toBeGreaterThan(0)
  })
})
