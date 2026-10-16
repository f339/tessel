// Live Share phase 2b in the window (liveShareWindow.js and the panels it
// feeds). Host: each shared project's panes as their headers show them and
// its finished tasks go to main as they change; a guest asking to delete a
// card that has its own copy makes the host confirm (its usual delete, which
// deletes the copy), the guest hearing it was asked. Guest: the host's panes'
// model, effort and state come for their headers, the sidebar and the
// Dashboard (nothing here can sleep them); a pane's sub-agents are asked of
// the host, not more often than every 8 s; the host's usage shows only with
// the right; the project's task history is read while its tab is shown,
// dollars only when the host says so; a card in Review opens the host's
// branch read only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createLiveShareWindow } from '../liveShareWindow'
import { forgetLshareAccess } from '../liveShareGuestAccess'
import { NO_RIGHTS } from '../../../shared/liveShareRights'
import { paneRow } from '../sidebarModel'
import AgentDashboard from '../components/AgentDashboard.vue'
import TaskCard from '../components/TaskCard.vue'
import ReviewPanel from '../components/ReviewPanel.vue'
import LiveShareChatPane from '../components/LiveShareChatPane.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function setup({ cards = [], records = [] } = {}) {
  const listeners = {}
  const api = {
    state: vi.fn(async () => ({ host: { state: 'off', guests: [] }, guest: { state: 'off', panes: [], projects: [] }, defaultName: 'ada' })),
    setLayouts: vi.fn(),
    setAgents: vi.fn(),
    setTasks: vi.fn(),
    setPaneAgents: vi.fn(),
    setHistory: vi.fn(),
    taskDone: vi.fn(),
    taskCheck: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn(async () => ({ ok: true })),
    task: vi.fn(async () => ({ ok: true })),
    request: vi.fn(async () => ({ ok: false, code: 'failed' })),
    share: vi.fn(async () => ({ ok: true })),
    focus: vi.fn(),
    requestDone: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice', 'onPresence', 'onInviteBlocked', 'onGuestAction', 'onPush']) {
    api[name] = (cb) => {
      listeners[name] = cb
      return () => delete listeners[name]
    }
  }
  window.shellApi = { liveShare: api, attachPty: vi.fn(async () => ({ ok: true, buffer: '', shell: { name: 'Ada' } })) }
  const workspaces = ref([])
  const currentWsId = ref(null)
  const toasts = []
  const actions = []
  const board = reactive(cards.map((c) => ({ ...c })))
  const history = reactive(records.map((r) => ({ ...r })))
  const panes = reactive({})
  const historyOn = ref(false)
  let made = 0
  let release = null
  const taskBoard = {
    tasks: () => board,
    add: vi.fn(),
    move: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn((id) => board.splice(board.findIndex((x) => x.id === id), 1)),
    answer: vi.fn(),
    removeWithCopy: vi.fn(() => new Promise((r) => (release = r)))
  }
  const deps = {
    workspaces: () => workspaces.value,
    currentWs: () => workspaces.value.find((w) => w.id === currentWsId.value) || null,
    currentWsId: () => currentWsId.value,
    maximizedId: () => null,
    setMaximized: () => {},
    makeWorkspace: (name) => reactive({ id: `ws-${++made + 100}`, name, tree: null, activeId: null, cwd: null }),
    selectWorkspace: (id) => (currentWsId.value = id),
    removeWorkspace: vi.fn((id) => (workspaces.value = workspaces.value.filter((w) => w.id !== id))),
    findLeaf: () => null,
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: () => {},
    dropBuffer: () => {},
    showToast: (text, opts) => {
      toasts.push([text, opts && opts.kind])
      if (opts && opts.action) actions.push({ text, ...opts.action })
    },
    isAgentLeaf: () => false,
    probeRunningWork: vi.fn(async () => ({ running: false, unknown: false, names: [] })),
    killPty: vi.fn(),
    adoptLeaves: vi.fn(),
    hasAgent: () => true,
    layoutReady: () => true,
    taskBoard,
    paneAgents: (wsId) => panes[wsId] || [],
    historyRecords: () => history,
    historyShown: () => historyOn.value
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, workspaces, currentWsId, toasts, actions, board, history, panes, historyOn, taskBoard, answer: (yes) => release && release(yes) }
}

