import { setSelectValue, selectOptions } from './selectTestUtils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import AutomationsPage from '../components/AutomationsPage.vue'
import { applySnapshot } from '../automationsStore'

const flush = async () => {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((r) => setTimeout(r, 0))
}

function mountPage({ yolo = false, confirm = true, snapshot = null, sig = 'p1:sig:1', list = null } = {}) {
  const api = {
    list: list || vi.fn(async () => snapshot || { loaded: true, automations: [], runs: [], settings: { maxConcurrent: 2 } }),
    create: vi.fn(async (input) => ({ ok: true, automation: { id: 'auto-1', ...input } })),
    update: vi.fn(async () => ({ ok: true })),
    setEnabled: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    runNow: vi.fn(async () => ({ ok: true, run: { id: 'run-1' } })),
    setSettings: vi.fn(async () => ({ ok: true })),
    onChanged: () => () => {}
  }
  window.shellApi = { automations: api }
  const askConfirm = vi.fn(async () => confirm)
  const ctx = {
    projects: computed(() => [
      { wsId: 'ws-1', name: 'App', cwd: 'C:\\code\\app', remote: null, hostLabel: '' },
      { wsId: 'ws-2', name: 'Server', cwd: null, remote: { hostId: 'h1', path: '/srv' }, hostLabel: 'box' }
    ]),
    agents: computed(() => [{ id: 'claude', name: 'Claude Code', available: true }]),
    permissions: () => (yolo ? { yolo: true, args: '--dangerously-skip-permissions', ownArgs: false, sig } : { yolo: false, args: '', ownArgs: false, sig }),
    paneOpen: (id) => id === 'pane-1',
    cardOpen: () => false,
    showPane: vi.fn(),
    showCard: vi.fn(),
    openAgentSettings: vi.fn()
  }
  const wrapper = mount(AutomationsPage, { global: { provide: { automations: ctx, askConfirm } }, attachTo: document.body })
  return { wrapper, api, askConfirm, ctx }
}

