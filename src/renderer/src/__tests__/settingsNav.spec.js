import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'

// Settings is a page with a sidebar: one page shows at a time.
const visiblePages = (w) =>
  w
    .findAll('.set-page')
    .filter((p) => !p.element.hidden)
    .map((p) => p.attributes('data-page'))
const shown = (el) => !el.closest('[hidden]')
const settle = async () => {
  await nextTick()
  await nextTick()
  await nextTick()
}

// Mounting the whole settings dialog is CPU work (nothing here is timed); on a
// fully loaded machine it can pass the default 5 s.
describe('Settings pages', { timeout: 30_000 }, () => {
  let wrapper, previousApi

  beforeEach(() => {
    resetSettings()
    try {
      localStorage.clear()
    } catch {
      // no storage
    }
    previousApi = window.shellApi
    window.shellApi = {}
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetSettings()
    window.shellApi = previousApi
  })

  it('opens on General, and a nav entry shows its page (and is remembered)', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['general'])
    expect(wrapper.get('.set-nav-item[data-page="general"]').attributes('aria-current')).toBe(
      'page'
    )

    await wrapper.get('.set-nav-item[data-page="terminal"]').trigger('click')
    expect(visiblePages(wrapper)).toEqual(['terminal'])
    expect(wrapper.get('#set-terminal h2').text()).toBe('Terminal')
    expect(wrapper.get('.set-nav-item[data-page="terminal"]').attributes('aria-current')).toBe('page')
    expect(
      wrapper.get('.set-nav-item[data-page="general"]').attributes('aria-current')
    ).toBeUndefined()
    expect(localStorage.getItem('tessel.settingsPage')).toBe('terminal')

    wrapper.unmount()
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['terminal'])
  })

  it('Text is Terminal now: its old id opens Terminal, from a link or the page remembered', async () => {
    wrapper = mount(SettingsDialog, { props: { section: 'text' }, attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['terminal'])
    expect(wrapper.find('.set-nav-item[data-page="text"]').exists()).toBe(false)
    expect(wrapper.find('#set-text').exists()).toBe(false)
    // Its settings are Terminal's Font and Cursor groups.
    const font = wrapper.get('#set-terminal-font')
    expect(font.get('.set-group-title').text()).toBe('Font')
    expect(font.find('#settings-font').exists()).toBe(true)
    expect(font.find('#settings-font-weight').exists()).toBe(true)
    expect(wrapper.find('#set-terminal #settings-cursor-opacity').exists()).toBe(true)
    wrapper.unmount()

    localStorage.setItem('tessel.settingsPage', 'text')
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['terminal'])
    await wrapper.setProps({ section: 'general' })
    await wrapper.setProps({ section: 'text' })
    expect(visiblePages(wrapper)).toEqual(['terminal'])

    // The search finds the group by the old page's title.
    await wrapper.get('input[type="search"]').setValue('text')
    await settle()
    expect(visiblePages(wrapper)).toContain('terminal')
    expect(shown(wrapper.get('#settings-font-weight').element)).toBe(true)
    expect(shown(wrapper.get('#settings-line-height').element)).toBe(true)
  })

  it('the section prop opens its page', async () => {
    for (const section of ['accounts', 'agents', 'orchestration', 'quick-commands', 'stats']) {
      wrapper = mount(SettingsDialog, { props: { section }, attachTo: document.body })
      expect(visiblePages(wrapper)).toEqual([section])
      expect(wrapper.get(`#set-${section}`).element.hidden).toBe(false)
      wrapper.unmount()
    }
    wrapper = null
  })

  it('mounts analytics only on its page and forwards known worktree paths', async () => {
    wrapper = mount(SettingsDialog, {
      props: { worktreePaths: ['C:/project/copy'] },
      attachTo: document.body,
      global: {
        stubs: {
          StatsUsage: {
            props: ['worktreePaths'],
            template: '<div class="stats-stub">{{ worktreePaths.join() }}</div>'
          }
        }
      }
    })
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
    await wrapper.get('input[type="search"]').setValue('tokens')
    await settle()
    expect(visiblePages(wrapper)).toContain('stats')
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
    await wrapper.get('.set-nav-item[data-page="stats"]').trigger('click')
    await settle()
    expect(visiblePages(wrapper)).toEqual(['stats'])
    expect(wrapper.get('.stats-stub').text()).toBe('C:/project/copy')
    await wrapper.get('.set-nav-item[data-page="general"]').trigger('click')
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
  })

  it('search finds "Font" across pages, with its page name; clearing it goes back', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    await wrapper.get('input[type="search"]').setValue('font')
    await settle()
    expect(visiblePages(wrapper)).toContain('terminal')
    expect(visiblePages(wrapper)).not.toContain('updates')
    const font = wrapper.get('#settings-font').element
    expect(shown(font)).toBe(true)
    expect(shown(wrapper.get('#settings-font-weight-bold').element)).toBe(true)
    expect(wrapper.get('#set-terminal h2').text()).toBe('Terminal')
    // Rows that don't match are hidden, even on the matching page.
    expect(shown(wrapper.get('[aria-labelledby="settings-cursor-label"]').element)).toBe(false)
    expect(wrapper.find('.set-nav-item[aria-current]').exists()).toBe(false)

    await wrapper.get('input[type="search"]').setValue('zzqx')
    await settle()
    expect(visiblePages(wrapper)).toEqual([])
    expect(wrapper.get('.set-empty').text()).toMatch(/No settings match/)

    await wrapper.get('input[type="search"]').setValue('')
    await settle()
    expect(visiblePages(wrapper)).toEqual(['general'])
    expect(wrapper.findAll('[data-sh]')).toHaveLength(0) // nothing the search hid stays hidden
    await wrapper.get('.set-nav-item[data-page="terminal"]').trigger('click')
    expect(shown(wrapper.get('[aria-labelledby="settings-cursor-label"]').element)).toBe(true)
  })

  it('the sidebar groups the pages; a search says how many rows it shows', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(wrapper.findAll('.set-nav-head').map((h) => h.text())).toEqual(['AI', 'Workspace', 'Workflows', 'Insights', 'About'])
    expect(wrapper.find('.set-count').exists()).toBe(false)
    await wrapper.get('input[type="search"]').setValue('cursor opacity')
    await settle()
    expect(visiblePages(wrapper)).toEqual(['terminal'])
    expect(wrapper.get('.set-count').text()).toBe('1 result')
    await wrapper.get('input[type="search"]').setValue('font')
    await settle()
    expect(wrapper.get('.set-count').text()).toMatch(/^\d+ results$/)
    await wrapper.get('input[type="search"]').setValue('zzqx')
    await settle()
    expect(wrapper.find('.set-count').exists()).toBe(false)
  })

  it('Ctrl+F focuses the search; Escape there empties it before closing', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    const search = wrapper.get('input[type="search"]')
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(search.element)
    await search.setValue('theme')
    await search.trigger('keydown', { key: 'Escape' })
    expect(search.element.value).toBe('')
    expect(wrapper.emitted('close')).toBeUndefined()
    await search.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
