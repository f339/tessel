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
    open: vi.fn(),
    leave: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest']) {
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
    findLeaf: (id) => ({ id, title: 'PowerShell' }),
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: (id, text) => (seeded[id] = text),
    dropBuffer: (id) => delete seeded[id],
    showToast: (text) => toasts.push(text)
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

  it('sends what the window shows while sharing', async () => {
    const ws = reactive({ id: 'ws-1', name: 'tessel', activeId: 'pane-1', tree: { type: 'leaf', id: 'pane-1', kind: 'shell', title: 'PowerShell' } })
    t.workspaces.value.push(ws)
    t.currentWsId.value = 'ws-1'
    await flush()
    expect(t.api.setLayout).not.toHaveBeenCalled()
    t.listeners.onHost({ state: 'sharing', invite: 'TS1.x.y', guests: [], progress: null, error: null })
    await flush()
    expect(t.api.setLayout).toHaveBeenLastCalledWith(expect.objectContaining({ project: 'tessel', activeId: 'pane-1' }))
    ws.tree.title = 'npm run dev'
    await flush()
    expect(t.api.setLayout.mock.calls.at(-1)[0].tree.title).toBe('npm run dev')
  })

  it('asks before a guest joins, and says who joined and left', async () => {
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g1', name: 'Alex', state: 'waiting' }] })
    t.listeners.onAsk({ guestId: 'g1', name: 'Alex' })
    expect(t.ls.state.asks).toEqual([{ guestId: 'g1', name: 'Alex' }])
    t.ls.answerAsk(true)
    expect(t.api.approve).toHaveBeenCalledWith({ guestId: 'g1', yes: true })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [{ id: 'g1', name: 'Alex', state: 'joined' }] })
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    expect(t.toasts.filter((x) => /Alex/.test(x)).length).toBe(2)
  })

  it('does what guests ask: open a pane, close one', async () => {
    t.listeners.onHost({ state: 'sharing', invite: 'x', guests: [] })
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'agent', agent: 'claude' }, guest: { name: 'Alex' } })
    t.listeners.onHostRequest({ action: 'open', spec: { kind: 'terminal' }, guest: { name: 'Alex' } })
    t.listeners.onHostRequest({ action: 'close', id: 'pane-9', guest: { name: 'Alex' } })
    expect(t.deps.launch.mock.calls).toEqual([[{ kind: 'agent', id: 'claude' }], [{ kind: 'shell', id: 'pwsh' }]])
    expect(t.deps.closeLeaf).toHaveBeenCalledWith('pane-9', { force: true })
  })
})