const GUEST = (rights = {}) => ({ id: 'g1', name: 'Ana', state: 'joined', rights: { ...NO_RIGHTS, ...rights }, projects: ['ws-1'] })
const sharing = (guests) => ({ state: 'sharing', projectIds: ['ws-1'], invites: [], guests, offline: [], trusted: [], presence: [], settings: { hideIgnored: true }, actions: [] })

describe('Live Share phase 2b in the window, as the host', () => {
  let t
  afterEach(() => t.ls.dispose())
  async function host({ cards = [], records = [], rights = {} } = {}) {
    t = setup({ cards, records })
    await t.ls.init()
    t.workspaces.value.push(reactive({ id: 'ws-1', name: 'site', cwd: 'C:\\site', tree: null, activeId: null }), reactive({ id: 'ws-2', name: 'other', cwd: 'C:\\other', tree: null, activeId: null }))
    t.listeners.onHost(sharing([GUEST(rights)]))
    await flush()
  }

  it('sends each shared project\u2019s panes as their headers show them, and its finished tasks, as they change', async () => {
    await host({ records: [{ id: 'task-1', wsId: 'ws-1', title: 'Mine' }, { id: 'task-2', wsId: 'ws-2', title: 'Not shared' }] })
    expect(t.api.setPaneAgents).toHaveBeenLastCalledWith([{ project: 'ws-1', panes: [] }])
    expect(t.api.setHistory).toHaveBeenLastCalledWith([{ project: 'ws-1', records: [expect.objectContaining({ id: 'task-1' })] }])
    t.panes['ws-1'] = [{ id: 'pane-1', kind: 'agent', model: 'Opus 4.7 \u00b7 high', state: 'working' }]
    t.panes['ws-2'] = [{ id: 'pane-9', kind: 'agent', model: 'elsewhere' }]
    await flush()
    expect(t.api.setPaneAgents).toHaveBeenLastCalledWith([{ project: 'ws-1', panes: [expect.objectContaining({ id: 'pane-1', model: 'Opus 4.7 \u00b7 high' })] }])
    t.panes['ws-1'] = [{ id: 'pane-1', kind: 'agent', model: 'Opus 4.7 \u00b7 high', state: 'waiting' }]
    await flush()
    expect(t.api.setPaneAgents.mock.calls.at(-1)[0][0].panes[0].state).toBe('waiting')
    t.history.push({ id: 'task-3', wsId: 'ws-1', title: 'Done too' })
    await flush()
    expect(t.api.setHistory.mock.calls.at(-1)[0][0].records.map((r) => r.id)).toEqual(['task-1', 'task-3'])
    expect(JSON.stringify(t.api.setPaneAgents.mock.calls)).not.toContain('elsewhere')
  })

  const COPY_CARDS = [
    { id: 'task-1', title: 'With copy', column: 'review', wsId: 'ws-1', worktree: { path: 'C:\\site.worktrees\\a', branch: 'agent/a' } },
    { id: 'task-2', title: 'Plain', column: 'todo', wsId: 'ws-1' },
    { id: 'task-3', title: 'Merged', column: 'done', wsId: 'ws-1', mergedAt: 5, worktree: { path: 'C:\\x', branch: 'agent/x' } },
    { id: 'task-4', title: 'Another copy', column: 'review', wsId: 'ws-1', worktree: { path: 'C:\\site.worktrees\\b', branch: 'agent/b' } }
  ]
  const askRemove = async (id, guest = { id: 'g1', name: 'Ana' }) => {
    t.listeners.onHostRequest({ action: 'task', request: 't1', op: 'remove', project: 'ws-1', args: { id }, guest })
    await flush()
  }

  it('a guest asking to delete a card with its own copy: a notice, never a question over your work; one at a time; quiet after your no', async () => {
    await host({ rights: { tasks: true }, cards: COPY_CARDS })
    await askRemove('task-1')
    // No question opened by the guest: a notice with a button, and the guest
    // hears you were asked.
    expect(t.taskBoard.removeWithCopy).not.toHaveBeenCalled()
    expect(t.taskBoard.remove).not.toHaveBeenCalled()
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'confirm' })
    expect(t.actions).toHaveLength(1)
    expect(t.actions[0]).toMatchObject({ text: 'Ana asks to delete the task “With copy” with its own copy of the project.', label: 'Review…' })
    // The same again: nothing more; another card while one waits: busy.
    await askRemove('task-1')
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'confirm' })
    await askRemove('task-4')
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'busy' })
    expect(t.actions).toHaveLength(1)
    // You look: your usual delete (the request checked again when you answer).
    t.actions[0].run()
    await flush()
    expect(t.taskBoard.removeWithCopy).toHaveBeenCalledWith('task-1', 'Ana', expect.any(Function))
    const stands = t.taskBoard.removeWithCopy.mock.calls[0][2]
    expect(stands()).toBe(true)
    t.listeners.onHost(sharing([GUEST({ tasks: false })]))
    await flush()
    expect(stands()).toBe(false)
    t.listeners.onHost(sharing([GUEST({ tasks: true })]))
    await flush()
    // You say no: that guest's asks are not heard for a while.
    t.answer(false)
    await flush()
    await askRemove('task-4')
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'busy' })
    expect(t.actions).toHaveLength(1)
    // Another guest is heard.
    t.listeners.onHost(sharing([GUEST({ tasks: true }), { ...GUEST({ tasks: true }), id: 'g2', name: 'Bo' }]))
    await flush()
    await askRemove('task-4', { id: 'g2', name: 'Bo' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'confirm' })
    expect(t.actions.at(-1).text).toBe('Bo asks to delete the task “Another copy” with its own copy of the project.')
    // A card without a copy (or merged already): deleted at once, as before.
    await askRemove('task-2')
    await askRemove('task-3')
    expect(t.taskBoard.remove.mock.calls.map((c) => c[0])).toEqual(['task-2', 'task-3'])
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: true, code: undefined })
  })

  it('a request that no longer stands when you look opens nothing', async () => {
    await host({ rights: { tasks: true }, cards: COPY_CARDS })
    await askRemove('task-1')
    t.listeners.onHost(sharing([GUEST({ tasks: false })]))
    await flush()
    t.toasts.length = 0
    t.actions[0].run()
    await flush()
    expect(t.taskBoard.removeWithCopy).not.toHaveBeenCalled()
    expect(t.toasts).toEqual([['That request no longer stands: nothing was deleted.', undefined]])
  })

  it('another question already open: the request waits, its notice again', async () => {
    await host({ rights: { tasks: true }, cards: COPY_CARDS })
    await askRemove('task-1')
    t.actions[0].run()
    await flush()
    t.answer(null)
    await flush()
    expect(t.actions).toHaveLength(2)
    expect(t.actions[1].text).toBe(t.actions[0].text)
    await askRemove('task-1')
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'confirm' })
  })
})

