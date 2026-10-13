import { describe, it, expect, afterEach } from 'vitest'
import { createShareHost, cleanName } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret } from '../liveShare/shareCrypto'

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

function fakeTessel({ approve = true } = {}) {
  const t = {
    panes: [{ id: 'p1', title: 'Claude Code', kind: 'agent', cols: 100, rows: 30 }],
    writes: [],
    opened: [],
    closed: [],
    guestLists: [],
    asked: [],
    callbacks: {
      listPanes: () => t.panes,
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 100, rows: 30 }),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec) => t.opened.push(spec),
      closePane: (id) => t.closed.push(id),
      askApproval: async (g) => {
        t.asked.push(g.name)
        return approve
      },
      onGuests: (list) => t.guestLists.push(list)
    }
  }
  return t
}

function guestRecorder() {
  const r = { states: [], panes: null, screens: {}, exits: {}, closed: null }
  r.callbacks = {
    onState: (s) => r.states.push(s),
    onPanes: (p) => (r.panes = p),
    onSnapshot: (id, data) => (r.screens[id] = data),
    onData: (id, data) => (r.screens[id] = (r.screens[id] || '') + data),
    onExit: (id, code) => (r.exits[id] = code),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

describe('Live Share session', () => {
  let host
  afterEach(() => host?.stop())

  it('lets a guest with the invite in, shows the panes live, and takes its typing', async () => {
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    const guest = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex\u0007', callbacks: r.callbacks })
    guest.connect()
    await until(() => r.screens.p1 === 'screen of p1')
    expect(t.asked).toEqual(['Alex'])
    expect(r.states).toEqual(['connecting', 'waiting', 'joined'])
    expect(r.panes.map((p) => p.id)).toEqual(['p1'])

    host.sendData('p1', '\r\nhello')
    await until(() => r.screens.p1.endsWith('hello'))

    guest.write('p1', 'ls\r')
    guest.write('nope', 'rm -rf /\r') // not a shared pane
    guest.open({ kind: 'agent', agent: 'codex' })
    await until(() => t.opened.length === 1)
    expect(t.writes).toEqual([['p1', 'ls\r']])
    expect(t.opened).toEqual([{ kind: 'agent', agent: 'codex' }])

    t.panes = [...t.panes, { id: 'p2', title: 'PowerShell', kind: 'terminal', cols: 80, rows: 24 }]
    host.panesChanged()
    await until(() => r.screens.p2 === 'screen of p2')
    expect(host.guests().map((g) => [g.name, g.state])).toEqual([['Alex', 'joined']])

    host.sendExit('p2', 0)
    await until(() => r.exits.p2 === 0)
    guest.leave()
    await until(() => host.guests().length === 0)
  })

  it('drops a guest without the right secret before it reaches the host', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret: newSecret(), name: 'Mallory', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(t.asked).toEqual([])
    expect(r.panes).toBe(null)
  })

  it('tells a guest the host said no', async () => {
    const secret = newSecret()
    const t = fakeTessel({ approve: false })
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bob', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('denied')
    expect(r.panes).toBe(null)
  })

  it('removes a guest and ends everything when sharing stops', async () => {
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const a = guestRecorder()
    const b = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'A', callbacks: a.callbacks }).connect()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'B', callbacks: b.callbacks }).connect()
    await until(() => a.panes && b.panes)
    const ga = host.guests().find((g) => g.name === 'A')
    host.removeGuest(ga.id)
    await until(() => a.closed)
    expect(a.closed).toBe('removed')
    host.stop()
    await until(() => b.closed)
    expect(b.closed).toBe('stopped')
  })

  it('cleans guest names', () => {
    expect(cleanName('  Al\u0000ex  ')).toBe('Alex')
    expect(cleanName('')).toBe('Guest')
    expect(cleanName('x'.repeat(100)).length).toBe(40)
  })
})
