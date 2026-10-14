import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick } from 'vue'
import { createLiveShareWindow } from '../liveShareWindow'

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function setup() {
  const listeners = {}
  const api = {
    state: vi.fn(async () => ({ host: { state: 'off', invite: null, guests: [], progress: null, error: null }, guest: { state: 'off', panes: [], layout: null }, defaultName: 'cedri' })),
    setLayout: vi.fn(),
    approve: vi.fn(),
    setRights: vi.fn(),
    newInvite: vi.fn(),
    stop: vi.fn(),
    open: vi.fn(),
    leave: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice']) {
    api[name] = (cb) => {
      listeners[name] = cb
      return () => delete listeners[name]
    }
  }
  window.shellApi = {
    liveShare: api,
    attachPty: vi.fn(async (id) => ({ ok: true, buffer: `screen ${id}`, shell: { id: 'liveshare', name: 'Ada' }, backend: 'liveshare' }))
  }
  const workspaces = ref([])
  const currentWsId = ref(null)
  const maximizedId = ref(null)
  const seeded = {}
  const toasts = []
  const deps = {
    workspaces: () => workspaces.value,
    currentWs: () => workspaces.value.find((w) => w.id === currentWsId.value) || null,
    currentWsId: () => currentWsId.value,
    maximizedId: () => maximizedId.value,
    setMaximized: (id) => (maximizedId.value = id),
    makeWorkspace: (name) => reactive({ id: `ws-${workspaces.value.length + 1}`, name, tree: null, activeId: null, cwd: null }),
    selectWorkspace: (id) => (currentWsId.value = id),
    removeWorkspace: vi.fn((id) => (workspaces.value = workspaces.value.filter((w) => w.id !== id))),
    findLeaf: (id) => (id === 'pane-gone' ? null : { id, title: id === 'pane-agent' ? 'Claude Code' : 'PowerShell', kind: id === 'pane-agent' ? 'agent' : 'shell' }),
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: (id, text) => (seeded[id] = text),
    dropBuffer: (id) => delete seeded[id],
    showToast: (text) => toasts.push(text),
    isAgentLeaf: (l) => l.kind === 'agent',
    probeRunningWork: vi.fn(async (id) => (id === 'pane-busy' ? { running: true, unknown: false, names: ['npm'] } : { running: false, unknown: false, names: [] })),
    killPty: vi.fn(),
    adoptLeaves: vi.fn()
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, deps, workspaces, currentWsId, maximizedId, seeded, toasts }
}

const pane = (id, extra = {}) => ({ id, title: id, kind: 'shell', cols: 120, rows: 30, ...extra })
const leaf = (id, view = 'terminal') => ({ type: 'leaf', id, view, title: id, kind: 'shell' })