describe('Live Share phase 2b in the window, as a guest', () => {
  let t
  beforeEach(async () => {
    forgetLshareAccess()
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())
  const joined = (extra = {}) => ({ state: 'joined', host: 'Cedric', session: 1, panes: [], projects: [{ id: 'ws-1', layout: { project: 'site', tree: null } }], rights: { ...NO_RIGHTS }, features: ['chat', 'files', 'scm', 'tasks', 'panes2', 'usage', 'history'], ...extra })
  const PANE = { id: 'pane-ls1-1', kind: 'agent', agentId: 'claude', model: 'Opus 4.7 \u00b7 high', state: 'working', sleeping: false, since: 5, task: 'Fix it', attention: false, reset: '', team: { name: 'Team 2', lead: true }, copy: { branch: 'agent/fix' }, children: true }

  it('the host\u2019s panes as their headers show them: for the header, the sidebar and the Dashboard', async () => {
    t.listeners.onGuest(joined())
    await flush()
    t.listeners.onPush({ topic: 'agents', project: 'ws-1', data: { panes: [PANE, { ...PANE, id: 'pane-ls1-2', kind: 'shell', children: false }] } })
    t.listeners.onPush({ topic: 'agents', project: 'ws-9', data: { panes: [{ ...PANE, id: 'pane-ls1-9' }] } })
    expect(t.ls.paneAgent('pane-ls1-1')).toEqual({ ...PANE, project: 'ws-1' })
    expect(t.ls.paneAgent('pane-ls1-9')).toBe(null)
    // A pane gone from the host's list goes here too.
    t.listeners.onPush({ topic: 'agents', project: 'ws-1', data: { panes: [{ ...PANE, state: 'approval' }] } })
    expect(t.ls.paneAgent('pane-ls1-2')).toBe(null)
    expect(t.ls.paneAgent('pane-ls1-1').state).toBe('approval')
    // The project no longer shared with this guest: its panes go.
    t.listeners.onGuest(joined({ projects: [] }))
    await flush()
    expect(t.ls.paneAgent('pane-ls1-1')).toBe(null)
  })

  it('asks the host for a pane\u2019s sub-agents, not more often than every 8 s, one source per pane', async () => {
    t.listeners.onGuest(joined())
    await flush()
    t.listeners.onPush({ topic: 'agents', project: 'ws-1', data: { panes: [PANE, { ...PANE, id: 'pane-ls1-2', children: false }] } })
    t.api.request.mockResolvedValue({ ok: true, data: { items: [{ id: '0123456789abcdef', title: 'Explore', state: 'running' }] } })
    const src = t.ls.childrenSource('pane-ls1-1')
    expect(t.ls.childrenSource('pane-ls1-1')).toBe(src)
    expect(t.ls.childrenSource('pane-ls1-2')).toBe(null)
    const [a, b] = await Promise.all([src.read(), src.read()])
    expect(a).toEqual([{ id: '0123456789abcdef', title: 'Explore', state: 'running' }])
    expect(b).toBe(a)
    expect(await src.read()).toBe(a)
    expect(t.api.request).toHaveBeenCalledTimes(1)
    expect(t.api.request).toHaveBeenCalledWith({ op: 'agents.children', project: 'ws-1', args: { pane: 'pane-ls1-1' } })
  })

  it('the host\u2019s usage only with the right; taken away, it goes', async () => {
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, usage: true } }))
    await flush()
    const usage = { providers: [{ id: 'claude', plan: 'Max', windows: [{ label: '5-hour', usedPct: 42, resetsAt: null }], status: 'ok', updatedAt: 5 }] }
    t.listeners.onPush({ topic: 'usage', project: null, data: usage })
    expect(t.ls.hostUsage()).toEqual(usage)
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS } }))
    await flush()
    expect(t.ls.hostUsage()).toBe(null)
    // Main's word that it went.
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, usage: true } }))
    t.listeners.onPush({ topic: 'usage', project: null, data: usage })
    t.listeners.onPush({ topic: 'usage', project: null, data: null })
    expect(t.ls.hostUsage()).toBe(null)
  })

  it('reads the project\u2019s task history while its tab is shown, dollars only when the host says so', async () => {
    t.api.request.mockImplementation(async ({ op }) => (op === 'history.list' ? { ok: true, data: { records: [{ id: 'task-1', title: 'One', cost: { status: 'ok', inputTokens: 1, outputTokens: 2 } }], usd: false } } : { ok: false, code: 'failed' }))
    t.listeners.onGuest(joined())
    await flush()
    expect(t.api.request).not.toHaveBeenCalled()
    expect(t.ls.historySource('ws-1')).toMatchObject({ records: [], loaded: false, state: 'ok', usd: false })
    t.historyOn.value = true
    await flush()
    expect(t.api.request).toHaveBeenCalledWith({ op: 'history.list', project: 'ws-1' })
    expect(t.ls.historySource('ws-1')).toMatchObject({ records: [{ id: 'task-1' }], loaded: true, state: 'ok', usd: false, error: '' })
    // The usage right given: read again (its dollars come with it).
    t.api.request.mockResolvedValue({ ok: true, data: { records: [{ id: 'task-1', title: 'One', cost: { status: 'ok', usd: 2 } }], usd: true } })
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, usage: true } }))
    await flush()
    expect(t.api.request).toHaveBeenCalledTimes(2)
    expect(t.ls.historySource('ws-1').usd).toBe(true)
    // An older host, a project taken away: said, not shown.
    t.api.request.mockResolvedValue({ ok: false, code: 'bad-op' })
    t.historyOn.value = false
    await flush()
    t.historyOn.value = true
    await flush()
    expect(t.ls.historySource('ws-1').state).toBe('outdated-host')
    expect(t.ls.historySource('ws-9').state).toBe('no-access')
    t.listeners.onGuest(joined({ features: ['chat', 'files'] }))
    await flush()
    expect(t.ls.historySource('ws-1').state).toBe('outdated-host')
  })

  it('a card in Review with its own copy opens the host\u2019s branch, read only', async () => {
    t.listeners.onGuest(joined())
    await flush()
    t.listeners.onPush({ topic: 'tasks', project: 'ws-1', data: { tasks: [{ id: 'task-1', title: 'Fix', column: 'review', worktree: { branch: 'agent/fix' } }] } })
    const source = t.ls.taskSource('ws-1')
    expect(typeof source.review).toBe('function')
    expect(t.ls.reviewSource()).toBe(null)
    source.review('task-1')
    const review = t.ls.reviewSource()
    expect(review).toMatchObject({ task: { id: 'task-1' }, host: 'Cedric' })
    t.api.request.mockImplementation(async ({ op, args }) =>
      op === 'review.info'
        ? { ok: true, data: { branch: 'agent/fix', target: 'main', head: 'abc1234', files: [{ path: 'src/app.js', status: 'M', added: 1, removed: 0 }], hidden: 1, commits: [], conflicts: [], uncommitted: [], mergeCheck: 'done', behind: 0, copyExists: true } }
        : { ok: true, data: { text: `@@ -1 +1,2 @@\n one\n+${args.file}\n`, truncated: false } }
    )
    const info = await review.info()
    expect(info).toMatchObject({ ok: true, files: [{ path: 'src/app.js' }], dirtyOverlap: [], rootBranch: 'main', merging: false, blocker: 'Only Cedric can merge this task.' })
    expect(await review.diff('src/app.js')).toEqual({ ok: true, text: '@@ -1 +1,2 @@\n one\n+src/app.js\n', truncated: false })
    t.api.request.mockResolvedValue({ ok: false, code: 'not-found' })
    expect((await review.info()).ok).toBe(false)
    // An older host: no Review.
    t.listeners.onGuest(joined({ features: ['chat', 'files', 'scm', 'tasks'] }))
    await flush()
    expect(t.ls.taskSource('ws-1').review).toBeUndefined()
    t.ls.closeReview()
    expect(t.ls.reviewSource()).toBe(null)
  })

  it('a delete the host is asked to confirm: said as such, not as a failure', async () => {
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, tasks: true } }))
    await flush()
    t.api.task.mockResolvedValue({ ok: false, code: 'confirm' })
    t.toasts.length = 0
    await t.ls.taskSource('ws-1').remove('task-1')
    expect(t.toasts).toEqual([['Cedric was asked to confirm: this task has its own copy of the project, deleted with it.', undefined]])
  })
})

