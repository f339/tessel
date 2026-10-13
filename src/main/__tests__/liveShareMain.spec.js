// @vitest-environment node
// Live Share in main (liveShare.js): the window's layout kept to plain data,
// a host pane's id in a guest's window, and registerLiveShare's IPC end to
// end over real WebSockets on 127.0.0.1 (only Cloudflare's tunnel is faked).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanLayout, layoutLeaves, guestPaneId, registerLiveShare } from '../liveShare'
import { createShareHost } from '../liveShare/shareHost'
import { newSecret, encodeInvite, decodeInvite } from '../liveShare/shareCrypto'

// The tunnel to the share server is the server itself here (no cloudflared).
vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => ({ url: `ws://127.0.0.1:${port}/`, stop: vi.fn() })),
  waitReachable: vi.fn(async () => true)
}))

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

const leaf = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })

describe('cleanLayout', () => {
  it('keeps the tree, the active and the fullscreen pane, as plain bounded data', () => {
    const layout = cleanLayout({
      project: 'tessel',
      tree: {
        type: 'split',
        dir: 'col',
        sizes: [30, 70],
        children: [
          leaf('pane-1', { kind: 'agent', agentId: 'claude', accent: '#ff8800', secret: 'not copied' }),
          { type: 'split', dir: 'row', sizes: [50, 50], children: [leaf('pane-2', { view: 'editor' }), leaf('pane-3', { view: 'browser' })] }
        ]
      },
      activeId: 'pane-2',
      maximizedId: 'pane-1'
    })
    expect(layout).toEqual({
      project: 'tessel',
      tree: {
        type: 'split',
        dir: 'col',
        sizes: [30, 70],
        children: [
          { type: 'leaf', id: 'pane-1', view: 'terminal', title: 'pane-1', kind: 'agent', agentId: 'claude', accent: '#ff8800' },
          {
            type: 'split',
            dir: 'row',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-2', view: 'editor', title: 'pane-2', kind: 'shell', agentId: null, accent: null },
              { type: 'leaf', id: 'pane-3', view: 'browser', title: 'pane-3', kind: 'shell', agentId: null, accent: null }
            ]
          }
        ]
      },
      activeId: 'pane-2',
      maximizedId: 'pane-1'
    })
  })

  it('drops what is not a pane, and fixes what it can', () => {
    const layout = cleanLayout({
      project: 42,
      tree: {
        type: 'split',
        dir: 'diagonal',
        sizes: [1, 2, 3],
        children: [
          leaf('pane-ok', { view: 'webview', kind: 'root', accent: 'red; background: url(x)', title: 'x'.repeat(500) }),
          leaf('../../etc/passwd'),
          leaf('pane-2'),
          { type: 'split', children: [] },
          null,
          'pane-4'
        ]
      },
      activeId: 'pane-gone',
      maximizedId: '../../etc/passwd'
    })
    expect(layout.project).toBe(null)
    expect(layout.tree.dir).toBe('row')
    expect(layout.tree.sizes).toEqual([50, 50]) // the sizes did not fit the panes kept
    expect(layout.tree.children.map((c) => c.id)).toEqual(['pane-ok', 'pane-2'])
    expect(layout.tree.children[0]).toMatchObject({ view: 'terminal', kind: 'shell', accent: null })
    expect(layout.tree.children[0].title).toHaveLength(200)
    expect(layout.activeId).toBe(null)
    expect(layout.maximizedId).toBe(null)
  })

  it('a split of one pane is that pane; nothing usable is no tree', () => {
    expect(cleanLayout({ tree: { type: 'split', children: [leaf('pane-1')] } }).tree).toMatchObject({ type: 'leaf', id: 'pane-1' })
    expect(cleanLayout({ tree: { type: 'split', children: [{ type: 'leaf', id: 'a b' }] } })).toEqual({ project: null, tree: null, activeId: null, maximizedId: null })
    expect(cleanLayout(null)).toBe(null)
    expect(cleanLayout('layout')).toBe(null)
  })

  it('stops at 64 panes and 16 levels', () => {
    const many = cleanLayout({ tree: { type: 'split', children: Array.from({ length: 32 }, (_, i) => ({ type: 'split', children: [leaf(`pane-${i}-a`), leaf(`pane-${i}-b`), leaf(`pane-${i}-c`)] })) } })
    expect(layoutLeaves(many)).toHaveLength(64)
    let deep = leaf('pane-deep')
    for (let i = 0; i < 20; i++) deep = { type: 'split', children: [deep, leaf(`pane-${i}`)] }
    const ids = layoutLeaves(cleanLayout({ tree: deep })).map((l) => l.id)
    expect(ids).not.toContain('pane-deep')
    expect(ids).toContain('pane-19')
  })
})

