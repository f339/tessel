// Live Share with several projects shared (liveShare/shareHost.js): each
// guest sees only its own projects (the layouts, panes, screens and output of
// those), every request it makes is checked against them at the moment it
// comes (a project taken out of the share, a pane moved to another project),
// projects come and go on the spot, and what a guest sees lasts across its
// reconnects and a restart. Real WebSockets on 127.0.0.1.
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createShareHost, SHARE_PROTOCOL, cleanProjectIds, MAX_PROJECTS } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ALL = { type: true, open: true, close: true }
const pane = (id) => ({ id, title: id, kind: 'shell', cols: 80, rows: 24 })
const layoutOf = (name, ids) => ({ project: name, tree: ids.length ? { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell' })) } : null, activeId: ids[0] || null, maximizedId: null })

// The host's Tessel: projects (id -> pane ids), in order, shared now. A
// guest's answer comes from answers[name] (true, false or { yes, projects }).
function fakeTessel(projects) {
  const t = {
    shared: projects,
    answers: {},
    writes: [],
    opened: [],
    closed: [],
    snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
    callbacks: {
      projects: () => Object.entries(t.shared).map(([id, ids]) => ({ id, layout: layoutOf(`name of ${id}`, ids), panes: ids.map(pane) })),
      snapshot: (id, ready) => t.snapshot(id, ready),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec, guest) => t.opened.push([guest.name, spec]),
      closePane: (id, guest) => t.closed.push([guest.name, id]),
      agents: () => [{ id: 'codex', name: 'Codex' }],
      askApproval: async (g) => (g.name in t.answers ? t.answers[g.name] : true)
    }
  }
  return t
}

function recorder() {
  const r = { states: [], projects: null, lists: [], screens: {}, snapshots: [], data: [], exits: [], restarts: [], closed: null, rights: [] }
  r.callbacks = {
    onState: (s) => r.states.push(s),
    onProjects: (projects) => {
      r.projects = projects
      r.lists.push(projects)
    },
    onSnapshot: (id, data) => {
      r.screens[id] = data
      r.snapshots.push(id)
    },
    onData: (id, data) => {
      r.screens[id] = (r.screens[id] || '') + data
      r.data.push([id, data])
    },
    onExit: (id, code) => r.exits.push([id, code]),
    onRestart: (id) => r.restarts.push(id),
    onRights: (rights) => r.rights.push(rights),
    onHostKey: (key) => (r.hostKey = key),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}
const ids = (r) => (r.projects || []).map((p) => p.id)
const paneIds = (r) => (r.projects || []).flatMap((p) => p.panes.map((x) => x.id))

describe('Live Share: several projects, each guest its own', () => {
  let host
  afterEach(() => host?.stop())

  async function share(t, extra = {}) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks, ...extra })
    const port = await host.start()
    return { secret, port }
  }
  function join({ port, secret }, name, key = newSigningKey()) {
    const r = recorder()
    const client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: key, callbacks: r.callbacks })
    client.connect()
    r.client = client
    r.key = key
    return r
  }
  const guestOf = (name) => host.guests().find((g) => g.name === name)
  async function joined(conn, name) {
    const r = join(conn, name)
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }

  it('sends each guest only the layouts, panes, screens and output of its own projects', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    const bea = await joined(conn, 'Bea') // the default: every project shared
    expect(ids(alex)).toEqual(['ws-a'])
    expect(alex.projects[0].layout.project).toBe('name of ws-a')
    expect(paneIds(alex)).toEqual(['a1'])
    expect(ids(bea)).toEqual(['ws-a', 'ws-b'])
    await until(() => alex.screens.a1 && bea.screens.a1 && bea.screens.b1)
    expect(alex.snapshots).toEqual(['a1'])
    expect(guestOf('Alex').projects).toEqual(['ws-a'])
    expect(guestOf('Bea').projects).toEqual(['ws-a', 'ws-b'])

    host.sendData('b1', 'SECRET-B')
    host.sendData('a1', 'hello')
    host.paneRestarted('b1')
    host.sendExit('b1', 3)
    await until(() => bea.exits.length && alex.data.length)
    await wait(40)
    expect(alex.data).toEqual([['a1', 'hello']])
    expect(alex.exits).toEqual([])
    expect(alex.restarts).toEqual([])
    expect(JSON.stringify(alex)).not.toContain('SECRET-B')
    expect(bea.data).toContainEqual(['b1', 'SECRET-B'])
  })

  it('takes no request of a guest about a project it does not see', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    host.setGrant(guestOf('Alex').id, { rights: ALL })
    await until(() => alex.rights.length === 2)
    await until(() => alex.screens.a1)
    alex.client.write('b1', 'rm -rf /\r')
    alex.client.close('b1')
    alex.client.resync('b1')
    alex.client.open({ kind: 'terminal', project: 'ws-b' })
    alex.client.open({ kind: 'terminal', project: 'ws-nope' })
    alex.client.open({ kind: 'terminal', project: { not: 'an id' } })
    alex.client.write('a1', 'ls\r')
    alex.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    await until(() => t.opened.length === 1 && t.writes.length === 1)
    await wait(40)
    expect(t.writes).toEqual([['a1', 'ls\r']])
    expect(t.closed).toEqual([])
    expect(t.opened).toEqual([['Alex', { kind: 'agent', agent: 'codex', project: 'ws-a' }]])
    expect(alex.snapshots).toEqual(['a1'])
  })

  it('a project shared later is no guest’s until the host gives it; given, it comes at once, and taken back, it goes at once', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    expect(ids(alex)).toEqual(['ws-a'])
    t.shared = { 'ws-a': ['a1'], 'ws-b': ['b1'] }
    host.panesChanged()
    await until(() => alex.lists.length === 2)
    expect(ids(alex)).toEqual(['ws-a'])
    expect(guestOf('Alex').projects).toEqual(['ws-a'])
    host.sendData('b1', 'NOT-YET')

    expect(host.setGrant(guestOf('Alex').id, { projects: ['ws-a', 'ws-b', 'ws-not-shared'] })).toBe(true)
    await until(() => alex.screens.b1 === 'screen of b1')
    expect(ids(alex)).toEqual(['ws-a', 'ws-b'])
    expect(guestOf('Alex').projects).toEqual(['ws-a', 'ws-b'])
    host.sendData('b1', 'now')
    await until(() => alex.screens.b1.endsWith('now'))
    expect(JSON.stringify(alex.data)).not.toContain('NOT-YET')

    // Taken back: nothing more of it, at once.
    host.setGrant(guestOf('Alex').id, { projects: ['ws-b'] })
    host.sendData('a1', 'PRIVATE-A')
    await until(() => ids(alex).join() === 'ws-b')
    await wait(40)
    expect(JSON.stringify(alex.data)).not.toContain('PRIVATE-A')
    expect(host.setGrant('g-unknown', { projects: ['ws-a'] })).toBe(false)
  })

  it('a project taken out of the share: no request about it is taken from that moment (one in flight too), and its panes vanish for everyone', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    const bea = await joined(conn, 'Bea')
    for (const name of ['Alex', 'Bea']) host.setGrant(guestOf(name).id, { rights: ALL })
    await until(() => alex.rights.length === 2 && bea.rights.length === 2)
    await until(() => alex.screens.b1 && bea.screens.b1)
    // Taken out on the host; the guests have not heard yet: what they send
    // meanwhile is refused, and nothing of it goes out.
    t.shared = { 'ws-a': ['a1'] }
    alex.client.write('b1', 'IN-FLIGHT\r')
    alex.client.close('b1')
    alex.client.open({ kind: 'terminal', project: 'ws-b' })
    host.sendData('b1', 'AFTER-REMOVAL')
    host.sendExit('b1', 0)
    await wait(60)
    expect(t.writes).toEqual([])
    expect(t.closed).toEqual([])
    expect(t.opened).toEqual([])
    expect(JSON.stringify([alex.data, bea.data])).not.toContain('AFTER-REMOVAL')
    host.panesChanged()
    await until(() => ids(alex).join() === 'ws-a' && ids(bea).join() === 'ws-a')
    expect(host.guests().map((g) => g.projects)).toEqual([['ws-a'], ['ws-a']])
    // Shared again: given back to no one by itself.
    t.shared = { 'ws-a': ['a1'], 'ws-b': ['b1'] }
    host.panesChanged()
    await until(() => alex.lists.length >= 3 && bea.lists.length >= 3)
    await wait(30)
    expect(ids(alex)).toEqual(['ws-a'])
    expect(host.guests().map((g) => g.projects)).toEqual([['ws-a'], ['ws-a']])
  })

  it('a pane that moves to a project the guest does not see takes no request and sends nothing, at once', async () => {
    const t = fakeTessel({ 'ws-a': ['a1', 'a2'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    host.setGrant(guestOf('Alex').id, { rights: ALL })
    await until(() => alex.rights.length === 2 && alex.screens.a2)
    // a2 moves to ws-b on the host (before the guests are told).
    t.shared = { 'ws-a': ['a1'], 'ws-b': ['b1', 'a2'] }
    alex.client.write('a2', 'MOVED\r')
    alex.client.close('a2')
    host.sendData('a2', 'PRIVATE-AFTER-MOVE')
    await wait(60)
    expect(t.writes).toEqual([])
    expect(t.closed).toEqual([])
    expect(alex.data).toEqual([])
    host.panesChanged()
    await until(() => paneIds(alex).join() === 'a1')
    // b1 moves into ws-a: the guest gets it, its screen first.
    t.shared = { 'ws-a': ['a1', 'b1'], 'ws-b': ['a2'] }
    host.panesChanged()
    await until(() => alex.screens.b1 === 'screen of b1')
    expect(paneIds(alex)).toEqual(['a1', 'b1'])
  })

  it('a pane that moves between two projects a guest sees: its screen is sent again (it is a new pane there)', async () => {
    const t = fakeTessel({ 'ws-a': ['a1', 'a2'], 'ws-b': ['b1'] })
    const conn = await share(t)
    const bea = await joined(conn, 'Bea')
    await until(() => bea.snapshots.length === 3)
    t.shared = { 'ws-a': ['a1'], 'ws-b': ['b1', 'a2'] }
    host.panesChanged()
    await until(() => bea.snapshots.filter((id) => id === 'a2').length === 2)
    expect(bea.projects.find((p) => p.id === 'ws-b').panes.map((x) => x.id)).toEqual(['b1', 'a2'])
  })

  it('a screen being prepared when the guest loses its project is not sent', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    const finish = {}
    t.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => (finish[id] = resolve)), cols: 80, rows: 24 })
      return new Promise(() => {})
    }
    const conn = await share(t)
    const alex = join(conn, 'Alex')
    await until(() => finish.a1 && finish.b1)
    host.setGrant(guestOf('Alex').id, { projects: ['ws-a'] })
    finish.b1('PRIVATE-SCREEN')
    finish.a1('screen a')
    await until(() => alex.screens.a1 === 'screen a')
    await wait(40)
    expect(alex.snapshots).toEqual(['a1'])
  })

  it('the host’s answer: the projects ticked, as shared at that moment; none ticked or no list: nothing seen', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-b', 'ws-gone', '../x', 'ws-b'] }
    t.answers.Bea = { yes: true, projects: [] }
    t.answers.Cy = { yes: false, projects: ['ws-a'] }
    t.answers.Dee = { yes: true }
    t.answers.Eli = { yes: true, projects: 'ws-a' }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    expect(ids(alex)).toEqual(['ws-b'])
    const bea = await joined(conn, 'Bea')
    expect(ids(bea)).toEqual([])
    expect(bea.snapshots).toEqual([])
    // A yes without a list of projects never means every shared one.
    for (const name of ['Dee', 'Eli']) {
      const r = await joined(conn, name)
      expect(ids(r)).toEqual([])
      expect(guestOf(name).projects).toEqual([])
    }
    const cy = join(conn, 'Cy')
    await until(() => cy.closed)
    expect(cy.closed).toBe('denied')
    expect(cy.projects).toBe(null)
  })

  it('what a guest sees comes back with it when it reconnects, and across a restart (taken out of the share meanwhile: not)', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-b'] }
    const hostKey = newSigningKey()
    const conn = await share(t, { hostKey })
    const alex = await joined(conn, 'Alex')
    // Its connection drops; it comes back with its key.
    const back = recorder()
    createShareGuest({ url: `ws://127.0.0.1:${conn.port}/`, secret: conn.secret, name: 'Alex', signingKey: alex.key, back: true, hostKey: alex.hostKey, callbacks: back.callbacks }).connect()
    await until(() => back.states.includes('joined') && back.projects)
    expect(ids(back)).toEqual(['ws-b'])
    const saved = host.accessState()
    expect(saved.people.map((k) => k.grant.projects)).toEqual([['ws-b']])
    host.stop()
    // The next Tessel takes the share back: ws-b is not shared any more.
    const t2 = fakeTessel({ 'ws-a': ['a1'] })
    host = createShareHost({ hostName: 'Ada', callbacks: t2.callbacks, access: saved, hostKey })
    const port = await host.start()
    const again = recorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret: conn.secret, name: 'Alex', signingKey: alex.key, back: true, hostKey: alex.hostKey, callbacks: again.callbacks }).connect()
    await until(() => again.states.includes('joined') && again.projects)
    expect(ids(again)).toEqual([])
    expect(again.snapshots).toEqual([])
    // Shared again later: still not given back by itself.
    t2.shared = { 'ws-a': ['a1'], 'ws-b': ['b1'] }
    host.panesChanged()
    await until(() => again.lists.length === 2)
    expect(ids(again)).toEqual([])
    expect(host.accessState().people.map((k) => k.grant.projects)).toEqual([[]])
  })

  it('lists, for the host, each guest’s projects, offline ones too', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    expect(guestOf('Alex').projects).toEqual(['ws-a'])
    alex.client.disconnect()
    await until(() => host.offlineGuests().length === 1)
    expect(host.offlineGuests()[0].projects).toEqual(['ws-a'])
  })

  it('one project or one right at a time, against what the guest has now: two changes in a row never undo each other', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    const id = guestOf('Alex').id
    // Both made from what the window last heard (Alex sees ws-a): ws-a taken,
    // then ws-b given. The second does not give ws-a back.
    expect(host.change(id, { project: 'ws-a', on: false })).toBe(true)
    expect(host.change(id, { project: 'ws-b', on: true })).toBe(true)
    await until(() => ids(alex).join() === 'ws-b')
    expect(guestOf('Alex').projects).toEqual(['ws-b'])
    host.sendData('a1', 'PRIVATE-A')
    await wait(40)
    expect(JSON.stringify(alex.data)).not.toContain('PRIVATE-A')
    expect(host.change(id, { right: 'type', on: true })).toBe(true)
    expect(host.change(id, { right: 'close', on: true })).toBe(true)
    await until(() => alex.rights.length === 3)
    expect(alex.rights.at(-1)).toEqual({ type: true, open: false, close: true })
    expect(guestOf('Alex').rights).toEqual({ type: true, open: false, close: true })
    // Only real rights, shared projects and guests.
    for (const right of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ['type']]) expect(host.change(id, { right: right, on: true })).toBe(false)
    expect(host.change(id, { project: 'ws-gone', on: true })).toBe(false)
    expect(host.change(id, { project: '../x', on: true })).toBe(false)
    expect(host.change('g-unknown', { project: 'ws-a', on: true })).toBe(false)
    expect(host.change('k-unknown', { right: 'type', on: true })).toBe(false)
    expect(guestOf('Alex').rights).toEqual({ type: true, open: false, close: true })
  })

  it('a guest offline: what it sees and may do still changes, and it comes back with that', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    const conn = await share(t)
    const alex = await joined(conn, 'Alex') // sees both
    alex.client.disconnect()
    await until(() => host.offlineGuests().length === 1)
    const [offline] = host.offlineGuests()
    expect(host.change(offline.id, { project: 'ws-a', on: false })).toBe(true)
    expect(host.change(offline.id, { right: 'type', on: true })).toBe(true)
    expect(host.offlineGuests()[0]).toMatchObject({ id: offline.id, projects: ['ws-b'], rights: { type: true, open: false, close: false } })
    expect(host.accessState().people[0]).toMatchObject({ grant: { projects: ['ws-b'], rights: { type: true, open: false, close: false } } })
    expect(host.setGrant(offline.id, { projects: [] })).toBe(true)
    expect(host.setGrant(offline.id, { rights: { open: true } })).toBe(true)
    expect(host.offlineGuests()[0]).toMatchObject({ projects: [], rights: { type: false, open: true, close: false } })
    expect(host.change(offline.id, { project: 'ws-b', on: true })).toBe(true)
    // Back: with ws-b only, and what it may do now.
    const back = recorder()
    createShareGuest({ url: `ws://127.0.0.1:${conn.port}/`, secret: conn.secret, name: 'Alex', signingKey: alex.key, back: true, hostKey: alex.hostKey, callbacks: back.callbacks }).connect()
    await until(() => back.states.includes('joined') && back.projects)
    expect(ids(back)).toEqual(['ws-b'])
    expect(back.rights[0]).toEqual({ type: false, open: true, close: false })
    await until(() => back.screens.b1)
    expect(back.snapshots).toEqual(['b1'])
    // Its k- id names it while it is in, too: the change goes to its connection.
    expect(host.offlineGuests()).toEqual([])
    expect(host.change(offline.id, { project: 'ws-a', on: true })).toBe(true)
    await until(() => ids(back).join() === 'ws-a,ws-b')
  })

  it('project ids are checked and bounded', () => {
    expect(cleanProjectIds(['ws-1', 'ws-1', '', 'a b', 7, null, '../x', 'x'.repeat(81), 'ws-2'])).toEqual(['ws-1', 'ws-2'])
    expect(cleanProjectIds('ws-1')).toEqual([])
    expect(cleanProjectIds(Array.from({ length: 40 }, (_, i) => `ws-${i}`))).toHaveLength(MAX_PROJECTS)
  })
})

