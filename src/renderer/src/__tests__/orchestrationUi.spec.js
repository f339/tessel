// Orchestration in the interface: worker rows in Sessions (linked to their
// coordinator), the Tasks panel's orchestration card, Settings > Orchestration.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import OrchestrationCard from '../components/OrchestrationCard.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings, loadSettings, DEFAULT_SETTINGS } from '../settings'
import { _resetFeedsForTest } from '../agentChildrenFeed'
import { ORCHESTRATION_TOOLS } from '../orchestrationGuide'

const NOW = Date.now()
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'codex', state: 'ready', team: 'tm1', ...extra })

let mounted = []
beforeEach(() => {
  resetSettings()
  settings.sidebarSortBy = 'manual'
  window.shellApi = {}
})
afterEach(() => {
  for (const w of mounted) {
    try {
      w.unmount()
    } catch {
      // already unmounted
    }
  }
  mounted = []
  document.body.innerHTML = ''
  _resetFeedsForTest()
  resetSettings()
})

describe('Sessions: worker rows', () => {
  function mountSidebar() {
    const w = mount(WorkspaceSidebar, {
      props: {
        projects: [
          {
            id: 'ws1',
            name: 'Shop',
            cwd: 'C:\\repo',
            branch: 'main',
            // The worker alone on the card (several agents fold into a summary).
            panes: [pane('wk', { num: 5, title: 'Codex', workerOf: { id: 'lead', label: 'Ada', num: 1, status: 'running' } })],
            copies: []
          }
        ],
        currentId: 'ws1',
        ports: {},
        now: NOW,
        teams: [{ id: 'tm1', name: 'Team 1' }]
      },
      attachTo: document.body
    })
    mounted.push(w)
    return w
  }

  it('a worker is marked as the worker of its coordinator; the mark goes to the coordinator', async () => {
    const w = mountSidebar()
    const row = w.find('.compact-agent-row[data-pane-id="wk"]')
    const tag = row.find('[data-worker-of]')
    expect(tag.text()).toBe('worker of Ada')
    expect(row.attributes('aria-label')).toContain('Worker of Ada: go to it')
    await tag.trigger('click')
    expect(w.emitted('focus-pane').at(-1)).toEqual(['lead'])
    // The row itself still goes to the worker.
    await row.trigger('click')
    expect(w.emitted('focus-pane').at(-1)).toEqual(['wk'])
  })

  it("the row's hover card says whose worker it is", async () => {
    vi.useFakeTimers()
    try {
      const w = mountSidebar()
      await w.find('.compact-agent-row[data-pane-id="wk"]').trigger('pointerover')
      vi.advanceTimersByTime(300)
      await nextTick()
      await nextTick()
      const card = document.querySelector('.agent-hover-card [data-hover-worker]')
      expect(card && card.textContent).toBe('Worker of Ada')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Tasks panel: the orchestration card', () => {
  function mountCard(view, actions = {}) {
    const calls = []
    const orch = {
      view: ref(view),
      allow: (team, id) => calls.push(['allow', team, id]),
      refuse: (team, id) => calls.push(['refuse', team, id]),
      stop: (team, id) => calls.push(['stop', team, id]),
      focus: (id) => calls.push(['focus', id]),
      ...actions
    }
    const w = mount(OrchestrationCard, { props: { workspaceId: 'ws1' }, global: { provide: { orchestration: orch } } })
    mounted.push(w)
    return { w, calls }
  }
  const team = (workers) => ({
    teamId: 'tm1',
    wsId: 'ws1',
    name: 'Team 1',
    color: '#6c9cff',
    limits: { maxConcurrent: 4, maxDepth: 1, confirm: true },
    coordinators: [{ id: 'lead', label: 'Ada', phase: 'dispatching' }],
    workers,
    running: workers.filter((x) => ['running', 'starting'].includes(x.status)).length,
    waiting: workers.filter((x) => ['confirming', 'queued'].includes(x.status)).length
  })
  const worker = (id, status, extra = {}) => ({ id, title: `Task ${id}`, agent: 'codex', status, isolation: 'worktree', paneId: null, label: null, by: 'lead', taskId: `task-${id}`, ...extra })

  it('shows the phase, the counts and each worker; the user allows, refuses, cancels, stops', async () => {
    const { w, calls } = mountCard([
      team([
        worker('a', 'confirming'),
        worker('b', 'queued'),
        worker('c', 'running', { paneId: 'p5', label: '#5 Codex', branch: 'agent/c', heartbeatAt: Date.now() - 3 * 60000, phase: 'implementing' }),
        worker('d', 'done')
      ])
    ])
    expect(w.text()).toContain('Team 1')
    expect(w.text()).toContain('1 running · 2 waiting · up to 4 at a time per coordinator')
    expect(w.find('.orch-phase').text()).toBe('Starting workers')
    const rows = w.findAll('[data-test="orch-worker"]')
    expect(rows.map((r) => r.attributes('data-status'))).toEqual(['confirming', 'queued', 'running', 'done'])
    expect(rows[2].text()).toContain('own copy, agent/c')
    expect(rows[2].text()).toContain('heartbeat 3 min ago (implementing)')
    await w.find('[data-test="orch-allow"]').trigger('click')
    await w.find('[data-test="orch-refuse"]').trigger('click')
    await w.find('[data-test="orch-cancel"]').trigger('click')
    await w.find('[data-test="orch-stop"]').trigger('click')
    await rows[2].find('.orch-link').trigger('click')
    expect(calls).toEqual([
      ['allow', 'tm1', 'a'],
      ['refuse', 'tm1', 'a'],
      ['stop', 'tm1', 'b'],
      ['stop', 'tm1', 'c'],
      ['focus', 'p5']
    ])
  })

  it('nothing when no team of this workspace has workers', () => {
    const { w } = mountCard([{ ...team([worker('a', 'running')]), wsId: 'ws2' }])
    expect(w.find('[data-test="orch-card"]').exists()).toBe(false)
  })
})

describe('Settings > Orchestration: workers', () => {
  it('cautious defaults: ask first, 4 at a time, depth 1; saved values checked', () => {
    expect(DEFAULT_SETTINGS.orchestrationConfirmWorkers).toBe(true)
    expect(DEFAULT_SETTINGS.orchestrationMaxWorkers).toBe(4)
    expect(DEFAULT_SETTINGS.orchestrationMaxDepth).toBe(1)
    loadSettings({ orchestrationConfirmWorkers: false, orchestrationMaxWorkers: 6, orchestrationMaxDepth: 2 })
    expect([settings.orchestrationConfirmWorkers, settings.orchestrationMaxWorkers, settings.orchestrationMaxDepth]).toEqual([false, 6, 2])
    resetSettings()
    loadSettings({ orchestrationConfirmWorkers: 'no', orchestrationMaxWorkers: 500, orchestrationMaxDepth: 0 })
    expect([settings.orchestrationConfirmWorkers, settings.orchestrationMaxWorkers, settings.orchestrationMaxDepth]).toEqual([true, 4, 1])
  })

  it('the setup card and the three settings', async () => {
    const w = mount(SettingsDialog, { attachTo: document.body })
    mounted.push(w)
    const group = w.find('[data-orch-workers]')
    expect(group.exists()).toBe(true)
    expect(group.find('[data-orch-setup]').findAll('li')).toHaveLength(3)
    // The trust model, said plainly (same Windows user), in the folded "How
    // to ask for teamwork" with the example prompts and the team tools.
    const guide = w.find('[data-orch-guide] details')
    expect(guide.element.open).toBe(false)
    expect(guide.find('[data-orch-trust]').text()).toMatch(/signed with a secret only its pane has.*your Windows user/)
    expect(guide.findAll('.orch-example')).toHaveLength(6)
    expect(guide.findAll('.orch-tools li')).toHaveLength(ORCHESTRATION_TOOLS.length)
    const confirm = group.find('[data-setting="orchestrationConfirmWorkers"]')
    expect(confirm.element.checked).toBe(true)
    await confirm.setValue(false)
    expect(settings.orchestrationConfirmWorkers).toBe(false)
    const max = group.find('[data-setting="orchestrationMaxWorkers"]')
    max.element.value = '99'
    await max.trigger('change')
    expect(settings.orchestrationMaxWorkers).toBe(8)
    const depth = group.find('[data-setting="orchestrationMaxDepth"]')
    depth.element.value = '2'
    await depth.trigger('change')
    expect(settings.orchestrationMaxDepth).toBe(2)
    expect(group.text()).toContain('Per coordinator (1 to 8)')
  })
})

describe('Settings > Orchestration: team and agent hooks', () => {
  const agents = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: true },
    { id: 'gemini', name: 'Gemini CLI', available: true }
  ]
  const status = {
    node: { found: true },
    backups: ['C:/Users/a/.claude/settings.json.before-tessel', 'C:/Users/a/.codex/hooks.json.before-tessel'],
    agents: [
      { id: 'claude', hooks: 'installed', approval: null },
      { id: 'codex', hooks: 'installed', approval: 'needs-approval' },
      { id: 'gemini', hooks: 'missing' },
      { id: 'cursor', hooks: 'installed', statusOnly: true }
    ]
  }
  async function open(api = {}, provide = {}) {
    window.shellApi = { teamHooksStatus: vi.fn(async () => status), ...api }
    const w = mount(SettingsDialog, { props: { section: 'orchestration', agents }, attachTo: document.body, global: { provide } })
    mounted.push(w)
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
    return w
  }
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
  }

  it('Team: one tag per agent with its state, then the two wake switches (the second under the first)', async () => {
    const w = await open()
    const team = w.get('[data-orch-team]')
    expect(team.get('[data-orch-coverage] .set-hint').text()).toBe('1 of 3 agents can work as a team.')
    const tags = team.findAll('.orch-tag')
    expect(tags.map((t) => [t.attributes('data-agent'), t.attributes('data-state')])).toEqual([
      ['claude', 'ready'],
      ['codex', 'approval'],
      ['gemini', 'missing']
    ])
    expect(tags[1].classes()).toContain('tag-warn')
    expect(tags[1].text()).toContain('Codex · needs your approval')
    const wake = team.get('[data-setting="teamWakeUps"]')
    const unconfirmed = team.get('[data-setting="teamWakeUnconfirmed"]')
    expect(unconfirmed.element.closest('.set-row').classList.contains('set-row-nested')).toBe(true)
    await wake.setValue(false)
    expect(settings.teamWakeUps).toBe(false)
    expect(unconfirmed.element.disabled).toBe(true)
    await wake.setValue(true)
    await unconfirmed.setValue(true)
    expect(settings.teamWakeUnconfirmed).toBe(true)
    expect(team.find('[data-wake-unconfirmed-warning]').exists()).toBe(true)
    // Each long explanation waits behind Learn more.
    expect(team.findAll('details.set-more').length).toBe(2)
  })

  it('a failed check says so in a sentence, the raw error behind Details; Check again reads again', async () => {
    const teamHooksStatus = vi.fn().mockRejectedValueOnce(new Error('EACCES: hooks.json')).mockResolvedValue(status)
    const w = await open({ teamHooksStatus })
    const row = w.get('[data-orch-coverage]')
    expect(row.get('.set-hint').text()).toBe('Could not check your agents.')
    expect(row.get('[data-orch-check-error]').element.open).toBe(false)
    expect(row.get('[data-orch-check-error]').text()).toContain('EACCES: hooks.json')
    await row.get('[data-orch-check]').trigger('click')
    await flush()
    expect(teamHooksStatus).toHaveBeenCalledTimes(2)
    expect(row.findAll('.orch-tag')).toHaveLength(3)
  })

  it('no agent with the team tools: one sentence and a way to Agents', async () => {
    const w = await open({ teamHooksStatus: vi.fn(async () => ({ agents: [] })) })
    const row = w.get('[data-orch-coverage]')
    expect(row.text()).toContain('No agent with the team tools yet')
    await row.get('[data-orch-open-agents]').trigger('click')
    expect(w.get('.set-page[data-page="agents"]').attributes('hidden')).toBeUndefined()
  })

  it('Agent hooks: the copies kept are folded; Remove asks first, then removes', async () => {
    const teamRemoveHooks = vi.fn(async () => ({ errors: [] }))
    let asked = null
    const askConfirm = vi.fn(async (q) => {
      asked = q
      return true
    })
    const w = await open({ teamRemoveHooks }, { askConfirm })
    const hooks = w.get('[data-agent-hooks]')
    const copies = hooks.get('[data-hooks-backups]')
    expect(copies.element.open).toBe(false)
    expect(copies.get('summary').text()).toBe('Copies Tessel kept (2)')
    expect(copies.findAll('.sl-path').map((p) => p.attributes('title'))).toEqual(status.backups)
    const remove = hooks.get('[data-remove-hooks]')
    expect(remove.classes()).toContain('danger')
    await remove.trigger('click')
    await flush()
    expect(asked).toMatchObject({ title: 'Remove Tessel hooks?', danger: true })
    expect(teamRemoveHooks).toHaveBeenCalledTimes(1)
    expect(hooks.get('[data-hooks-removed]').text()).toBe('Tessel hooks removed.')
  })

  it('Remove: nothing happens when the question is refused; a failure is a sentence with Details', async () => {
    const teamRemoveHooks = vi.fn(async () => ({ errors: ['C:/x/hooks.json: EBUSY'] }))
    let answer = false
    const w = await open({ teamRemoveHooks }, { askConfirm: async () => answer })
    const hooks = w.get('[data-agent-hooks]')
    await hooks.get('[data-remove-hooks]').trigger('click')
    await flush()
    expect(teamRemoveHooks).not.toHaveBeenCalled()
    answer = true
    await hooks.get('[data-remove-hooks]').trigger('click')
    await flush()
    const result = hooks.get('[data-hooks-removed]')
    expect(result.classes()).toContain('set-callout')
    expect(result.text()).toContain('Some hooks could not be removed.')
    expect(result.get('details').element.open).toBe(false)
    expect(result.get('details').text()).toContain('EBUSY')
  })

  it('the search opens "How to ask for teamwork" when it finds something in it, and folds it again after', async () => {
    const w = await open()
    const guide = w.get('[data-orch-guide] details')
    expect(guide.element.open).toBe(false)
    await w.get('.set-search input').setValue('team_worker_start')
    await flush()
    await flush()
    expect(guide.element.open).toBe(true)
    expect(w.get('[data-orch-guide]').attributes('hidden')).toBeUndefined()
    await w.get('.set-search input').setValue('')
    await flush()
    expect(guide.element.open).toBe(false)
  })
})