describe('layoutLeaves', () => {
  it('lists the panes left to right, top to bottom', () => {
    const layout = cleanLayout({ tree: { type: 'split', children: [leaf('pane-1'), { type: 'split', dir: 'col', children: [leaf('pane-2'), leaf('pane-3')] }] } })
    expect(layoutLeaves(layout).map((l) => l.id)).toEqual(['pane-1', 'pane-2', 'pane-3'])
    expect(layoutLeaves(null)).toEqual([])
    expect(layoutLeaves({ tree: null })).toEqual([])
  })
})

describe('guestPaneId', () => {
  it('is a valid pane id of this window, unique per session, that main never starts a shell for', () => {
    expect(guestPaneId(1, 'pane-12-abc')).toBe('pane-ls1-12-abc')
    expect(guestPaneId(2, 'pane-12-abc')).toBe('pane-ls2-12-abc')
    expect(guestPaneId(3, 'odd id/../x')).toBe('pane-ls3-odd_id____x')
    const long = guestPaneId(12, 'pane-' + 'x'.repeat(200))
    expect(long).toHaveLength(80)
    for (const id of [guestPaneId(1, 'pane-1'), long, guestPaneId(3, 'odd id/../x')]) {
      expect(id).toMatch(/^[\w-]{1,80}$/)
      expect(id).toMatch(/^pane-ls\d+-/) // pty:create refuses these (index.js)
    }
  })
})

// The window's side of registerLiveShare: its IPC handlers, what it sends to
// the window, the terminal host client and the window's pty:data / pty:exit.
function fakeMain({ snapshot = (id) => `screen of ${id}` } = {}) {
  const m = {
    handle: {},
    on: {},
    sent: [],
    data: [],
    exits: [],
    hostWrites: [],
    ipcMain: {
      handle: (name, fn) => (m.handle[name] = fn),
      on: (name, fn) => (m.on[name] = fn)
    },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: {
      // A screen from the terminal host: onReply first, as ptyClient does.
      request: vi.fn(async (op, body, _timeout, onReply) => {
        const msg = op === 'attach' ? { ok: true, buffer: snapshot(body.id) } : { ok: false }
        onReply?.(msg)
        return msg
      }),
      send: vi.fn((op, body) => {
        if (op === 'write') m.hostWrites.push([body.id, body.data])
      })
    },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir: 'C:/fixture/userData',
    queueData: (id, data) => m.data.push([id, data]),
    sendExit: (id, exitCode) => m.exits.push([id, exitCode]),
    log: { info: () => {} }
  })
  return m
}

