// @vitest-environment node
// Live Share phase 2c end to end over real WebSockets on 127.0.0.1 (only
// Cloudflare's tunnel is faked): the channel's page stream (shareHost.js,
// shareGuest.js: a 'page' subscription needs "See my browser pages", is the
// guest's own stream, one page at a time, ends the moment the right goes;
// input needs "Use my browser pages" on the page it watches), then two
// Tessels (liveShare.js): the host's past conversations, what its terminal
// agents said and its activity reach the guest masked, with no session id,
// account or folder; the host's browser panes of a shared project's layout
// (never another page) stream to a guest that watches one, hidden and
// paused pages show nothing, the guest's clicks and keys reach the page with
// the right (refusals and limits said back), a new window from its click is
// its own, and taking the right away stops the frames at once.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { registerLiveShare } from '../liveShare'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey, encodeInvite } from '../liveShare/shareCrypto'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => ({ url: `ws://127.0.0.1:${port}/`, stop: vi.fn(), pid: 4242 })),
  waitReachable: vi.fn(async () => true),
  waitRegistered: vi.fn(async () => true),
  tunnelLogTail: vi.fn(() => ''),
  endLeftoverTunnel: vi.fn(async () => false),
  tunnelState: vi.fn(async () => 'ours'),
  stopTunnelPid: vi.fn(async () => true),
  stopTunnelLater: vi.fn(),
  processState: vi.fn(async () => null)
}))

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function jpeg(w, h, bytes = 4000) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))])
}
// A browser page as the host's main process sees it (its debugger answers
// as Chromium's would, enough for the screencast and the input).
function fakePage(id, { url = 'https://mail.example/inbox/42?code=abc', title = 'Inbox' } = {}) {
  const dbg = new EventEmitter()
  const state = { url, title, focus: 'none', destroyed: false, inFlight: 0 }
  dbg.attached = false
  dbg.sent = []
  dbg.isAttached = () => dbg.attached
  dbg.attach = vi.fn(() => (dbg.attached = true))
  dbg.detach = vi.fn(() => {
    dbg.attached = false
    dbg.emit('detach', {}, 'target closed')
  })
  const node = () => (state.focus === 'password' ? 40 : 30)
  const answers = {
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'F', loaderId: 'L' } } }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 7 }),
    'Runtime.evaluate': (p) => {
      if (String(p.expression).includes("querySelectorAll('*')")) return { result: {} }
      if (state.focus === 'none') return { result: { type: 'object', subtype: 'null' } }
      return { result: { objectId: `n${node()}` } }
    },
    'Runtime.callFunctionOn': () => ({ result: { value: state.focus === 'password' } }),
    'DOM.describeNode': () => ({ node: { backendNodeId: node(), nodeName: 'INPUT' } }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0 }, cssLayoutViewport: { clientWidth: 1000, clientHeight: 700 } }),
    'Page.captureScreenshot': () => ({ data: jpeg(1000, 700).toString('base64') }),
    'Page.startScreencast': () => ((state.inFlight = 0), {}),
    'Page.screencastFrameAck': () => ((state.inFlight = Math.max(0, state.inFlight - 1)), {})
  }
  dbg.sendCommand = vi.fn(async (method, params) => {
    dbg.sent.push([method, params])
    const a = answers[method]
    return typeof a === 'function' ? a(params) : {}
  })
  return {
    id,
    state,
    debugger: dbg,
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    capturePage: vi.fn(async () => null),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => (state.focus === 'password' ? 'secret' : 'ok')),
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    paint() {
      state.inFlight = 0
      dbg.emit('message', {}, 'Page.screencastFrame', { data: jpeg(1000, 700).toString('base64'), metadata: { deviceWidth: 1000, deviceHeight: 700 }, sessionId: 1 })
    },
    sentOf: (method) => dbg.sent.filter(([m]) => m === method).map(([, p]) => p)
  }
}

