// Live Share phase 2's request and subscription channel (liveShare/
// shareChannel.js, shareHost.js, shareGuest.js) over real WebSockets on
// 127.0.0.1: a guest gets nothing for a feature it did not say, and an older
// host answers at once that it does not do it; each guest's requests stay
// within their budgets (in flight for its person, across a reconnect too;
// light, heavy and write requests a minute); a heavy request asked by
// several guests runs once; taking a project or a right away answers what
// was in flight as revoked (a late result is dropped) and a change not
// started is not made; a large answer waits while the guest's connection is
// behind; malformed requests are ignored; ids used again by a new connection
// never get an answer meant for the old one; subscriptions start and stop
// the host's watch, reach only the guests subscribed that still see the
// project, give a kept topic's latest news to the next subscriber, and hold
// only the latest while a guest is behind.
import { describe, it, expect, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'
import { cleanReq, cleanSub, subKey, CHANNEL_LIMITS, TOPICS } from '../liveShare/shareChannel'
import { SHARE_FEATURES } from '../liveShare/shareChat'

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const OPS = {
  'fs.list': { right: 'view', kind: 'light', bulk: true },
  'fs.stat': { right: 'view', kind: 'light', bulk: false },
  'fs.searchNames': { right: 'view', kind: 'heavy', bulk: false },
  'fs.write': { right: 'edit', kind: 'write', bulk: false },
  'scm.commit': { right: 'git', kind: 'write', bulk: false },
  'tasks.add': { right: 'tasks', kind: 'write', bulk: false }
}
const pane = (id) => ({ id, title: id, kind: 'shell', cols: 80, rows: 24 })
const layoutOf = (name, ids) => ({ project: name, tree: { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell' })) }, activeId: ids[0], maximizedId: null })

// The host's Tessel: its projects, how it answers each request (answer(req,
// ctx), a promise by default resolved at once), and its watches.
function fakeTessel(projects, { serve = true } = {}) {
  const t = {
    shared: projects,
    answers: {},
    calls: [],
    watches: [],
    answer: async (req) => ({ ok: true, data: { op: req.op, args: req.args } }),
    callbacks: {
      projects: () => Object.entries(t.shared).map(([id, ids]) => ({ id, layout: layoutOf(`name of ${id}`, ids), panes: ids.map(pane) })),
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
      write: () => {},
      openPane: () => {},
      closePane: () => {},
      askApproval: async (g) => (g.name in t.answers ? t.answers[g.name] : true)
    }
  }
  if (serve) {
    t.callbacks.opInfo = (op) => OPS[op] || null
    t.callbacks.request = (req, ctx) => {
      t.calls.push({ req, ctx })
      return t.answer(req, ctx)
    }
    t.callbacks.watch = (topic, project, key, on) => t.watches.push([topic, project, key, on])
  }
  return t
}

function recorder() {
  const r = { states: [], projects: null, pushes: [], rights: [], closed: null }
  r.callbacks = {
    onState: (s) => r.states.push(s),
    onProjects: (p) => (r.projects = p),
    onRights: (x) => r.rights.push(x),
    onHostKey: (key) => (r.hostKey = key),
    onPush: (topic, project, key, data) => r.pushes.push({ topic, project, key, data }),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

describe('Live Share: requests and subscriptions', () => {
  let host
  afterEach(() => {
    host?.stop()
    vi.restoreAllMocks()
  })

  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    const port = await host.start()
    return { secret, port }
  }
  async function join(conn, name, { key = newSigningKey(), back = false, hostKey = null, features } = {}) {
    const r = recorder()
    const client = createShareGuest({ url: `ws://127.0.0.1:${conn.port}/`, secret: conn.secret, name, signingKey: key, back, hostKey, callbacks: r.callbacks, ...(features ? { features } : {}) })
    client.connect()
    r.client = client
    r.key = key
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }
  const guestOf = (name) => host.guests().find((g) => g.name === name && g.state === 'joined')

  it('checks what a request and a subscription name before anything else', () => {
    expect(cleanReq({ id: 1, op: 'fs.list', project: 'ws-a', args: { dir: '' } })).toMatchObject({ id: 1, op: 'fs.list', project: 'ws-a', feature: 'files' })
    expect(cleanReq({ id: 0, op: 'fs.list', project: 'ws-a' })).toBe(null)
    expect(cleanReq({ id: 1.5, op: 'fs.list', project: 'ws-a' })).toBe(null)
    expect(cleanReq({ id: 1, op: 'shell.run', project: 'ws-a' })).toBe(null)
    expect(cleanReq({ id: 1, op: 'fs.list', project: '../x' })).toBe(null)
    expect(cleanReq({ id: 1, op: 'fs.list', project: 'ws-a', args: [1] })).toBe(null)
    expect(cleanReq({ id: 1, op: 'fs.list', project: 'ws-a', args: 'x' })).toBe(null)
    expect(cleanReq({ id: 1, op: 'tasks.add', project: 'ws-a' }).feature).toBe('tasks')
    expect(cleanReq({ id: 1, op: 'scm.status', project: 'ws-a' }).feature).toBe('scm')
    expect(cleanSub({ topic: 'fs', project: 'ws-a', on: true })).toMatchObject({ topic: 'fs', project: 'ws-a', key: null, on: true })
    expect(cleanSub({ topic: 'fs', project: 'ws-a', key: 'x', on: true })).toBe(null)
    expect(cleanSub({ topic: 'file', project: 'ws-a', key: 'src/a.js', on: true })).toMatchObject({ key: 'src/a.js' })
    expect(cleanSub({ topic: 'file', project: 'ws-a', key: '../a.js', on: true })).toBe(null)
    expect(cleanSub({ topic: 'file', project: 'ws-a', key: 'C:/a.js', on: true })).toBe(null)
    expect(cleanSub({ topic: 'nope', project: 'ws-a', on: true })).toBe(null)
    expect(cleanSub({ topic: 'tasks', on: true })).toBe(null)
    expect(SHARE_FEATURES).toEqual(expect.arrayContaining(['files', 'scm', 'tasks']))
    for (const spec of Object.values(TOPICS)) expect(SHARE_FEATURES).toContain(spec.feature)
  })

  it('gives a guest nothing for a feature it did not say, and an older host says at once it does not do it', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const old = await join(conn, 'Old', { features: ['chat', 'agents', 'presence'] })
    await expect(old.client.request('fs.stat', 'ws-a', { path: 'a' }, { timeoutMs: 300 })).rejects.toThrow('timeout')
    expect(t.calls).toEqual([])
    expect(old.client.subscribe('fs', 'ws-a')).toBe(true) // the host speaks it; this guest did not say it
    await wait(50)
    expect(t.watches).toEqual([])
    host.stop()

    // An older host: no 'files' at all.
    const t2 = fakeTessel({ 'ws-a': ['a1'] }, { serve: false })
    const conn2 = await share(t2)
    const g = await join(conn2, 'New')
    expect(g.client.speaks('files')).toBe(false)
    await expect(g.client.request('fs.stat', 'ws-a', { path: 'a' })).resolves.toEqual({ ok: false, code: 'bad-op' })
    expect(g.client.subscribe('fs', 'ws-a')).toBe(false)
    // An op of no known area: refused here, nothing sent.
    await expect(g.client.request('shell.run', 'ws-a', {})).resolves.toEqual({ ok: false, code: 'bad-op' })
  })

  it('answers a request with what the host gave, checked against the guest\u2019s projects and rights', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Alex = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    await expect(alex.client.request('fs.stat', 'ws-a', { path: 'x' })).resolves.toEqual({ ok: true, data: { op: 'fs.stat', args: { path: 'x' } } })
    expect(t.calls[0].ctx.rights.edit).toBe(false)
    expect(t.calls[0].req).toEqual({ op: 'fs.stat', project: 'ws-a', args: { path: 'x' } })
    // Not its project, an op the host does not know, a change without its right.
    await expect(alex.client.request('fs.stat', 'ws-b', { path: 'x' })).resolves.toEqual({ ok: false, code: 'no-project' })
    await expect(alex.client.request('fs.nope', 'ws-a', {})).resolves.toEqual({ ok: false, code: 'bad-op' })
    await expect(alex.client.request('fs.write', 'ws-a', { path: 'x', text: 'y' })).resolves.toEqual({ ok: false, code: 'forbidden' })
    await expect(alex.client.request('scm.commit', 'ws-a', { message: 'm' })).resolves.toEqual({ ok: false, code: 'forbidden' })
    expect(t.calls).toHaveLength(1)
    // With the right: it runs.
    host.setGrant(guestOf('Alex').id, { rights: { edit: true } })
    await until(() => alex.rights.length === 2)
    await expect(alex.client.request('fs.write', 'ws-a', { path: 'x', text: 'y' })).resolves.toMatchObject({ ok: true })
    expect(t.calls[1].ctx.rights.edit).toBe(true)
    // The host's own error words go out as a code (and git's detail cut).
    t.answer = async () => ({ ok: false, code: 'Not A Code!', detail: 'x'.repeat(1000) })
    const res = await alex.client.request('fs.stat', 'ws-a', { path: 'x' })
    expect(res.code).toBe('failed')
    expect(res.detail.length).toBe(300)
    t.answer = async () => {
      throw new Error('C:\\Users\\ada\\secret')
    }
    await expect(alex.client.request('fs.stat', 'ws-a', { path: 'x' })).resolves.toEqual({ ok: false, code: 'failed' })
  })

  it('keeps each person within its requests in flight (a new connection too) and never answers an old connection\u2019s id to a new one', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const gates = []
    t.answer = (req) => new Promise((resolve) => gates.push(() => resolve({ ok: true, data: { tag: req.args.tag } })))
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    // Ten at once: the guest sends the host's limit, the rest wait their turn.
    const first = Array.from({ length: 10 }, (_, i) => alex.client.request('fs.stat', 'ws-a', { tag: `old-${i}` }))
    await until(() => t.calls.length === CHANNEL_LIMITS.inFlight)
    await wait(50)
    expect(t.calls).toHaveLength(CHANNEL_LIMITS.inFlight)
    // Its connection drops with all of them still running on the host.
    for (const p of first) p.catch(() => {})
    alex.client.disconnect()
    await until(() => !guestOf('Alex'))
    const back = await join(conn, 'Alex', { key: alex.key, back: true, hostKey: alex.hostKey })
    // Its person still has them in flight: the host turns a new one away.
    await expect(back.client.request('fs.stat', 'ws-a', { tag: 'new-1' })).resolves.toEqual({ ok: false, code: 'busy' })
    // Once the old ones are done (their answers go nowhere), the new
    // connection asks with the same ids again and gets its own answers.
    for (const go of gates.splice(0)) go()
    await wait(50)
    const p = back.client.request('fs.stat', 'ws-a', { tag: 'new-2' })
    await until(() => gates.length === 1)
    gates[0]()
    await expect(p).resolves.toEqual({ ok: true, data: { tag: 'new-2' } })
  })

  it('counts light, heavy and write requests a minute for each person', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    host.setGrant(guestOf('Alex').id, { rights: { edit: true } })
    await until(() => alex.rights.length === 2)
    const heavy = await Promise.all(Array.from({ length: CHANNEL_LIMITS.heavy + 2 }, (_, i) => alex.client.request('fs.searchNames', 'ws-a', { query: `q${i}` })))
    expect(heavy.filter((r) => r.ok)).toHaveLength(CHANNEL_LIMITS.heavy)
    expect(heavy.filter((r) => r.code === 'busy')).toHaveLength(2)
    const writes = await Promise.all(Array.from({ length: CHANNEL_LIMITS.write + 1 }, (_, i) => alex.client.request('fs.write', 'ws-a', { path: `f${i}` })))
    expect(writes.filter((r) => r.ok)).toHaveLength(CHANNEL_LIMITS.write)
    // (In batches: the guest keeps at most 64 waiting its turn.)
    const light = []
    for (let b = 0; b < 3; b++) light.push(...(await Promise.all(Array.from({ length: (CHANNEL_LIMITS.light + 3) / 3 }, (_, i) => alex.client.request('fs.stat', 'ws-a', { path: `p${b}-${i}` })))))
    expect(light.filter((r) => r.ok)).toHaveLength(CHANNEL_LIMITS.light)
    expect(light.filter((r) => r.code === 'busy')).toHaveLength(3)
  })

  it('runs a heavy request asked by several guests once, one at a time per project', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    let release
    let running = 0
    let most = 0
    t.answer = (req) => {
      running++
      most = Math.max(most, running)
      return new Promise((resolve) => {
        const done = () => {
          running--
          resolve({ ok: true, data: { q: req.args.query } })
        }
        if (req.args.query === 'slow') release = done
        else setTimeout(done, 20)
      })
    }
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const bea = await join(conn, 'Bea')
    const a = alex.client.request('fs.searchNames', 'ws-a', { query: 'slow' })
    const b = bea.client.request('fs.searchNames', 'ws-a', { query: 'slow' })
    const c = bea.client.request('fs.searchNames', 'ws-a', { query: 'other' })
    await until(() => release)
    await wait(60)
    expect(t.calls.map((x) => x.req.args.query)).toEqual(['slow'])
    release()
    await expect(a).resolves.toEqual({ ok: true, data: { q: 'slow' } })
    await expect(b).resolves.toEqual({ ok: true, data: { q: 'slow' } })
    await expect(c).resolves.toEqual({ ok: true, data: { q: 'other' } })
    expect(most).toBe(1)
  })

  it('answers what was in flight as revoked once a project or a right is taken away, and a change not started is not made', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const id = guestOf('Alex').id
    host.setGrant(id, { rights: { edit: true } })
    await until(() => alex.rights.length === 2)
    // A read about ws-b still running when ws-b is taken from it.
    let late
    t.answer = () => new Promise((resolve) => (late = () => resolve({ ok: true, data: { secret: 'from ws-b' } })))
    const read = alex.client.request('fs.stat', 'ws-b', { path: 'x' })
    await until(() => late)
    host.change(id, { project: 'ws-b', on: false })
    await expect(read).resolves.toEqual({ ok: false, code: 'revoked' })
    late()
    await wait(50)
    // A save waiting for its turn when the edit right goes: never made.
    let made = false
    let go
    t.answer = async (req, ctx) => {
      await new Promise((r) => (go = r))
      if (!ctx.recheck()) return { ok: false, code: 'revoked' }
      made = true
      return { ok: true, data: {} }
    }
    const save = alex.client.request('fs.write', 'ws-a', { path: 'x' })
    await until(() => go)
    host.change(id, { right: 'edit', on: false })
    await expect(save).resolves.toEqual({ ok: false, code: 'revoked' })
    go()
    await wait(50)
    expect(made).toBe(false)
    // A project taken out of the share: the same.
    host.setGrant(id, { rights: { edit: true } })
    go = null
    const save2 = alex.client.request('fs.write', 'ws-a', { path: 'y' })
    await until(() => go)
    t.shared = { 'ws-b': ['b1'] }
    host.panesChanged()
    await expect(save2).resolves.toEqual({ ok: false, code: 'revoked' })
    go()
    await wait(50)
    expect(made).toBe(false)
  })

  it('a change asked with a right that is then taken away is not made, even with the op’s own right still on', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const id = guestOf('Alex').id
    host.setGrant(id, { rights: { edit: true, type: true } })
    await until(() => alex.rights.length === 2)
    let go
    let made = false
    t.answer = async (req, ctx) => {
      expect(ctx.rights.type).toBe(true)
      await new Promise((r) => (go = r))
      if (!ctx.recheck()) return { ok: false, code: 'revoked' }
      made = true
      return { ok: true, data: {} }
    }
    // (A save of a file that runs things needs type too: shareScope.js.)
    const save = alex.client.request('fs.write', 'ws-a', { path: '.claude/settings.json' })
    await until(() => go)
    host.change(id, { right: 'type', on: false })
    await expect(save).resolves.toEqual({ ok: false, code: 'revoked' })
    go()
    await wait(50)
    expect(made).toBe(false)
    // A read is not called off by a right it did not need.
    host.setGrant(id, { rights: { edit: true, type: true } })
    let release
    t.answer = () => new Promise((resolve) => (release = () => resolve({ ok: true, data: { read: 1 } })))
    const read = alex.client.request('fs.stat', 'ws-a', { path: 'x' })
    await until(() => release)
    host.change(id, { right: 'type', on: false })
    release()
    await expect(read).resolves.toEqual({ ok: true, data: { read: 1 } })
  })

  it('stops waiting for a request the guest gave up on (its change is not made)', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    host.setGrant(guestOf('Alex').id, { rights: { edit: true } })
    await until(() => alex.rights.length === 2)
    let go
    let made = false
    t.answer = async (req, ctx) => {
      await new Promise((r) => (go = r))
      if (!ctx.recheck()) return { ok: false, code: 'revoked' }
      made = true
      return { ok: true, data: {} }
    }
    await expect(alex.client.request('fs.write', 'ws-a', { path: 'x' }, { timeoutMs: 150 })).rejects.toThrow('timeout')
    // (Its cancel on its way to the host first.)
    await wait(80)
    go()
    await wait(50)
    expect(made).toBe(false)
  })

  it('holds a large answer while the guest\u2019s connection is behind, and sends the others', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    let behind = true
    const real = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount').get
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function () {
      return behind ? CHANNEL_LIMITS.bulkBuffered + 1 : real.call(this)
    })
    let bulkDone = false
    const bulk = alex.client.request('fs.list', 'ws-a', { dir: '' }).then((r) => ((bulkDone = true), r))
    await expect(alex.client.request('fs.stat', 'ws-a', { path: 'x' })).resolves.toMatchObject({ ok: true })
    await wait(150)
    expect(bulkDone).toBe(false)
    behind = false
    await expect(bulk).resolves.toMatchObject({ ok: true, data: { op: 'fs.list' } })
  })

  it('ignores what is not a request', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    await expect(alex.client.request('fs.stat', '../ws-a', {}, { timeoutMs: 200 })).rejects.toThrow('timeout')
    await expect(alex.client.request('fs.stat', 'ws-a', 'not args', { timeoutMs: 1000 })).resolves.toMatchObject({ ok: true })
    expect(t.calls.map((c) => c.req.args)).toEqual([{}])
    // Still in: nothing ended the connection.
    expect(guestOf('Alex')).toBeTruthy()
  })

  it('starts and stops the host\u2019s watch, and pushes to the guests subscribed that still see the project', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'], 'ws-b': ['b1'] })
    t.answers.Bea = { yes: true, projects: ['ws-a'] }
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const bea = await join(conn, 'Bea')
    alex.client.subscribe('fs', 'ws-a')
    bea.client.subscribe('fs', 'ws-a')
    bea.client.subscribe('fs', 'ws-b') // not one of hers: nothing
    alex.client.subscribe('file', 'ws-b', 'src/b.js')
    await until(() => t.watches.length === 2)
    await wait(50)
    expect(t.watches).toEqual([
      ['fs', 'ws-a', null, true],
      ['file', 'ws-b', 'src/b.js', true]
    ])
    host.push('fs', 'ws-a', null, { paths: ['a.js'] })
    host.push('file', 'ws-b', 'src/b.js', { exists: true })
    host.push('fs', 'ws-b', null, { paths: ['secret.js'] }) // no one follows it
    await until(() => alex.pushes.length === 2 && bea.pushes.length === 1)
    expect(alex.pushes).toEqual([
      { topic: 'fs', project: 'ws-a', key: null, data: { paths: ['a.js'] } },
      { topic: 'file', project: 'ws-b', key: 'src/b.js', data: { exists: true } }
    ])
    expect(bea.pushes).toEqual([{ topic: 'fs', project: 'ws-a', key: null, data: { paths: ['a.js'] } }])
    // ws-b taken from Alex: its file watch ends with it.
    host.change(guestOf('Alex').id, { project: 'ws-b', on: false })
    await until(() => t.watches.length === 3)
    expect(t.watches[2]).toEqual(['file', 'ws-b', 'src/b.js', false])
    host.push('file', 'ws-b', 'src/b.js', { exists: false })
    // The last one following ws-a's files leaves: its watch stops.
    bea.client.subscribe('fs', 'ws-a', null, false)
    await wait(50)
    expect(t.watches).toHaveLength(3)
    alex.client.leave()
    await until(() => t.watches.length === 4)
    expect(t.watches[3]).toEqual(['fs', 'ws-a', null, false])
    expect(alex.pushes).toHaveLength(2)
    expect(host.watched()).toEqual([])
  })

  it('gives a kept topic\u2019s latest news to the next subscriber, and only the latest to a guest behind', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    const bea = await join(conn, 'Bea')
    alex.client.subscribe('tasks', 'ws-a')
    await until(() => t.watches.length === 1)
    host.push('tasks', 'ws-a', null, { tasks: [{ id: 'task-1' }] })
    await until(() => alex.pushes.length === 1)
    bea.client.subscribe('tasks', 'ws-a')
    await until(() => bea.pushes.length === 1)
    expect(bea.pushes[0].data).toEqual({ tasks: [{ id: 'task-1' }] })
    expect(t.watches).toHaveLength(1)
    // Behind: several boards come, the latest goes once it caught up; file
    // changes are gathered.
    alex.client.subscribe('fs', 'ws-a')
    await until(() => t.watches.length === 2)
    let behind = true
    const real = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount').get
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function () {
      return behind ? CHANNEL_LIMITS.pushBuffered + 1 : real.call(this)
    })
    host.push('tasks', 'ws-a', null, { tasks: [{ id: 'task-2' }] })
    host.push('tasks', 'ws-a', null, { tasks: [{ id: 'task-3' }] })
    host.push('fs', 'ws-a', null, { paths: ['a'] })
    host.push('fs', 'ws-a', null, { paths: ['b'] })
    await wait(100)
    const before = alex.pushes.length
    behind = false
    await until(() => alex.pushes.length === before + 2)
    expect(alex.pushes.slice(before)).toEqual(
      expect.arrayContaining([
        { topic: 'tasks', project: 'ws-a', key: null, data: { tasks: [{ id: 'task-3' }] } },
        { topic: 'fs', project: 'ws-a', key: null, data: { paths: ['a', 'b'] } }
      ])
    )
    expect(subKey('fs', 'ws-a', null)).toBe('fs\nws-a\n')
  })

  it('caps the subscriptions of one guest', async () => {
    const t = fakeTessel({ 'ws-a': ['a1'] })
    const conn = await share(t)
    const alex = await join(conn, 'Alex')
    for (let i = 0; i < TOPICS.file.max + 5; i++) alex.client.subscribe('file', 'ws-a', `f${i}.js`)
    await until(() => t.watches.length === TOPICS.file.max)
    await wait(80)
    expect(t.watches).toHaveLength(TOPICS.file.max)
  })
})