describe('registerLiveShare: joining a host', () => {
  let shareHost
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
    shareHost?.stop()
    shareHost = null
  })

  it('shows the host panes and layout with local ids, attaches, types, and closes on the host', async () => {
    const secret = newSecret()
    const remote = { writes: [], closed: [], opened: [], asked: [], approve: null }
    let panes = [{ id: 'pane-7-abc', title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: '#3366ff', cols: 100, rows: 30 }]
    const hostLayout = {
      project: 'tessel',
      tree: { type: 'split', dir: 'row', sizes: [60, 40], children: [leaf('pane-7-abc', { title: 'Claude Code', kind: 'agent', agentId: 'claude' }), leaf('pane-8-ed', { view: 'editor', title: 'App.vue' })] },
      activeId: 'pane-7-abc',
      maximizedId: null
    }
    shareHost = createShareHost({
      secret,
      hostName: 'Cedric',
      callbacks: {
        listPanes: () => panes,
        layout: () => hostLayout,
        snapshot: async (id) => ({ data: `screen of ${id}`, cols: 100, rows: 30 }),
        write: (id, data) => remote.writes.push([id, data]),
        openPane: (spec) => remote.opened.push(spec),
        closePane: (id) => remote.closed.push(id),
        askApproval: (g) =>
          new Promise((resolve) => {
            remote.asked.push(g.name)
            remote.approve = resolve
          })
      }
    })
    const port = await shareHost.start()
    const m = fakeMain()
    mains.push(m)

    const invite = encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret })
    expect(await m.handle['liveShare:join'](null, { invite, name: 'Alex' })).toEqual({ ok: true })
    await until(() => remote.approve)
    expect(remote.asked).toEqual(['Alex'])
    await until(() => m.last('liveShare:guest')?.state === 'waiting')
    expect(m.events('liveShare:guest')[0]).toMatchObject({ state: 'connecting', panes: [], layout: null })
    remote.approve(true)

    const joined = await until(() => m.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    const localId = 'pane-ls1-7-abc'
    expect(joined).toMatchObject({ host: 'Cedric', session: 1, reason: null })
    expect(joined.panes).toEqual([{ id: localId, title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: '#3366ff', cols: 100, rows: 30 }])
    expect(joined.layout).toEqual({
      project: 'tessel',
      tree: {
        type: 'split',
        dir: 'row',
        sizes: [60, 40],
        children: [
          { type: 'leaf', id: localId, view: 'terminal', title: 'Claude Code', kind: 'agent', agentId: 'claude', accent: null },
          { type: 'leaf', id: 'pane-ls1-8-ed', view: 'editor', title: 'App.vue', kind: 'shell', agentId: null, accent: null }
        ]
      },
      activeId: localId,
      maximizedId: null
    })
    expect((await m.handle['liveShare:state']()).guest).toMatchObject({ state: 'joined', host: 'Cedric' })

    // Its pty calls: the host's pane, never one of this computer.
    expect(m.api.isGuestPane(localId)).toBe(true)
    expect(m.api.isGuestPane('pane-7-abc')).toBe(false)
    expect(m.api.isGuestPane('pane-ls1-8-ed')).toBe(false) // an editor: no terminal
    const attached = await m.api.guestAttach(localId)
    expect(attached).toMatchObject({ ok: true, backend: 'liveshare', shell: { id: 'liveshare', name: 'Cedric' }, pid: null, exited: false, buffer: 'screen of pane-7-abc' })
    expect(await m.api.guestAttach('pane-ls1-nope')).toEqual({ ok: false })

    // Output after the snapshot comes as the window's pty:data.
    shareHost.sendData('pane-7-abc', '\r\nhello')
    await until(() => m.data.length)
    expect(m.data).toEqual([[localId, '\r\nhello']])

    m.api.guestWrite(localId, 'ls\r')
    m.api.guestWrite('pane-ls1-nope', 'rm -rf /\r')
    m.api.guestWrite(localId, { not: 'text' })
    await until(() => remote.writes.length)
    expect(remote.writes).toEqual([['pane-7-abc', 'ls\r']])

    expect(await m.handle['liveShare:open'](null, { kind: 'agent', agent: 'codex' })).toEqual({ ok: true })
    await until(() => remote.opened.length)
    expect(remote.opened).toEqual([{ kind: 'agent', agent: 'codex' }])

    // Closing it here closes it on the host (which then removes it).
    m.api.guestKill(localId)
    await until(() => remote.closed.length)
    expect(remote.closed).toEqual(['pane-7-abc'])

    shareHost.sendExit('pane-7-abc', 3)
    await until(() => m.exits.length)
    expect(m.exits).toEqual([[localId, 3]])

    panes = []
    shareHost.panesChanged()
    await until(() => !m.api.isGuestPane(localId))
    expect(m.last('liveShare:guest').panes).toEqual([])
    expect(m.exits).toEqual([[localId, 3], [localId, 0]]) // an attached pane ends in the window

    expect(await m.handle['liveShare:leave']()).toEqual({ ok: true })
    expect(m.last('liveShare:guest')).toMatchObject({ state: 'ended', reason: 'left' })
    await until(() => shareHost.guests().length === 0)
    expect((await m.handle['liveShare:state']()).guest).toMatchObject({ state: 'off', panes: [] })
  })

  it('refuses what is not an invite, and ends when the host says no', async () => {
    const m = fakeMain()
    mains.push(m)
    const bad = await m.handle['liveShare:join'](null, { invite: 'hello', name: 'Alex' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/invite/)
    // Only to this PC or the local network without TLS.
    expect(await m.handle['liveShare:join'](null, { invite: encodeInvite({ url: 'ws://example.com/', secret: newSecret() }) })).toMatchObject({ ok: false })
    expect(m.events('liveShare:guest')).toEqual([])

    const secret = newSecret()
    shareHost = createShareHost({ secret, hostName: 'Cedric', callbacks: { listPanes: () => [], snapshot: async () => null, write: () => {}, askApproval: async () => false } })
    const port = await shareHost.start()
    await m.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }) })
    await until(() => m.last('liveShare:guest')?.state === 'ended')
    expect(m.last('liveShare:guest').reason).toBe('denied')
    expect(await m.handle['liveShare:open'](null, { kind: 'terminal' })).toEqual({ ok: false })
  })
})