describe('Live Share in the window, as a guest', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  it('shows the host screen as a Live Share project that follows its layout', async () => {
    const layout = {
      project: 'tessel',
      tree: { type: 'split', dir: 'row', sizes: [50, 30, 20], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b'), leaf('pane-ls1-ed', 'editor')] },
      activeId: 'pane-ls1-b',
      maximizedId: null
    }
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a'), pane('pane-ls1-b')], layout })
    await flush()
    const ws = t.workspaces.value[0]
    expect(ws.liveShare).toEqual({ session: 1, host: 'Ada' })
    expect(ws.name).toBe('Ada · tessel')
    expect(t.currentWsId.value).toBe(ws.id)
    expect(t.seeded['pane-ls1-a']).toBe('screen pane-ls1-a')
    expect(ws.tree.type).toBe('split')
    expect(ws.tree.children.map((c) => c.id)).toEqual(['pane-ls1-a', 'pane-ls1-b'])
    expect(ws.tree.children[0].backend).toBe('liveshare')
    expect(ws.tree.children[0].liveShare.cols).toBe(120)
    expect(ws.activeId).toBe('pane-ls1-b')
    const first = ws.tree.children[0]

    // The host goes fullscreen on a pane and resizes another: followed.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a', { cols: 90 }), pane('pane-ls1-b')], layout: { ...layout, maximizedId: 'pane-ls1-a' } })
    await flush()
    expect(t.maximizedId.value).toBe('pane-ls1-a')
    expect(ws.tree.children[0]).toBe(first) // same leaf: its terminal stays
    expect(first.liveShare.cols).toBe(90)

    // The host closes a pane.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { ...layout, tree: leaf('pane-ls1-a'), activeId: 'pane-ls1-a' } })
    await flush()
    expect(ws.tree.id).toBe('pane-ls1-a')
    expect(t.seeded['pane-ls1-b']).toBe(undefined)
  })

  it('follows what the host lets it do: view only until allowed to type, open or close', async () => {
    const rights = { type: false, open: false, close: false }
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights })
    await flush()
    const first = t.workspaces.value[0].tree
    expect(first.liveShare.canType).toBe(false)
    expect(first.liveShare.host).toBe('Ada')
    t.ls.openOnHost({ kind: 'terminal' })
    expect(t.api.open).not.toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/has not let you open/)
    expect(t.ls.canClose()).toBe(false)
    expect(t.toasts.at(-1)).toMatch(/has not let you close/)

    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { type: true, open: true, close: true } })
    await flush()
    expect(first.liveShare.canType).toBe(true)
    expect(t.toasts.at(-1)).toMatch(/Ada changed what you can do/)
    t.ls.openOnHost({ kind: 'terminal' })
    expect(t.api.open).toHaveBeenCalledWith({ kind: 'terminal' })
    expect(t.ls.canClose()).toBe(true)

    t.listeners.onNotice({ code: 'limit' })
    expect(t.toasts.at(-1)).toMatch(/limits how often/)
  })

  it('closing a host pane only asks the host: it stays until the host closed it', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { type: false, open: false, close: true } })
    await flush()
    t.ls.requestClose('pane-ls1-a', 'Claude Code')
    expect(t.deps.killPty).toHaveBeenCalledWith('pane-ls1-a')
    expect(t.toasts.at(-1)).toBe('Asked Ada to close Claude Code.')
    expect(t.workspaces.value[0].tree.id).toBe('pane-ls1-a')
    expect(t.seeded['pane-ls1-a']).toBe('screen pane-ls1-a')
    // Not one of the host's panes, or not allowed: nothing asked.
    t.ls.requestClose('pane-1', 'x')
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null }, rights: { type: false, open: false, close: false } })
    await flush()
    t.ls.requestClose('pane-ls1-a', 'Claude Code')
    expect(t.deps.killPty).toHaveBeenCalledTimes(1)
  })

  it('keeps a pane of this computer that opened in the Live Share project, and gives it back at the end', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null } })
    await flush()
    const ws = t.workspaces.value[0]
    const page = reactive({ type: 'leaf', id: 'pane-web', kind: 'browser', title: 'localhost' })
    ws.tree = reactive({ type: 'split', id: 's', dir: 'row', sizes: [50, 50], children: [ws.tree, page] })
    // The host changes its layout: the page stays beside the host's panes.
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a'), pane('pane-ls1-b')], layout: { project: 'x', tree: { type: 'split', dir: 'col', sizes: [50, 50], children: [leaf('pane-ls1-a'), leaf('pane-ls1-b')] }, activeId: null, maximizedId: null } })
    await flush()
    expect(ws.tree.children.at(-1)).toBe(page)
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'left' })
    await flush()
    expect(t.deps.adoptLeaves).toHaveBeenCalledWith([page])
  })

  it('opens new panes on the host, and the project goes when the session ends', async () => {
    t.listeners.onGuest({ state: 'joined', host: 'Ada', session: 1, panes: [pane('pane-ls1-a')], layout: { project: 'x', tree: leaf('pane-ls1-a'), activeId: null, maximizedId: null } })
    await flush()
    t.ls.openOnHost({ kind: 'agent', agent: 'codex' })
    expect(t.api.open).toHaveBeenCalledWith({ kind: 'agent', agent: 'codex' })
    t.listeners.onGuest({ state: 'ended', host: 'Ada', session: 1, panes: [], layout: null, reason: 'stopped' })
    await flush()
    expect(t.workspaces.value).toEqual([])
    expect(t.toasts.some((x) => /stopped sharing/.test(x))).toBe(true)
  })
})