describe('Settings > Automations', () => {
  let wrapper
  beforeEach(() => applySnapshot({ loaded: true, automations: [], runs: [], settings: { maxConcurrent: 2 } }))
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('says that runs happen only while Tessel is open, and shows the empty state', async () => {
    const m = mountPage()
    wrapper = m.wrapper
    await flush()
    expect(wrapper.get('[data-test="au-only-open"]').text()).toMatch(/only while Tessel is open/)
    expect(wrapper.find('[data-test="au-empty"]').exists()).toBe(true)
    // How they work is open while there is none; the limit is in a card.
    expect(wrapper.find('.au-how-fold').exists()).toBe(false)
    expect(wrapper.get('[data-test="au-max"]').element.closest('.set-card')).not.toBeNull()
  })

  it('the editor is a dialog over the page, made of Settings rows and switches; nothing is said in orange before you type', async () => {
    const m = mountPage()
    wrapper = m.wrapper
    await flush()
    await wrapper.get('[data-test="au-new"]').trigger('click')
    await flush()
    const dialog = wrapper.get('[role="dialog"][data-test="automation-editor"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(wrapper.get('.au-body').attributes('inert')).toBeDefined()
    // No native checkbox or time input; its switches are Settings' own.
    expect(dialog.findAll('input[type="time"]')).toHaveLength(0)
    for (const box of dialog.findAll('input[type="checkbox"]')) expect(box.classes()).toContain('set-switch')
    expect(dialog.find('.au-label').exists()).toBe(false)
    // What is missing is a plain hint; Create waits for it.
    expect(dialog.find('[data-test="au-error"]').exists()).toBe(false)
    expect(dialog.get('[data-test="au-missing"]').text()).toMatch(/name/)
    expect(dialog.get('[data-test="au-save"]').element.disabled).toBe(true)
    await wrapper.get('[data-test="au-name"]').setValue('Nightly')
    await wrapper.get('[data-test="au-prompt"]').setValue('Do it')
    expect(dialog.find('[data-test="au-missing"]').exists()).toBe(false)
    expect(dialog.get('[data-test="au-save"]').element.disabled).toBe(false)
    // The time of day is a select of the shared look.
    await setSelectValue(wrapper.get('[data-test="au-time"]'), '07:30')
    expect(wrapper.get('[data-test="au-next"]').text()).toMatch(/Daily at 7:30/)
    // Escape closes it.
    await dialog.trigger('keydown', { key: 'Escape' })
    await flush()
    expect(wrapper.find('[data-test="automation-editor"]').exists()).toBe(false)
    expect(wrapper.get('.au-body').attributes('inert')).toBeUndefined()
  })

  it('creates one from a template, with your confirmation that it may run unattended (Yolo shown)', async () => {
    const m = mountPage({ yolo: true })
    wrapper = m.wrapper
    await flush()
    await wrapper.get('[data-test="au-new"]').trigger('click')
    await setSelectValue(wrapper.get('[data-test="au-template"]'), 'repo-health-weekday')
    await flush()
    expect(wrapper.get('[data-test="au-name"]').element.value).toBe('Weekday repo audit')
    expect(wrapper.get('[data-test="au-yolo"]').text()).toMatch(/--dangerously-skip-permissions/)
    expect(wrapper.get('[data-test="au-next"]').text()).toMatch(/Weekdays at/)
    await wrapper.get('[data-test="automation-editor"]').trigger('submit')
    await flush()
    expect(m.askConfirm).toHaveBeenCalledTimes(1)
    expect(m.askConfirm.mock.calls[0][0].text).toMatch(/Yolo is on/)
    expect(m.api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Weekday repo audit',
        agentId: 'claude',
        wsId: 'ws-1',
        projectCwd: 'C:\\code\\app',
        isolation: 'worktree',
        schedule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
        missedRunGraceMinutes: 720,
        confirmed: true,
        confirmSig: 'p1:sig:1',
        enabled: true
      })
    )
  })

  it('not confirmed: nothing is saved', async () => {
    const m = mountPage({ confirm: false })
    wrapper = m.wrapper
    await flush()
    await wrapper.get('[data-test="au-new"]').trigger('click')
    await wrapper.get('[data-test="au-name"]').setValue('X')
    await wrapper.get('[data-test="au-prompt"]').setValue('Do it')
    await wrapper.get('[data-test="automation-editor"]').trigger('submit')
    await flush()
    expect(m.api.create).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test="au-error"]').text()).toMatch(/confirmation/)
  })

  it('a remote project runs in its folder only; a custom cron is checked', async () => {
    const m = mountPage()
    wrapper = m.wrapper
    await flush()
    await wrapper.get('[data-test="au-new"]').trigger('click')
    await setSelectValue(wrapper.get('[data-test="au-project"]'), 'ws-2')
    await flush()
    expect(wrapper.get('[data-test="au-worktree"]').element.disabled).toBe(true)
    await setSelectValue(wrapper.get('[data-test="au-preset"]'), 'custom')
    await wrapper.get('[data-test="au-cron"]').setValue('*/90 * * * *')
    await flush()
    expect(wrapper.find('[data-test="au-cron-invalid"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="au-save"]').element.disabled).toBe(true)
  })

  it('lists automations with their history; Run Now asks first for one never confirmed', async () => {
    const now = Date.now()
    const snapshot = {
      loaded: true,
      settings: { maxConcurrent: 2 },
      automations: [
        { id: 'auto-1', name: 'Nightly', prompt: 'p', agentId: 'claude', wsId: 'ws-1', projectName: 'App', isolation: 'project', schedule: '0 9 * * 1-5', enabled: false, confirmedAt: null, nextRunAt: now + 3600_000, missedRunGraceMinutes: 720, after: { notify: true } }
      ],
      runs: [
        { id: 'run-2', automationId: 'auto-1', runNumber: 2, trigger: 'scheduled', status: 'skipped_missed', errorCode: 'missed', scheduledFor: now - 1000, createdAt: now - 1000 },
        { id: 'run-1', automationId: 'auto-1', runNumber: 1, trigger: 'manual', status: 'dispatched', paneId: 'pane-1', scheduledFor: now - 5000, createdAt: now - 5000 }
      ]
    }
    const m = mountPage({ snapshot, confirm: true })
    wrapper = m.wrapper
    await flush()
    expect(wrapper.text()).toMatch(/Weekdays at/)
    // Its actions are in its details, not on the row.
    expect(wrapper.find('[data-test="au-run-now"]').exists()).toBe(false)
    // Once there is one, how they work folds away.
    expect(wrapper.get('.au-how-fold').attributes('open')).toBeUndefined()
    await wrapper.get('.sl-row').trigger('click')
    await flush()
    expect(wrapper.get('[data-test="au-delete"]').classes()).toContain('danger')
    expect(wrapper.findAll('[data-run]')).toHaveLength(2)
    expect(wrapper.text()).toMatch(/past its missed-run grace/)
    await wrapper.get('[data-test="au-show-pane"]').trigger('click')
    expect(m.ctx.showPane).toHaveBeenCalledWith('pane-1')
    // A run is going: Run Now waits.
    expect(wrapper.get('[data-test="au-run-now"]').element.disabled).toBe(true)
    await wrapper.get('[data-test="au-toggle"]').trigger('change')
    await flush()
    expect(m.askConfirm).toHaveBeenCalled()
    expect(m.api.setEnabled).toHaveBeenCalledWith('auto-1', true, true, 'p1:sig:1')
  })

  // Review 6: the agent's permissions changed since it was confirmed.
  it('says an automation needs a new confirmation, and asks before Run Now', async () => {
    const now = Date.now()
    const base = { id: 'auto-2', name: 'Weekly', prompt: 'p', agentId: 'claude', wsId: 'ws-1', projectName: 'App', projectCwd: 'C:\\code\\app', isolation: 'project', schedule: '0 9 * * 1', enabled: true, confirmedAt: now - 1000, confirmedSig: 'p1:old:1', nextRunAt: now + 3600_000, missedRunGraceMinutes: 720, after: { notify: true } }
    const m = mountPage({ snapshot: { loaded: true, settings: { maxConcurrent: 2 }, automations: [base], runs: [] }, sig: 'p1:new:2' })
    wrapper = m.wrapper
    await flush()
    expect(wrapper.find('[data-test="au-needs-confirm"]').exists()).toBe(true)
    await wrapper.get('.sl-row').trigger('click')
    await wrapper.get('[data-test="au-run-now"]').trigger('click')
    await flush()
    expect(m.askConfirm).toHaveBeenCalledTimes(1)
    expect(m.api.runNow).toHaveBeenCalledWith('auto-2', true, 'p1:new:2')
  })

  it('editing its prompt asks for a new confirmation; renaming does not', async () => {
    const now = Date.now()
    const base = { id: 'auto-3', name: 'Daily', prompt: 'p', agentId: 'claude', wsId: 'ws-1', projectName: 'App', projectCwd: 'C:\\code\\app', remote: null, isolation: 'project', schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', enabled: true, confirmedAt: now - 1000, confirmedSig: 'p1:sig:1', nextRunAt: now + 3600_000, missedRunGraceMinutes: 720, after: { notify: true, closePane: false } }
    const m = mountPage({ snapshot: { loaded: true, settings: { maxConcurrent: 2 }, automations: [base], runs: [] } })
    wrapper = m.wrapper
    await flush()
    await wrapper.get('.sl-row').trigger('click')
    await wrapper.get('[data-test="au-edit"]').trigger('click')
    await wrapper.get('[data-test="au-name"]').setValue('Daily 2')
    await wrapper.get('[data-test="automation-editor"]').trigger('submit')
    await flush()
    expect(m.askConfirm).not.toHaveBeenCalled()
    await wrapper.get('[data-test="au-edit"]').trigger('click')
    await wrapper.get('[data-test="au-prompt"]').setValue('Do something else')
    await wrapper.get('[data-test="automation-editor"]').trigger('submit')
    await flush()
    expect(m.askConfirm).toHaveBeenCalledTimes(1)
  })

  it('Delete asks first, as a danger', async () => {
    const now = Date.now()
    const base = { id: 'auto-4', name: 'Weekly', prompt: 'p', agentId: 'claude', wsId: 'ws-1', projectName: 'App', projectCwd: 'C:\\code\\app', isolation: 'project', schedule: '0 9 * * 1', enabled: true, confirmedAt: now - 1000, confirmedSig: 'p1:sig:1', nextRunAt: now + 3600_000, missedRunGraceMinutes: 720, after: { notify: true } }
    const m = mountPage({ snapshot: { loaded: true, settings: { maxConcurrent: 2 }, automations: [base], runs: [] }, confirm: false })
    wrapper = m.wrapper
    await flush()
    await wrapper.get('.sl-row').trigger('click')
    await wrapper.get('[data-test="au-delete"]').trigger('click')
    await flush()
    expect(m.askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(m.api.remove).not.toHaveBeenCalled()
  })

  it('while loading: placeholder rows; a failed load: the error with Retry, never an empty list', async () => {
    applySnapshot({ loaded: false, automations: [], runs: [], settings: { maxConcurrent: 2 } })
    let answer
    const m = mountPage({ list: vi.fn(() => new Promise((r) => (answer = r))) })
    wrapper = m.wrapper
    await flush()
    expect(wrapper.findAll('.sl-skeleton').length).toBeGreaterThan(0)
    expect(wrapper.find('[data-test="au-empty"]').exists()).toBe(false)
    answer({ loaded: true, automations: [], runs: [], settings: { maxConcurrent: 2 } })
    await flush()
    expect(wrapper.find('.sl-skeleton').exists()).toBe(false)
    expect(wrapper.find('[data-test="au-empty"]').exists()).toBe(true)
    wrapper.unmount()
    applySnapshot({ loaded: false, automations: [], runs: [], settings: { maxConcurrent: 2 } })
    const failing = mountPage({ list: vi.fn(async () => { throw new Error('EACCES: automations.json') }) })
    wrapper = failing.wrapper
    await flush()
    expect(wrapper.get('[data-test="panel-error-text"]').text()).toBe('Automations could not be loaded.')
    expect(wrapper.find('[data-test="au-empty"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('EACCES')
  })
})
