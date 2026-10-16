// Settings > Developer tools (once the Install tools window): one row per
// tool, found or installed with winget in a pane, with its setup step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'
import { setUiLanguage } from '../i18n'
import { DEV_TOOLS } from '../toolsCatalog'

const visiblePages = (w) => w.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))

describe('Settings > Developer tools', { timeout: 30_000 }, () => {
  let wrapper, previousApi, api

  beforeEach(() => {
    resetSettings()
    try {
      localStorage.clear()
    } catch {
      // no storage
    }
    previousApi = window.shellApi
    api = {
      refreshPath: vi.fn(async () => ({ ok: true })),
      checkTools: vi.fn(async () => ({ git: true, gh: true, node: true })),
      toolStatus: vi.fn(async () => ({ gh: { signedIn: true, account: 'alexmartin' }, git: { configured: false } }))
    }
    window.shellApi = api
  })
  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    window.shellApi = previousApi
    resetSettings()
    await setUiLanguage('en')
  })

  it('is a Workflows page after Git; the rows are there before anything is checked', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    const workflows = wrapper.findAll('.set-nav-group')[2]
    expect(workflows.findAll('.set-nav-item').map((b) => b.attributes('data-page')).slice(0, 2)).toEqual(['git', 'devtools'])
    expect(wrapper.findAll('#set-devtools [data-tool]').map((r) => r.attributes('data-tool'))).toEqual(DEV_TOOLS.map((t) => t.id))
    // Not open: nothing asked of the main process yet.
    await flushPromises()
    expect(api.checkTools).not.toHaveBeenCalled()
  })

  it('opening it checks the tools: Installed, Install, and the setup steps', async () => {
    wrapper = mount(SettingsDialog, { props: { section: 'devtools' }, attachTo: document.body })
    await flushPromises()
    expect(api.checkTools).toHaveBeenCalledTimes(1)
    const row = (id) => wrapper.get(`#set-devtools [data-tool="${id}"]`)
    expect(row('node').text()).toContain('Installed')
    expect(row('jq').text()).toContain('Not installed')
    expect(wrapper.get('#set-devtools .dt-summary').text()).toBe(`3 of ${DEV_TOOLS.length} installed`)
    // git: installed, no name yet -> its setup step; gh: signed in -> Switch account.
    expect(row('git').get('[data-setup="git"]').text()).toContain('No name and email')
    expect(row('git').get('.dt-actions .exit-btn').text()).toBe('Set name & email')
    expect(row('gh').get('[data-setup="gh"]').text()).toBe('Signed in as alexmartin')
    expect(row('gh').get('.dt-actions .exit-btn').text()).toBe('Switch account')

    await row('jq').get('[data-install="jq"]').trigger('click')
    expect(wrapper.emitted('run-job')[0][0]).toMatchObject({ label: 'Install jq' })
    expect(wrapper.emitted('run-job')[0][0].command).toContain('jqlang.jq')
    await row('git').get('.dt-actions .exit-btn').trigger('click')
    expect(wrapper.emitted('run-job')[1][0]).toMatchObject({ label: 'Set name & email', shell: 'powershell' })
  })

  it('a failed check says so with Retry, the raw error behind Details', async () => {
    api.checkTools = vi.fn().mockRejectedValueOnce(new Error('where.exe failed')).mockResolvedValue({ git: true })
    wrapper = mount(SettingsDialog, { props: { section: 'devtools' }, attachTo: document.body })
    await flushPromises()
    const err = wrapper.get('[data-test="devtools-error"]')
    expect(err.text()).toContain('could not check which tools are installed')
    expect(err.get('details').element.open).toBe(false)
    await err.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="devtools-error"]').exists()).toBe(false)
    expect(wrapper.get('#set-devtools [data-tool="git"]').text()).toContain('Installed')
  })

  it('the search finds a tool by name; the page by its English title in French', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    await wrapper.get('.set-search input').setValue('ripgrep')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toEqual(['devtools'])
    expect(wrapper.get('[data-tool="rg"]').element.closest('[hidden]')).toBeNull()
    expect(wrapper.get('[data-tool="git"]').element.closest('[hidden]')).not.toBeNull()
    await setUiLanguage('fr')
    await wrapper.get('.set-search input').setValue('developer tools')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toContain('devtools')
    expect(wrapper.get('.set-nav-item[data-page="devtools"]').text()).toBe('Outils de développement')
  })
})
