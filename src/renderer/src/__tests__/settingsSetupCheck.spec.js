// Settings > General > Setup check: what Tessel needs (main's tesselNeeds.js),
// the problems only, each with a button that fixes it, then "n checks OK".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'
import { setUiLanguage } from '../i18n'
import { assessNeeds } from '../../../main/tesselNeeds'

const visiblePages = (w) => w.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))

// The main process's own rows: a fresh machine with Node.js only.
const freshRows = () =>
  assessNeeds({
    node: { path: 'C:\\node.exe', version: 'v22.19.0' },
    git: { path: 'C:\\git.exe', configured: false },
    uvx: false,
    agents: [{ id: 'claude', name: 'Claude Code', available: true }],
    claudeVersion: '2.1.100',
    script: { exists: false },
    hooks: { agents: [{ id: 'claude', hooks: 'missing' }] }
  })

describe('Settings > General > Setup check', { timeout: 30_000 }, () => {
  let wrapper, previousApi, api

  const mountGeneral = () => {
    wrapper = mount(SettingsDialog, { props: { section: 'general' }, attachTo: document.body })
  }
  const card = () => wrapper.get('[data-test="setup-check"]')

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    api = {
      tesselNeeds: vi.fn(async () => ({ ok: true, rows: freshRows() })),
      installTeamTools: vi.fn(async () => ({ errors: [] }))
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

  it('sits first on General, says it is checking, then lists only the problems', async () => {
    let answer
    api.tesselNeeds = vi.fn(() => new Promise((r) => (answer = r)))
    mountGeneral()
    const groups = wrapper.findAll('#set-general > .set-group')
    expect(groups[0].attributes('data-test')).toBe('setup-check')
    expect(card().find('[data-test="setup-loading"]').exists()).toBe(true)
    expect(card().text()).not.toContain('OK')
    answer({ ok: true, rows: freshRows() })
    await flushPromises()
    const problems = card().findAll('.setup-problem').map((r) => r.attributes('data-need'))
    expect(problems).toEqual(['team-tools', 'hooks', 'claude-inbox', 'git'])
    // Node.js and the agent are fine; uv is optional, behind Show all.
    expect(card().get('[data-test="setup-ok"]').text()).toContain('2 checks OK')
    expect(card().get('[data-test="setup-ok"]').text()).toContain('1 optional')
    expect(card().get('.setup-all').element.open).toBe(false)
    expect(card().get('.setup-all').text()).toContain('uv (uvx)')
    // A real button on each problem, never the old "Fix: Tools > …" text.
    expect(card().text()).not.toMatch(/Fix:|Tools >/)
    for (const id of problems) expect(card().find(`[data-fix="${id}"]`).exists()).toBe(true)
  })

  it('each button does the fix: set up the team tools, update Claude Code, set git’s name, install', async () => {
    mountGeneral()
    await flushPromises()
    expect(card().get('[data-fix="team-tools"]').text()).toBe('Set up')
    await card().get('[data-fix="team-tools"]').trigger('click')
    await flushPromises()
    expect(api.installTeamTools).toHaveBeenCalledTimes(1)
    expect(api.tesselNeeds).toHaveBeenCalledTimes(2) // checked again after
    await card().get('[data-fix="claude-inbox"]').trigger('click')
    expect(wrapper.emitted('update-agent')).toEqual([['claude']])
    await card().get('[data-fix="git"]').trigger('click')
    expect(wrapper.emitted('run-job')[0][0]).toMatchObject({ label: 'Set name & email', shell: 'powershell' })
    expect(wrapper.emitted('run-job')[0][0].command).toContain('git config --global user.name')
    await card().get('.setup-all [data-check="uvx"] .exit-btn').trigger('click')
    expect(wrapper.emitted('run-job')[1][0]).toMatchObject({ label: 'Install uv' })
    expect(wrapper.emitted('run-job')[1][0].command).toContain('astral-sh.uv')
  })

  it('no agent: Install an agent opens Settings > Agents; hooks without an install: Orchestration', async () => {
    api.tesselNeeds = vi.fn(async () => ({
      ok: true,
      rows: assessNeeds({ node: { path: 'n', version: 'v22.0.0' }, git: { path: 'g', configured: true }, uvx: true, agents: [], script: { exists: true, version: '1' }, hooks: { error: 'boom' } })
    }))
    mountGeneral()
    await flushPromises()
    await card().get('[data-fix="agents"]').trigger('click')
    expect(visiblePages(wrapper)).toEqual(['agents'])
    await wrapper.get('.set-nav-item[data-page="general"]').trigger('click')
    await card().get('[data-fix="hooks"]').trigger('click')
    expect(visiblePages(wrapper)).toEqual(['orchestration'])
  })

  it('everything fine: one line, all checks OK', async () => {
    api.tesselNeeds = vi.fn(async () => ({
      ok: true,
      rows: [
        { id: 'node', name: 'Node.js', why: 'x', status: 'ok', detail: 'v22', fix: null },
        { id: 'git', name: 'Git', why: 'y', status: 'ok', detail: 'ok', fix: null }
      ]
    }))
    mountGeneral()
    await flushPromises()
    expect(card().findAll('.setup-problem')).toHaveLength(0)
    expect(card().get('[data-test="setup-ok"]').text()).toContain('All 2 checks OK')
  })

  it('a check that fails says so in words, the raw error behind Details, with Retry', async () => {
    api.tesselNeeds = vi.fn().mockRejectedValueOnce(new Error('spawn cmd.exe ENOENT')).mockResolvedValue({ ok: true, rows: freshRows() })
    mountGeneral()
    await flushPromises()
    const err = card().get('[data-test="setup-error"]')
    expect(err.text()).toContain('could not check its setup')
    expect(err.get('details').element.open).toBe(false)
    expect(err.get('details').text()).toContain('ENOENT')
    await err.get('button').trigger('click')
    await flushPromises()
    expect(card().find('[data-test="setup-error"]').exists()).toBe(false)
    expect(card().findAll('.setup-problem').length).toBeGreaterThan(0)
  })

  it('is read only once General shows, and not at all without the API', async () => {
    wrapper = mount(SettingsDialog, { props: { section: 'agents' }, attachTo: document.body })
    await flushPromises()
    expect(api.tesselNeeds).not.toHaveBeenCalled()
    await wrapper.get('.set-nav-item[data-page="general"]').trigger('click')
    await flushPromises()
    expect(api.tesselNeeds).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    window.shellApi = {}
    mountGeneral()
    await flushPromises()
    expect(wrapper.find('[data-test="setup-check"]').exists()).toBe(false)
  })

  it('in French', async () => {
    await setUiLanguage('fr')
    mountGeneral()
    await flushPromises()
    expect(card().text()).toContain('Vérification de la configuration')
    expect(card().get('[data-test="setup-ok"]').text()).toContain('2 vérifications OK')
    expect(card().get('[data-fix="team-tools"]').text()).toBe('Configurer')
  })
})