// --- The channel's page stream ------------------------------------------------------
describe('Live Share pages: the channel', () => {
  let host
  afterEach(() => host?.stop())

  it('a page needs its right, is one guest stream, one page at a time, ends with the right; input needs "use" on the watched page', async () => {
    const streams = []
    const inputs = []
    const callbacks = {
      projects: () => [{ id: 'ws-1', layout: { project: 'site', tree: { type: 'leaf', id: 'pane-1', view: 'terminal', title: 't', kind: 'shell' }, activeId: 'pane-1' }, panes: [{ id: 'pane-1', title: 't', kind: 'shell', cols: 80, rows: 24 }] }],
      snapshot: async () => ({ data: '', cols: 80, rows: 24 }),
      write: () => {},
      openPane: () => {},
      closePane: () => {},
      askApproval: async () => true,
      watchGuest: (topic, project, key, stream, on) => streams.push({ topic, project, key, stream, on }),
      pageInput: async (stream, project, page, events, mayUse) => {
        inputs.push({ project, page, events, may: mayUse() })
        return { ok: true, done: events.length, refused: events.some((e) => e.button === 'right') ? ['button'] : [] }
      }
    }
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks })
    const port = await host.start()
    const r = { frames: [], events: [], rights: [], states: [] }
    const client = createShareGuest({
      url: `ws://127.0.0.1:${port}/`,
      secret,
      name: 'Alex',
      signingKey: newSigningKey(),
      callbacks: {
        onState: (s) => r.states.push(s),
        onProjects: (p) => (r.projects = p),
        onRights: (x) => r.rights.push(x),
        onPageFrame: (m) => r.frames.push(m),
        onPageEvent: (m) => r.events.push(m)
      }
    })
    client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    expect(client.speaks('pages')).toBe(true)
    // No requests on this host: no history.
    expect(client.speaks('history')).toBe(false)
    const id = host.guests().find((g) => g.name === 'Alex').id
    // Without the right: the subscription is ignored.
    client.subscribe('page', 'ws-1', 'pane-web', true)
    await wait(80)
    expect(streams).toEqual([])
    host.setGrant(id, { rights: { pagesView: true } })
    await until(() => r.rights.length === 2)
    client.subscribe('page', 'ws-1', 'pane-web', false)
    client.subscribe('page', 'ws-1', 'pane-web', true)
    await until(() => streams.length === 1)
    const s = streams[0]
    expect(s).toMatchObject({ topic: 'page', project: 'ws-1', key: 'pane-web', on: true })
    expect(s.stream).toMatchObject({ name: 'Alex' })
    expect(s.stream.live()).toBe(true)
    expect(s.stream.send('frame', { seq: 1, jpeg: 'AAAA', w: 1, h: 1, meta: {} })).toBe(true)
    expect(s.stream.send('push', {})).toBe(false)
    await until(() => r.frames.length === 1)
    expect(r.frames[0]).toMatchObject({ t: 'frame', project: 'ws-1', page: 'pane-web', seq: 1 })
    // A second page while one is watched: ignored (one page per guest).
    client.subscribe('page', 'ws-1', 'pane-web2', true)
    await wait(80)
    expect(streams).toHaveLength(1)
    // Input without "use": refused, nothing reaches the host's page.
    client.input('ws-1', 'pane-web', [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }])
    await until(() => r.events.length === 1)
    expect(r.events[0]).toMatchObject({ t: 'page', page: 'pane-web', state: 'input', code: 'forbidden' })
    expect(inputs).toEqual([])
    host.setGrant(id, { rights: { pagesView: true, pagesUse: true } })
    await until(() => r.rights.length === 3)
    client.input('ws-1', 'pane-web', [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'right' }])
    await until(() => inputs.length === 1 && r.events.length === 2)
    expect(inputs[0]).toMatchObject({ project: 'ws-1', page: 'pane-web', may: true })
    expect(r.events[1]).toMatchObject({ state: 'input', refused: ['button'] })
    // Input on a page it does not watch: ignored.
    client.input('ws-1', 'pane-web2', [{ type: 'key', key: 'a' }])
    await wait(80)
    expect(inputs).toHaveLength(1)
    // The host ends the page for everyone (endTopic): that guest's stream ends.
    host.endTopic('page', 'ws-1', 'pane-web')
    await until(() => streams.length === 2)
    expect(streams[1]).toMatchObject({ on: false })
    expect(streams[1].stream).toBe(s.stream)
    expect(s.stream.send('frame', { seq: 2, jpeg: 'AAAA' })).toBe(false)
    client.subscribe('page', 'ws-1', 'pane-web', false)
    client.subscribe('page', 'ws-1', 'pane-web', true)
    await until(() => streams.length === 3)
    const s2 = streams[2]
    // The right taken away: the stream ends at once and sends nothing more.
    host.change(id, { right: 'pagesView', on: false })
    await until(() => streams.length === 4)
    expect(streams[3]).toMatchObject({ on: false })
    expect(streams[3].stream).toBe(s2.stream)
    expect(s2.stream.live()).toBe(false)
    expect(s2.stream.send('frame', { seq: 3, jpeg: 'AAAA' })).toBe(false)
    client.leave()
  })
})