describe('Live Share: an older Tessel on either side is told to update', () => {
  const servers = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop?.() ?? s.close?.()
  })

  it('this host says its protocol (4): a guest of protocol 3 reads it as newer, its Tessel out of date', async () => {
    expect(SHARE_PROTOCOL).toBe(4)
    const host = createShareHost({ secret: newSecret(), hostName: 'Ada', callbacks: fakeTessel({ 'ws-a': ['a1'] }).callbacks })
    servers.push(host)
    const port = await host.start()
    const hello = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()))
        ws.close()
      })
    })
    expect(hello).toMatchObject({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL })
    // What a Tessel of protocol 3 does with it (shareGuest.js of then).
    const v3Reads = (msg) => (Number(msg.v) > 3 ? 'outdated' : msg.v !== 3 ? 'outdated-host' : 'ok')
    expect(v3Reads(hello)).toBe('outdated')
  })

  it('a host of protocol 3 (one project): this guest says the host needs to update', async () => {
    const old = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(old)
    await new Promise((r) => old.once('listening', r))
    old.on('connection', (ws) => ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: 3 })))
    const r = recorder()
    createShareGuest({ url: `ws://127.0.0.1:${old.address().port}/`, secret: newSecret(), name: 'Alex', signingKey: newSigningKey(), callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('outdated-host')
  })
})