describe('registerLiveShare: one Tessel shares, another joins', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  it('shares the window layout and terminals, asks before letting a guest in, and ends for everyone on stop', async () => {
    const host = fakeMain({ snapshot: () => 'PS C:\\> ' })
    const guest = fakeMain()
    mains.push(host, guest)

    host.on['liveShare:layout'](null, { project: 'site', tree: { type: 'split', children: [leaf('pane-1-ps', { title: 'PowerShell' }), leaf('pane-2-web', { view: 'browser', title: 'localhost' })] }, activeId: 'pane-1-ps' })
    host.api.noteSize('pane-1-ps', 120, 40)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric' })
    expect(started).toMatchObject({ ok: true, state: 'sharing', guests: [], error: null })
    expect(host.events('liveShare:host').map((s) => s.state)).toEqual(['preparing', 'starting', 'checking', 'sharing'])
    const invite = started.invite
    expect(decodeInvite(invite).url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/)
    // Starting again while sharing keeps the same session.
    expect((await host.handle['liveShare:start'](null, {})).invite).toBe(invite)

    await guest.handle['liveShare:join'](null, { invite, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    expect(ask).toMatchObject({ name: 'Alex' })
    expect(await host.handle['liveShare:approve'](null, { guestId: 'g-unknown', yes: true })).toEqual({ ok: false })
    expect(await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true })).toEqual({ ok: true })

    const joined = await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    const localId = 'pane-ls1-1-ps'
    expect(joined).toMatchObject({ host: 'Cedric', panes: [{ id: localId, title: 'PowerShell', kind: 'shell', cols: 120, rows: 40 }] })
    expect(joined.layout.tree.children.map((c) => c.id)).toEqual([localId, 'pane-ls1-2-web'])
    expect(joined.layout.activeId).toBe(localId)
    await until(() => host.last('liveShare:host').guests.some((g) => g.name === 'Alex' && g.state === 'joined'))

    // The snapshot is the terminal host's screen, taken through ptyClient's onReply.
    expect(await guest.api.guestAttach(localId)).toMatchObject({ ok: true, buffer: 'PS C:\\> ' })
    expect(host.host.request).toHaveBeenCalledWith('attach', { id: 'pane-1-ps' }, undefined, expect.any(Function))

    host.api.onPtyData('pane-1-ps', 'dir\r\n')
    host.api.onPtyData('pane-9-not-shown', 'secret\r\n')
    await until(() => guest.data.length)
    expect(guest.data).toEqual([[localId, 'dir\r\n']])

    guest.api.guestWrite(localId, 'exit\r')
    await until(() => host.hostWrites.length)
    expect(host.hostWrites).toEqual([['pane-1-ps', 'exit\r']])

    // A guest's open / close goes to the host's window to do.
    await guest.handle['liveShare:open'](null, { kind: 'terminal' })
    guest.api.guestKill(localId)
    await until(() => host.events('liveShare:hostRequest').length === 2)
    expect(host.events('liveShare:hostRequest')).toEqual([
      { action: 'open', spec: { kind: 'terminal', agent: undefined }, guest: expect.objectContaining({ name: 'Alex' }) },
      { action: 'close', id: 'pane-1-ps', guest: expect.objectContaining({ name: 'Alex' }) }
    ])

    // The host's window resized the pane: the guest shows it at that size.
    host.api.noteSize('pane-1-ps', 90, 25)
    await until(() => guest.last('liveShare:guest').panes[0]?.cols === 90)
    expect(guest.last('liveShare:guest').panes[0]).toMatchObject({ cols: 90, rows: 25 })

    host.api.onPtyExit('pane-1-ps', 0)
    await until(() => guest.exits.length)
    expect(guest.exits).toEqual([[localId, 0]])

    expect(await host.handle['liveShare:stop']()).toEqual({ ok: true })
    expect(host.last('liveShare:host')).toMatchObject({ state: 'off', invite: null, guests: [] })
    await until(() => guest.last('liveShare:guest').state === 'ended')
    expect(guest.last('liveShare:guest').reason).toBe('stopped')
    expect(guest.api.isGuestPane(localId)).toBe(false)
  })

  it('a guest the host says no to, or removes, is out', async () => {
    const host = fakeMain()
    const a = fakeMain()
    const b = fakeMain()
    mains.push(host, a, b)
    host.on['liveShare:layout'](null, { tree: leaf('pane-1-ps') })
    const { invite } = await host.handle['liveShare:start'](null, {})

    await a.handle['liveShare:join'](null, { invite, name: 'Alex' })
    const askA = await until(() => host.events('liveShare:ask').find((q) => q.name === 'Alex'))
    await host.handle['liveShare:approve'](null, { guestId: askA.guestId, yes: false })
    await until(() => a.last('liveShare:guest')?.state === 'ended')
    expect(a.last('liveShare:guest').reason).toBe('denied')

    await b.handle['liveShare:join'](null, { invite, name: 'Bea' })
    const askB = await until(() => host.events('liveShare:ask').find((q) => q.name === 'Bea'))
    await host.handle['liveShare:approve'](null, { guestId: askB.guestId, yes: true })
    await until(() => b.last('liveShare:guest')?.state === 'joined')
    await host.handle['liveShare:removeGuest'](null, { guestId: askB.guestId })
    await until(() => b.last('liveShare:guest')?.state === 'ended')
    expect(b.last('liveShare:guest').reason).toBe('removed')
    await until(() => host.last('liveShare:host').guests.length === 0)
  })
})
