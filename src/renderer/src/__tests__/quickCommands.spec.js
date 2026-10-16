import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { settings, loadSettings, resetSettings, validQuickCommand } from '../settings'
import SettingsDialog from '../components/SettingsDialog.vue'

describe('quick commands', () => {
  beforeEach(() => {
    settings.quickCommands = []
    window.shellApi = {}
  })

  it('loads only well-formed ones, and a reset keeps them', () => {
    loadSettings({
      quickCommands: [
        { id: 'qc-1', name: 'Tests', text: 'npm test', enter: true },
        { id: 'qc-2', name: '', text: 'x', enter: true },
        { id: 'qc-3', name: 'No enter flag', text: 'x' },
        'junk'
      ]
    })
    expect(settings.quickCommands.map((q) => q.id)).toEqual(['qc-1'])
    resetSettings()
    expect(settings.quickCommands.map((q) => q.id)).toEqual(['qc-1'])
    expect(validQuickCommand({ id: 'a', name: 'n', text: 'x'.repeat(20001), enter: false })).toBe(false)
  })

  it('are added in Settings; a row opens its details, where it is edited in place and removed', async () => {
    const w = mount(SettingsDialog, { props: { section: 'quick-commands' }, attachTo: document.body })
    const page = () => w.get('#set-quick-commands')
    expect(page().get('[data-test="quick-empty"]').text()).toMatch(/No quick commands yet/)
    const form = page().get('[data-test="quick-add"]')
    await form.get('[data-test="quick-name"]').setValue('Run tests')
    await form.get('[data-test="quick-text"]').setValue('npm test')
    // Press Enter is a switch, not a native checkbox.
    expect(form.get('[data-test="quick-enter"]').classes()).toContain('set-switch')
    await form.trigger('submit')
    expect(settings.quickCommands).toMatchObject([{ name: 'Run tests', text: 'npm test', enter: true }])
    // One row, its text once (the page's description is not repeated in the card).
    const item = page().get('.sl-item')
    expect(item.get('.sl-row-name').text()).toBe('Run tests')
    expect(item.get('.sl-row-desc').text()).toBe('npm test')
    expect(page().text().match(/Text you send to the active pane/g) || []).toHaveLength(1)
    await item.get('.sl-row').trigger('click')
    const name = page().get('[data-test="quick-edit-name"]')
    await name.setValue('Tests')
    await page().get('[data-test="quick-edit-text"]').setValue('npm run test')
    await page().get('[data-test="quick-edit-enter"]').setValue(false)
    expect(settings.quickCommands).toMatchObject([{ name: 'Tests', text: 'npm run test', enter: false }])
    // An empty name is said, and the saved command keeps its last valid name.
    await name.setValue('  ')
    expect(page().get('[data-test="quick-edit-error"]').text()).toMatch(/name and the text/)
    expect(settings.quickCommands[0].name).toBe('Tests')
    await page().get('[data-test="quick-remove"]').trigger('click')
    await flushPromises()
    expect(settings.quickCommands).toEqual([])
    await form.trigger('submit')
    expect(page().get('[data-test="quick-error"]').text()).toMatch(/name and the text/)
    w.unmount()
  })

  it('asks before removing one, when Tessel can ask', async () => {
    settings.quickCommands = [{ id: 'qc-1', name: 'Tests', text: 'npm test', enter: true }]
    const askConfirm = vi.fn(async () => false)
    const w = mount(SettingsDialog, { props: { section: 'quick-commands' }, attachTo: document.body, global: { provide: { askConfirm } } })
    await w.get('#set-quick-commands .sl-row').trigger('click')
    await w.get('[data-test="quick-remove"]').trigger('click')
    await flushPromises()
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(settings.quickCommands).toHaveLength(1)
    w.unmount()
  })
})