describe('the host\u2019s panes in the guest\u2019s panels', () => {
  it('the Dashboard shows a host pane\u2019s state, team and copy, and never offers to sleep it', async () => {
    const pane = (id, extra) => ({ id, kind: 'agent', agentId: 'claude', title: id, state: 'ready', since: 0, ...extra })
    const projects = [
      { id: 'ws-1', name: 'site — Cedric', panes: [pane('pane-ls1-1', { liveShare: true, teamName: 'Team 3', lead: true, copyBranch: 'agent/fix', task: 'Fix it' }), pane('pane-ls1-2', { liveShare: true, state: 'working' })] },
      { id: 'ws-2', name: 'mine', panes: [pane('pane-9')] }
    ]
    expect(paneRow(projects[0].panes[0])).toMatchObject({ liveShare: true, teamName: 'Team 3', dotState: 'idle' })
    const w = mount(AgentDashboard, { props: { projects, now: 10 } })
    expect(w.find('[data-test="adb-total"]').text()).toBe('3 agents')
    expect(w.find('[data-test="adb-team"]').text()).toBe('3')
    expect(w.find('[data-test="adb-team"]').attributes('title')).toBe('Team 3 (lead)')
    expect(w.text()).toContain('agent/fix')
    // Only this computer's idle agent can sleep.
    expect(w.find('[data-test="adb-sleep-idle"]').text()).toContain('(1)')
  })

  it('a host card in Review offers its branch only with a copy and a source that opens it', async () => {
    const review = vi.fn()
    const card = (extra) => mount(TaskCard, { props: { task: { id: 'task-1', title: 'Fix', column: 'review', ...extra }, source: { tasks: [], review } } })
    expect(card({}).find('[data-test="review-task"]').exists()).toBe(false)
    const w = card({ worktree: { branch: 'agent/fix' } })
    await w.find('[data-test="review-task"]').trigger('click')
    expect(review).toHaveBeenCalledWith('task-1')
    expect(mount(TaskCard, { props: { task: { id: 'task-1', title: 'Fix', column: 'review', worktree: { branch: 'agent/fix' } }, source: { tasks: [] } } }).find('[data-test="review-task"]').exists()).toBe(false)
  })

  it('the review of a host\u2019s branch: files, commits and diffs, and nothing that changes it', async () => {
    window.shellApi = { review: { info: vi.fn(), diff: vi.fn() } }
    const source = {
      host: 'Cedric',
      info: vi.fn(async () => ({ ok: true, branch: 'agent/fix', target: 'main', head: 'abc1234', files: [{ path: 'src/app.js', status: 'M', added: 1, removed: 0 }], commits: [{ sha: 'abc1234', author: 'Cedric', time: 5, subject: 'Work', body: '' }], conflicts: [], uncommitted: ['src/later.js'], dirtyOverlap: [], rootBranch: 'main', merging: false, behind: 0, mergeCheck: 'done', blocker: 'Only Cedric can merge this task.' })),
      diff: vi.fn(async () => ({ ok: true, text: '@@ -1 +1,2 @@\n one\n+two\n', truncated: false }))
    }
    const w = mount(ReviewPanel, { props: { task: { id: `t-${Math.random()}`, title: 'Fix', worktree: { branch: 'agent/fix' } }, source, actions: {} }, attachTo: document.body })
    await flushPromises()
    await flushPromises()
    expect(source.info).toHaveBeenCalled()
    expect(source.diff).toHaveBeenCalledWith('src/app.js')
    expect(window.shellApi.review.info).not.toHaveBeenCalled()
    expect(w.text()).toContain('src/app.js')
    expect(w.text()).toContain('Work')
    expect(w.findAll('tr.rv-line.add')).toHaveLength(1)
    expect(w.find('[data-test="rv-read-only"]').text()).toBe('Read only: only Cedric can merge, discard or ask for changes.')
    // No merge, discard, push, commit or request changes; no comments on lines.
    const buttons = w.findAll('button').map((b) => b.text())
    for (const word of ['Merge', 'Discard', 'Push', 'Request changes', 'Commit these files', 'Show agent']) expect(buttons.some((b) => b.includes(word))).toBe(false)
    await w.findAll('tr.rv-line.add')[0].findAll('.rv-num-click')[1].trigger('click')
    expect(w.find('.rv-comment-input').exists()).toBe(false)
    w.unmount()
  })

  it('a host review keeps its marks apart from this computer\u2019s task of the same id; no comment or Remove in read only', async () => {
    const DIFF = '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n'
    const facts = { ok: true, head: 'h1', branch: 'agent/x', target: 'main', rootBranch: 'main', files: [{ path: 'src/app.js', status: 'M', added: 1, removed: 1, blob: 'b1' }], commits: [], uncommitted: [], conflicts: [], dirtyOverlap: [], behind: 0, merging: false, blocker: null }
    window.shellApi = { review: { info: vi.fn(async () => facts), diff: vi.fn(async () => ({ ok: true, text: DIFF })) } }
    const id = `same-${Math.random()}`
    const local = mount(ReviewPanel, {
      props: { task: { id, title: 'Mine', worktree: { root: 'C:/p', path: 'C:/p.worktrees/x', branch: 'agent/x', baseBranch: 'main' } }, agentLabel: '#1 Codex', actions: { requestChanges: vi.fn(), merge: vi.fn(), discard: vi.fn(), markDone: vi.fn(), focusAgent: vi.fn(), resolveConflicts: vi.fn() } },
      attachTo: document.body
    })
    await flushPromises()
    await flushPromises()
    const added = local.findAll('tr.rv-line').find((r) => r.classes('add'))
    await added.findAll('.rv-num-click')[1].trigger('click')
    await local.find('.rv-comment-input').setValue('Why 3?')
    await local.findAll('.rv-comment-draft .confirm-btn.primary')[0].trigger('click')
    expect(local.findAll('[data-test="line-comment"]')).toHaveLength(1)
    local.unmount()
    const source = { host: 'Cedric', key: `1:ws-1:${id}`, info: vi.fn(async () => facts), diff: vi.fn(async () => ({ ok: true, text: DIFF, truncated: false })) }
    const remote = mount(ReviewPanel, { props: { task: { id, title: 'Theirs', worktree: { branch: 'agent/x' } }, source, actions: {} }, attachTo: document.body })
    await flushPromises()
    await flushPromises()
    expect(remote.findAll('tr.rv-line.add')).toHaveLength(1)
    expect(remote.findAll('[data-test="line-comment"]')).toHaveLength(0)
    expect(remote.find('.rv-comment-del').exists()).toBe(false)
    remote.unmount()
  })

  it('a confirmation someone else asked for has Cancel focused, never the action', () => {
    const w = mount(ConfirmDialog, { props: { title: 'Delete?', confirmLabel: 'Delete', danger: true, focusCancel: true }, attachTo: document.body })
    expect(document.activeElement).toBe(w.find('[data-test="confirm-cancel"]').element)
    w.unmount()
    const own = mount(ConfirmDialog, { props: { title: 'Delete?', confirmLabel: 'Delete' }, attachTo: document.body })
    expect(document.activeElement.textContent.trim()).toBe('Delete')
    own.unmount()
  })

  it('a host pane in chat mode shows its model as the host\u2019s header does', () => {
    const node = reactive({ id: 'pane-ls1-3', title: 'Codex', accent: null, liveShare: { host: 'Cedric', agentId: 'codex', view: 'terminal' } })
    const ctx = { activeId: ref(null), maximizedId: ref(null), highlightId: ref(null), liveSharePaneAgent: (id) => (id === 'pane-ls1-3' ? { kind: 'chat', model: 'GPT-5.5 \u00b7 high', state: 'working' } : null) }
    const w = mount(LiveShareChatPane, { props: { node }, global: { provide: { panelCtx: ctx } } })
    expect(w.find('[data-test="pane-model-chip"]').text()).toBe('GPT-5.5 \u00b7 high')
    expect(w.find('.pane-icon').classes()).toContain('busy')
  })
})
