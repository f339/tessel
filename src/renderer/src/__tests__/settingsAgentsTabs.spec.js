// Settings > Agents in three tabs (Installed, Permissions, Behavior): every
// tab stays in the page for the search, the agents not installed fold under
// their own heading without a switch, your own agents are added and removed
// there, and an update's raw error waits behind a disclosure.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'
import { setUiLanguage } from '../i18n'

const agents = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', available: true },
  { id: 'aider', name: 'Aider', command: 'aider', available: false, install: ['pip install aider-chat'] },
  { id: 'goose', name: 'Goose', available: false, install: null, docsUrl: 'https://goose-docs.ai' }
]
const settle = async () => {
  await nextTick()
  await nextTick()
}

describe('Settings > Agents tabs', { timeout: 30_000 }, () => {
  let wrapper, previousApi, confirms

  const mountAt = (props = {}) => {
    wrapper = mount(SettingsDialog, {
      props: { agents, section: 'agents', ...props },
      global: { provide: { askConfirm: async (o) => (confirms.push(o), true) } },
      attachTo: document.body
    })
  }
  const page = () => wrapper.get('#set-agents')
  const tabs = () => wrapper.findAll('#set-agents [role="tab"]')

  beforeEach(() => {
    resetSettings()
    settings.agentPrefs = {}
    settings.customAgents = []
    confirms = []
    previousApi = window.shellApi
    window.shellApi = {}
  })
  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    settings.customAgents = []
    resetSettings()
    window.shellApi = previousApi
    await setUiLanguage('en')
  })

  it('opens on Installed; a tab or the arrow keys show another, the others stay in the page', async () => {
    mountAt()
    expect(tabs().map((b) => b.text())).toEqual(['Installed2', 'Permissions', 'Behavior'])
    expect(page().attributes('data-tab')).toBe('installed')
    expect(tabs()[0].attributes('aria-selected')).toBe('true')
    // Every tab's settings are rendered (CSS hides the others).
    expect(wrapper.find('[data-setting="agentFolderTrust"]').exists()).toBe(true)
    expect(wrapper.find('#settings-default-agent').exists()).toBe(true)
    expect(wrapper.get('[data-setting="agentFolderTrust"]').element.closest('[data-tab]').dataset.tab).toBe('permissions')
    expect(wrapper.get('#settings-default-agent').element.closest('[data-tab]').dataset.tab).toBe('behavior')
    expect(wrapper.get('[data-test="settings-agent-terminal"]').attributes('data-tab')).toBe('permissions')

    await tabs()[1].trigger('click')
    expect(page().attributes('data-tab')).toBe('permissions')
    await wrapper.get('#set-agents [role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(page().attributes('data-tab')).toBe('behavior')
    await wrapper.get('#set-agents [role="tablist"]').trigger('keydown', { key: 'Home' })
    expect(page().attributes('data-tab')).toBe('installed')
  })

  it('a search shows its matches from every tab, without the tab bar', async () => {
    mountAt()
    await wrapper.get('.set-search input').setValue('trust the folder')
    await settle()
    expect(page().attributes('data-tab')).toBeUndefined()
    expect(wrapper.get('#set-agents [role="tablist"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-setting="agentFolderTrust"]').element.closest('[hidden]')).toBeNull()
    await wrapper.get('.set-search input').setValue('aider')
    await settle()
    // A folded agent shows while the search finds it.
    expect(wrapper.get('[data-agent="aider"]').element.closest('[hidden]')).toBeNull()
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(true)
    await wrapper.get('.set-search input').setValue('')
    await settle()
    expect(page().attributes('data-tab')).toBe('installed')
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(false)
  })

  it('Settings opened on the terminals or the agents to install shows that tab', async () => {
    mountAt({ anchor: 'set-agent-terminal' })
    expect(page().attributes('data-tab')).toBe('permissions')
    wrapper.unmount()
    mountAt({ anchor: 'set-agents-missing' })
    expect(page().attributes('data-tab')).toBe('installed')
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(true)
  })

  it('the agents not installed fold under their heading: Install, no menu switch', async () => {
    mountAt()
    const toggle = wrapper.get('[data-test="agents-missing-toggle"]')
    expect(toggle.text()).toBe('Not installed (2)')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(false)
    await toggle.trigger('click')
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(true)
    for (const id of ['aider', 'goose']) expect(wrapper.find(`[data-agent="${id}"] .set-switch`).exists()).toBe(false)
    for (const id of ['claude', 'codex']) expect(wrapper.find(`[data-agent="${id}"] .set-switch`).exists()).toBe(true)
    await wrapper.get('[data-agent="aider"] [data-test="agent-install"]').trigger('click')
    expect(wrapper.emitted('install-agent')[0][0].id).toBe('aider')
  })

  it('with no agent installed, the list says so and the agents to install are unfolded', async () => {
    mountAt({ agents: agents.map((a) => ({ ...a, available: false })) })
    expect(wrapper.get('[data-test="agents-empty"]').text()).toContain('No agent found')
    expect(wrapper.get('#agents-missing-list').isVisible()).toBe(true)
  })

  it('an update that failed: a warning tag on the row, the raw error behind Details', async () => {
    const failed = { agentId: 'codex', name: 'Codex CLI', at: Date.now(), ok: false, kind: 'in-use', from: '0.8.0', to: '0.9.0', detail: "EBUSY: resource busy or locked, rename 'C:\\npm\\codex'", file: 'C:\\logs\\u.log' }
    mountAt({
      agentUpdates: { checkedAt: Date.now(), agents: { codex: { installed: '0.8.0', latest: '0.9.0', update: true } } },
      agentUpdateHistory: { entries: [failed], last: { codex: failed } }
    })
    const row = wrapper.get('[data-agent="codex"]')
    expect(row.get('.sl-row').text()).toContain('0.8.0')
    expect(row.get('.sl-row').text()).toContain('Update available')
    expect(row.get('.sl-row').text()).toContain('Update failed')
    const raw = row.get('.agent-update-raw')
    expect(raw.element.tagName).toBe('DETAILS')
    expect(raw.element.open).toBe(false)
    expect(raw.text()).toContain('EBUSY')
    expect(row.get('.agent-update-result').text()).not.toContain('EBUSY')
    expect(wrapper.get('[data-test="update-all-agents"]').text()).toBe('Update all (1)')
  })

  it('Escape in an open agent folds its details, not Settings', async () => {
    mountAt()
    const row = wrapper.get('[data-agent="claude"]')
    await row.get('.sl-row').trigger('click')
    expect(row.get('.sl-details').isVisible()).toBe(true)
    await row.get('.agent-custom input').trigger('keydown', { key: 'Escape' })
    expect(row.get('.sl-details').isVisible()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('your own agent: added with a swatch color (no native color input), then removed after asking', async () => {
    mountAt()
    const form = wrapper.get('[data-test="custom-agent-form"]')
    expect(form.find('input[type="color"]').exists()).toBe(false)
    await form.trigger('submit')
    expect(form.text()).toContain('Enter a name and the command')
    const [name, command] = form.findAll('input')
    await name.setValue('Crush')
    await command.setValue('crush --yolo')
    const swatches = form.findAll('[role="radio"]')
    expect(swatches.length).toBeGreaterThan(4)
    await swatches[5].trigger('click')
    expect(swatches[5].attributes('aria-checked')).toBe('true')
    await form.trigger('submit')
    expect(settings.customAgents).toHaveLength(1)
    expect(settings.customAgents[0]).toMatchObject({ name: 'Crush', command: 'crush --yolo', accent: '#5b8def' })
    expect(wrapper.emitted('detect-agents')).toHaveLength(1)
    // The same name again: refused.
    await name.setValue('crush')
    await command.setValue('crush')
    await form.trigger('submit')
    expect(form.text()).toContain('already exists')
    expect(settings.customAgents).toHaveLength(1)

    // Detected (App reloads the agents): it joins the list, tagged Yours, with Remove.
    const id = settings.customAgents[0].id
    await wrapper.setProps({ agents: [...agents, { id, name: 'Crush', command: 'crush --yolo', custom: true, available: true, accent: '#5b8def' }] })
    const row = wrapper.get(`[data-agent="${id}"]`)
    expect(row.get('.sl-row').text()).toContain('Yours')
    await row.get('[data-test="custom-agent-remove"]').trigger('click')
    await flushPromises()
    expect(confirms).toHaveLength(1)
    expect(confirms[0].danger).toBe(true)
    expect(settings.customAgents).toHaveLength(0)
  })

  it('shows the tabs and the folded agents in French', async () => {
    await setUiLanguage('fr')
    mountAt()
    await settle()
    expect(tabs().map((b) => b.text())).toEqual(['Installés2', 'Autorisations', 'Comportement'])
    expect(wrapper.get('[data-test="agents-missing-toggle"]').text()).toBe('Non installés (2)')
  })
})