// --- Two Tessels ------------------------------------------------------------------------
let tmp
const dataDirs = []
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsfeeds-')))
  fs.mkdirSync(join(tmp, 'site', 'src'), { recursive: true })
})
afterEach(() => {
  for (const d of dataDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function fakeMain({ pages = [] } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsfeeds-data-'))
  dataDirs.push(dir)
  const byId = new Map(pages.map((p) => [p.id, p]))
  const m = {
    handle: {},
    on: {},
    sent: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: { request: vi.fn(async (op, body, _t, onReply) => (onReply?.({ ok: true, buffer: '' }), { ok: true, buffer: '' })), send: vi.fn() },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1),
    sessions: {
      list: vi.fn(async () => [{ agent: 'claude', id: SESSION, cwd: join(tmp, 'site'), started: 1, updated: 2, title: `Ship it with ${SECRET}`, accountId: 'acct-7', accountLabel: 'ada@example.com' }]),
      details: vi.fn(async () => ({ ok: true, file: join(tmp, 'x.jsonl'), firstPrompt: `Read ${join(tmp, 'site', 'src', 'a.js')}, ${join(tmp, 'site', '.env')} and C:\\Users\\ada\\private.txt`, turns: [{ role: 'assistant', text: 'Done', at: 3 }], messageCount: 2 }))
    },
    readTerminal: vi.fn(async (q) => ({ ok: true, panes: Object.fromEntries(q.panes.map((p) => [p.ask, { key: `${p.sessionId}|s|0`, items: [{ role: 'user', t: 5, text: `my key ${SECRET}` }, { role: 'agent', t: 6, text: 'ok' }] }])) }))
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir: dir,
    queueData: () => {},
    sendExit: () => {},
    log: { info: () => {}, warn: () => {} },
    kill: vi.fn(),
    pidRunning: () => true,
    resume: false,
    watchProject: () => () => {},
    makeFileWatcher: () => ({ set: () => 0, close: () => {} }),
    sessionHistory: m.sessions,
    readTerminal: m.readTerminal,
    pageById: (id) => byId.get(id) || null
  })
  return m
}

const term = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })
const web = (id) => ({ type: 'leaf', id, view: 'browser', title: '' })