describe('Live Share in the window, as the host', () => {
  let t
  beforeEach(async () => {
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())

  function twoProjects() {
    const shared = reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', kind: 'shell', title: 'PowerShell' } })
    const other = reactive({ id: 'ws-2', name: 'private', activeId: 'pane-2', tree: { type: 'leaf', id: 'pane-2', kind: 'shell', title: 'secrets' } })
    t.workspaces.value.push(shared, other)
    t.currentWsId.value = 'ws-1'
    return { shared, other }
  }

  it('shares the project chosen, not the one on screen', async () => {
    const { shared } = twoProjects()
    t.ls.prepareShare()
    expect(t.ls.state.sharedWsId).toBe('ws-1')
    await flush()
    expect(t.api.setLayout).not.toHaveBeenCalled()
    t.listeners.onHost({ state: 'sharing', invite: 'TS1.x.y', guests: [], progress: null, error: null })
    await flush()
    expect(t.api.setLayout).toHaveBeenLastCalledWith(expect.objectContaining({ project: 'tessel', activeId: 'pane-1' }))
    shared.tree.title = 'npm run dev'
    await flush()
    expect(t.api.setLayout.mock.calls.at(-1)[0].tree.title).toBe('npm run dev')

    // You switch to another project: the guests keep seeing the shared one
    // (without the fullscreen pane of the window, which is the other project's).
    t.maximizedId.value = 'pane-2'
    t.currentWsId.value = 'ws-2'
    await flush()
    const sent = t.api.setLayout.mock.calls.map((c) => c[0].project)
    expect(sent.every((name) => name === 'tessel')).toBe(true)
    expect(t.api.setLayout.mock.calls.at(-1)[0].maximizedId).toBe(null)

    // Sharing another project is your choice.
    t.ls.shareProject('ws-2')
    await flush()
    expect(t.api.setLayout.mock.calls.at(-1)[0].project).toBe('private')
  })

  it('stops sharing when the shared project closes', async () => {
    twoProjects()
    t.ls.prepareShare()
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    await flush()
    t.workspaces.value = t.workspaces.value.filter((w) => w.id !== 'ws-1')
    await flush()
    expect(t.api.stop).toHaveBeenCalled()
    expect(t.toasts.at(-1)).toMatch(/Live Share stopped/)
  })

  it('asks before a guest joins, answers that guest only, and says who joined and left', async () => {
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }, { id: 'g2', name: 'Bea', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex', code: '123 456', forward: true })
    t.listeners.onAsk({ guestId: 'g2', name: 'Bea', code: '654 321', forward: false })
    expect(t.ls.state.asks[0]).toEqual({ kind: 'join', key: 'g1', guestId: 'g1', name: 'Alex', code: '123 456', forward: true })
    // Alex leaves before the answer: a yes meant for Alex never lets Bea in.
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g2', name: 'Bea', state: 'waiting' }] })
    t.ls.answerAsk({ key: 'g1', yes: true })
    expect(t.api.approve).not.toHaveBeenCalled()
    expect(t.ls.state.asks.map((a) => a.key)).toEqual(['g2'])
    t.ls.answerAsk({ key: 'g2', yes: true })
    expect(t.api.approve).toHaveBeenCalledWith({ guestId: 'g2', yes: true })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g2', name: 'Bea', state: 'joined' }] })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    expect(t.toasts.filter((x) => /Bea/.test(x)).length).toBe(2)
  })

  it('sets what each guest may do', () => {
    t.ls.setRights('g1', { type: true, open: 0, close: 'yes' })
    expect(t.api.setRights).toHaveBeenCalledWith({ guestId: 'g1', rights: { type: true, open: false, close: true } })
  })

  it('opens what guests ask in the shared project, beside its active pane', async () => {
    twoProjects()
    t.ls.prepareShare()
    t.currentWsId.value = 'ws-2'
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'agent', agent: 'claude' }, guest: { id: 'g1', name: 'Alex' } })
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'terminal' }, guest: { id: 'g1', name: 'Alex' } })
    expect(t.deps.launch.mock.calls).toEqual([
      [{ kind: 'agent', id: 'claude' }, 'pane-1', 'right'],
      [{ kind: 'shell', id: 'pwsh' }, 'pane-1', 'right']
    ])
  })

  function sharedWithPanes(ids) {
    const ws = reactive({ id: 'ws-1', name: 'tessel', activeId: ids[0], tree: { type: 'split', id: 's', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, kind: 'shell', title: id })) } })
    t.workspaces.value.push(ws)
    t.currentWsId.value = 'ws-1'
    t.ls.prepareShare()
    return ws
  }
  const alex = (rights = { type: false, open: false, close: true }) => ({ id: 'g1', name: 'Alex', state: 'joined', rights })

  it('closes an idle terminal a guest asks to close; an agent or a busy one waits for your yes', async () => {
    sharedWithPanes(['pane-9', 'pane-agent', 'pane-busy'])
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex()] })
    const guest = { id: 'g1', name: 'Alex' }
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    await flush()
    expect(t.deps.closeLeaf).toHaveBeenCalledWith('pane-9', { force: true })

    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest }) // asked twice: one question
    await flush()
    expect(t.deps.closeLeaf).toHaveBeenCalledTimes(1)
    expect(t.ls.state.asks.map((a) => [a.kind, a.paneId])).toEqual([
      ['close', 'pane-agent'],
      ['close', 'pane-busy']
    ])
    expect(t.ls.state.asks[1].detail).toMatch(/npm still runs/)
    t.ls.answerAsk({ key: 'close-pane-agent', yes: false })
    t.ls.answerAsk({ key: 'close-pane-busy', yes: true })
    expect(t.deps.closeLeaf.mock.calls).toEqual([
      ['pane-9', { force: true }],
      ['pane-busy', { force: true }]
    ])
    // A guest who left: its questions go.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    await flush()
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    expect(t.ls.state.asks).toEqual([])
  })

  it('does nothing for a close request that no longer stands', async () => {
    sharedWithPanes(['pane-9', 'pane-busy', 'pane-agent'])
    const guest = { id: 'g1', name: 'Alex' }
    // The guest leaves while Tessel checks what runs in the pane.
    let answer
    t.deps.probeRunningWork.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex()] })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    answer({ running: false, unknown: false, names: [] })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()

    // No right to close, or a pane outside the shared project: nothing.
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex({ type: true, open: true, close: false })] })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex()] })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-elsewhere', guest })
    await flush()
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()

    // A yes given after the guest lost the right closes nothing.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-agent', guest })
    await flush()
    const ask = t.ls.state.asks.find((a) => a.paneId === 'pane-agent')
    expect(ask).toBeTruthy()
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex({ type: true, open: false, close: false })] })
    expect(t.ls.state.asks).toEqual([])
    t.ls.answerAsk({ key: ask.key, yes: true })

    // Sharing stopped and started again: a request of the earlier sharing is stale.
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest }) // refused: no right now
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [alex()] })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-busy', guest })
    await flush()
    const busy = t.ls.state.asks.find((a) => a.paneId === 'pane-busy')
    t.listeners.onHost({ state: 'off', invite: null, guests: [] })
    t.listeners.onHost({ state: 'sharing', invite: 'y', guests: [alex()] })
    t.ls.state.asks.push(busy)
    t.ls.answerAsk({ key: busy.key, yes: true })
    expect(t.deps.closeLeaf).not.toHaveBeenCalled()
  })
})