describe('Live Share phase 2c: two Tessels', () => {
  const mains = []
  afterEach(() => {
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function session({ pages = [] } = {}) {
    const host = fakeMain({ pages })
    const guest = fakeMain()
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1', 'ws-2'] })
    const tree = { type: 'split', dir: 'row', sizes: [40, 30, 30], children: [term('pane-1-ag', { kind: 'agent', agentId: 'claude' }), web('pane-web'), web('pane-web2')] }
    host.on['liveShare:layouts'](null, [
      { id: 'ws-1', layout: { project: 'site', tree, activeId: 'pane-1-ag' }, chats: [{ id: 'pane-1-ag', agentId: 'claude', sessionId: SESSION, accountId: 'acct-7', terminal: true, roots: [join(tmp, 'site')] }], root: join(tmp, 'site') },
      { id: 'ws-2', layout: { project: 'other', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('pane-2'), web('pane-web3')] }, activeId: 'pane-2' }, chats: [], root: null }
    ])
    await guest.handle['liveShare:join'](null, { invite: started.invites[0].code, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    // The guest sees ws-1 only.
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.projects.length))
    const give = async (right, on = true) => {
      expect(await host.handle['liveShare:access'](null, { subject: ask.guestId, right, on })).toEqual({ ok: true })
      await until(() => guest.last('liveShare:guest').rights?.[right] === on)
    }
    const status = guest.last('liveShare:guest')
    const leaves = status.projects[0].layout.tree.children.map((c) => c.id)
    return { host, guest, give, guestId: ask.guestId, local: { agent: leaves[0], web: leaves[1], web2: leaves[2] } }
  }

  it('past conversations, terminal agents and activity reach the guest masked, without ids, accounts or folders', async () => {
    const { host, guest, local } = await session()
    expect(guest.last('liveShare:guest').features).toEqual(expect.arrayContaining(['history', 'pages']))
    const list = await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-1', args: { limit: 30 } })
    expect(host.sessions.list).toHaveBeenCalledWith({ cwd: join(tmp, 'site'), limit: 30 })
    expect(list.ok).toBe(true)
    expect(list.sessions).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), agent: 'claude', title: expect.stringContaining('••••'), started: 1, updated: 2 }])
    const details = await guest.handle['liveShare:sessions'](null, { op: 'details', project: 'ws-1', args: { ref: list.sessions[0].id } })
    expect(host.sessions.details).toHaveBeenCalledWith({ agent: 'claude', id: SESSION, accountId: 'acct-7' })
    expect(details).toEqual({ ok: true, firstPrompt: expect.stringContaining('src'), turns: [{ role: 'assistant', text: 'Done', at: 3 }], messageCount: 2 })
    expect(details.firstPrompt).not.toContain('private')
    // A hidden file of the project is never named (as in its Files tab).
    expect(details.firstPrompt).not.toContain('.env')
    // Another project of the host's: not this guest's.
    expect(await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-2', args: {} })).toEqual({ ok: false, code: 'no-project' })
    const terminal = await guest.handle['liveShare:sessions'](null, { op: 'terminal', project: 'ws-1', args: { from: 0 } })
    expect(Object.keys(terminal.panes)).toEqual([local.agent])
    expect(terminal.panes[local.agent].items.map((i) => i.role)).toEqual(['user', 'agent'])
    expect(terminal.panes[local.agent].items[0].text).not.toContain(SECRET)
    const again = await guest.handle['liveShare:sessions'](null, { op: 'terminal', project: 'ws-1', args: { from: 0, known: { [local.agent]: terminal.panes[local.agent].key } } })
    expect(host.readTerminal.mock.calls[1][0].known).toEqual({ 'pane-1-ag': `${SESSION}|s|0` })
    expect(again.ok).toBe(true)

    // Activity: sent by the host's window only while a guest follows it.
    expect(host.events('liveShare:feeds')).toEqual([])
    const sub = await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: true })
    expect(sub).toMatchObject({ ok: true, outdated: false })
    await until(() => host.last('liveShare:feeds')?.activity?.includes('ws-1'))
    host.on['liveShare:activity'](null, [
      { project: 'ws-1', events: [{ t: 1, type: 'message', paneId: 'pane-1-ag', text: `use ${SECRET} from .tessel/team/tok999/inbox.json`, sender: { name: 'Ada', sessionId: SESSION, accountId: 'acct-7' } }], teams: [{ id: 'team-1', name: 'Builders', color: '#00ff00' }] },
      { project: 'ws-2', events: [{ t: 1, type: 'message', text: 'not for this guest' }] }
    ])
    const pushed = await until(() => guest.events('liveShare:push').find((p) => p.topic === 'activity'))
    expect(pushed.project).toBe('ws-1')
    expect(pushed.data.events).toEqual([{ t: 1, type: 'message', paneId: local.agent, text: expect.not.stringContaining(SECRET), sender: { name: 'Ada' }, wsId: 'ws-1' }])
    expect(pushed.data.events[0].text).toMatch(/from …$/)
    expect(pushed.data.teams).toEqual([{ id: 'team-1', name: 'Builders', color: '#00ff00' }])
    await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: false })
    await until(() => host.last('liveShare:feeds')?.activity?.length === 0)

    const said = JSON.stringify(guest.sent)
    for (const leak of [SESSION, 'acct-7', 'ada@example.com', SECRET, tmp, tmp.replace(/\\/g, '\\\\'), 'not for this guest', 'x.jsonl', 'tok999']) expect(said).not.toContain(leak)
  })

  it('pages: only the shared project panes, frames while watched, one at a time, input with the right, hidden and paused show nothing, the right taken away stops them', async () => {
    const p11 = fakePage(11)
    const p12 = fakePage(12, { url: 'http://localhost:5173/', title: 'Dev' })
    const p13 = fakePage(13)
    const p14 = fakePage(14)
    const { host, guest, give, local } = await session({ pages: [p11, p12, p13, p14] })
    host.on['liveShare:pages'](null, [
      { project: 'ws-1', paneId: 'pane-web', webContentsId: 11 },
      { project: 'ws-1', paneId: 'pane-web2', webContentsId: 12 },
      // The side panel's page (no pane of a layout), and another project's.
      { project: 'ws-1', paneId: 'web-side', webContentsId: 13 },
      { project: 'ws-2', paneId: 'pane-web3', webContentsId: 14 }
    ])
    // Without "See my browser pages": refused here, nothing on the host.
    expect(await guest.handle['liveShare:pageWatch'](null, { id: local.web, on: true })).toEqual({ ok: false, code: 'forbidden' })
    await give('pagesView')
    expect(await guest.handle['liveShare:pageWatch'](null, { id: 'pane-nowhere', on: true })).toEqual({ ok: false, code: 'missing' })
    expect(await guest.handle['liveShare:pageWatch'](null, { id: local.web, on: true })).toEqual({ ok: true })
    await until(() => p11.debugger.attached)
    expect(p13.debugger.attach).not.toHaveBeenCalled()
    expect(p14.debugger.attach).not.toHaveBeenCalled()
    const watched = await until(() => host.events('liveShare:pagesWatched').find((l) => l.length === 1))
    expect(watched).toEqual([{ id: 'pane-web', guests: [{ id: expect.any(String), name: 'Alex' }] }])
    p11.paint()
    const frame = await until(() => guest.last('liveShare:pageFrame'))
    expect(frame).toMatchObject({ id: local.web, seq: 1, w: 1000, h: 700, meta: { title: 'Inbox', url: 'https://mail.example/inbox/42?…' } })
    expect(Buffer.isBuffer(frame.jpeg)).toBe(true)
    // One page at a time: the second replaces the first.
    expect(await guest.handle['liveShare:pageWatch'](null, { id: local.web2, on: true })).toEqual({ ok: true })
    await until(() => p12.debugger.attached && !p11.debugger.attached)
    p12.paint()
    await until(() => guest.events('liveShare:pageFrame').some((f) => f.id === local.web2))
    // Input: refused without "use" (never sent), then with it.
    guest.on['liveShare:pageInput'](null, { id: local.web2, events: [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }] })
    await wait(100)
    expect(p12.sentOf('Input.dispatchMouseEvent')).toEqual([])
    await give('pagesUse')
    guest.on['liveShare:pageInput'](null, { id: local.web2, events: [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }, { type: 'mouse', action: 'up', x: 0.5, y: 0.5, button: 'left' }, { type: 'mouse', action: 'down', x: 0.2, y: 0.2, button: 'right' }, { type: 'key', key: 'v', modifiers: { ctrl: true } }] })
    await until(() => p12.sentOf('Input.dispatchMouseEvent').length === 2)
    expect(p12.sentOf('Input.dispatchMouseEvent')[0]).toMatchObject({ type: 'mousePressed', x: 500, y: 350, button: 'left' })
    const refused = await until(() => guest.events('liveShare:pageEvent').find((e) => e.state === 'input'))
    expect(refused).toEqual({ id: local.web2, state: 'input', refused: ['button', 'key'] })
    // A new window from that click: the guest's (a new pane in the guest session).
    expect(host.api.pagePopup(12)).toEqual({ allowed: true })
    expect(host.api.pagePopup(11)).toBe(null)
    // Past the clicks' limit: a notice, once.
    const many = Array.from({ length: 25 }, () => ({ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }))
    guest.on['liveShare:pageInput'](null, { id: local.web2, events: many })
    await until(() => guest.events('liveShare:pageEvent').some((e) => e.notice === 'limit'))
    // Hidden by the host: paused, nothing captured.
    host.on['liveShare:pages'](null, [
      { project: 'ws-1', paneId: 'pane-web', webContentsId: 11 },
      { project: 'ws-1', paneId: 'pane-web2', webContentsId: 12, hidden: true }
    ])
    await until(() => guest.events('liveShare:pageEvent').some((e) => e.state === 'paused' && e.reason === 'hidden'))
    await until(() => !p12.debugger.attached)
    host.on['liveShare:pages'](null, [
      { project: 'ws-1', paneId: 'pane-web', webContentsId: 11 },
      { project: 'ws-1', paneId: 'pane-web2', webContentsId: 12 }
    ])
    await until(() => p12.debugger.attached)
    // A password field with the keyboard: paused.
    p12.state.focus = 'password'
    await wait(600)
    p12.paint()
    await until(() => guest.events('liveShare:pageEvent').some((e) => e.state === 'paused' && e.reason === 'password'))
    p12.state.focus = 'none'
    await wait(600)
    const before = guest.events('liveShare:pageFrame').length
    p12.paint()
    await until(() => guest.events('liveShare:pageFrame').length > before)
    // The right taken away: frames stop at once, the capture ends.
    await give('pagesView', false)
    await until(() => !p12.debugger.attached)
    const count = guest.events('liveShare:pageFrame').length
    p12.paint()
    await wait(300)
    expect(guest.events('liveShare:pageFrame')).toHaveLength(count)
    await until(() => host.last('liveShare:pagesWatched').length === 0)
  })

  it('an older host: no page and no history, said as such', async () => {
    const secret = newSecret()
    const old = createShareHost({
      secret,
      hostName: 'Old',
      callbacks: {
        projects: () => [{ id: 'ws-1', layout: { project: 'site', tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('pane-1'), web('pane-web')] }, activeId: 'pane-1' }, panes: [{ id: 'pane-1', title: 'x', kind: 'shell', cols: 80, rows: 24 }] }],
        snapshot: async () => ({ data: '', cols: 80, rows: 24 }),
        write: () => {},
        openPane: () => {},
        closePane: () => {},
        askApproval: async () => ({ yes: true, projects: ['ws-1'], rights: { pagesView: true } })
      }
    })
    const port = await old.start()
    const guest = fakeMain()
    mains.push(guest)
    try {
      await guest.handle['liveShare:join'](null, { invite: encodeInvite({ url: `ws://127.0.0.1:${port}/`, secret }), name: 'Alex' })
      const s = await until(() => guest.events('liveShare:guest').find((x) => x.state === 'joined' && x.projects.length))
      expect(s.features).not.toContain('pages')
      expect(s.features).not.toContain('history')
      const pageId = s.projects[0].layout.tree.children[1].id
      expect(await guest.handle['liveShare:pageWatch'](null, { id: pageId, on: true })).toEqual({ ok: false, code: 'outdated-host' })
      expect(await guest.handle['liveShare:sessions'](null, { op: 'list', project: 'ws-1', args: {} })).toEqual({ ok: false, code: 'outdated-host' })
      expect(await guest.handle['liveShare:subscribe'](null, { topic: 'activity', project: 'ws-1', on: true })).toMatchObject({ outdated: true })
    } finally {
      old.stop()
    }
  })
})
