import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { createShareHost, cleanName, stripTerminalReplies, INVITE_TTL_MS } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newNonce, sessionKeys, createChannel } from '../liveShare/shareCrypto'

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
        t.asked.push(g)
        return typeof approve === 'function' ? approve(g) : approve
      },
      onGuests: (list) => t.guestLists.push(list)
    }
  }
  return t
}

function guestRecorder() {
  const r = { states: [], info: [], panes: null, screens: {}, exits: {}, closed: null, rights: [], notices: [], order: [] }
  r.callbacks = {
    onState: (s, info) => {
      r.states.push(s)
      r.info.push(info || null)
    },
    onPanes: (p) => (r.panes = p),
    onSnapshot: (id, data) => {
      r.screens[id] = data
      r.order.push(['snapshot', id, data])
    },
    onData: (id, data) => {
      r.screens[id] = (r.screens[id] || '') + data
      r.order.push(['data', id, data])
    },
    onExit: (id, code) => {
      r.exits[id] = code
      r.order.push(['exit', id, code])
    },
    onRights: (rights) => r.rights.push(rights),
    onNotice: (code) => r.notices.push(code),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

const ALL = { type: true, open: true, close: true }

describe('Live Share session', () => {
  let host
  afterEach(() => host?.stop())

  async function joinOne({ t = fakeTessel(), secret = newSecret(), name = 'Alex', now } = {}) {
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks, ...(now ? { now } : {}) })
    const port = await host.start()
    const r = guestRecorder()
    const guest = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, callbacks: r.callbacks })
    guest.connect()
    return { t, r, guest, port, secret }
  }

  it('lets a guest with the invite in to watch, and takes its typing once the host allows it', async () => {
    const { t, r, guest } = await joinOne({ name: 'Alex\u0007' })
    await until(() => r.screens.p1 === 'screen of p1')
    expect(t.asked.map((g) => g.name)).toEqual(['Alex'])
    expect(r.states).toEqual(['connecting', 'waiting', 'joined'])
    expect(r.panes.map((p) => p.id)).toEqual(['p1'])
    // It starts view only, and knows it.
    expect(r.rights).toEqual([{ type: false, open: false, close: false }])

    host.sendData('p1', '\r\nhello')
    await until(() => r.screens.p1.endsWith('hello'))

    // Not allowed yet: nothing typed, opened or closed.
    guest.write('p1', 'whoami\r')
    guest.open({ kind: 'terminal' })
    guest.close('p1')
    await wait(60)
    expect(t.writes).toEqual([])
    expect(t.opened).toEqual([])
    expect(t.closed).toEqual([])

    const [g] = host.guests()
    expect(host.setRights(g.id, { type: true, open: true, extra: 'x' })).toBe(true)
    await until(() => r.rights.length === 2)
    expect(r.rights[1]).toEqual({ type: true, open: true, close: false })
    expect(host.guests()[0].rights).toEqual({ type: true, open: true, close: false })

    guest.write('p1', 'ls\r')
    guest.write('nope', 'rm -rf /\r') // not a shared pane
    guest.open({ kind: 'agent', agent: 'codex' })
    guest.close('p1') // still not allowed
    await until(() => t.opened.length === 1)
    expect(t.writes).toEqual([['p1', 'ls\r']])
    expect(t.opened).toEqual([{ kind: 'agent', agent: 'codex' }])
    expect(t.closed).toEqual([])

    t.panes = [...t.panes, { id: 'p2', title: 'PowerShell', kind: 'terminal', cols: 80, rows: 24 }]
    host.panesChanged()
    await until(() => r.screens.p2 === 'screen of p2')
    expect(host.guests().map((x) => [x.name, x.state])).toEqual([['Alex', 'joined']])

    host.sendExit('p2', 0)
    await until(() => r.exits.p2 === 0)
    guest.leave()
    await until(() => host.guests().length === 0)
  })

  it('both sides show the same verification code, with the key exchange', async () => {
    const { t, r } = await joinOne()
    await until(() => r.states.includes('joined'))
    const waiting = r.info[r.states.indexOf('waiting')]
    expect(waiting.code).toMatch(/^\d{3} \d{3}$/)
    expect(t.asked[0].code).toBe(waiting.code)
    expect(t.asked[0].forward).toBe(true)
  })

  it('drops what a guest terminal answers by itself, keeps what is typed', async () => {
    expect(stripTerminalReplies('\x1b[12;40R')).toBe('')
    expect(stripTerminalReplies('\x1b[?1;2c\x1b[>0;276;0c\x1b[0n')).toBe('')
    expect(stripTerminalReplies('\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBe('')
    expect(stripTerminalReplies('\x1bP>|xterm.js(5.5.0)\x1b\\\x1b[?2004;1$y\x1b[I\x1b[O')).toBe('')
    expect(stripTerminalReplies('ls\r\x1b[A\x1b[1;5C\x1b[200~pasted\x1b[201~')).toBe('ls\r\x1b[A\x1b[1;5C\x1b[200~pasted\x1b[201~')
    expect(stripTerminalReplies('git st\x1b[3;7Ratus\r')).toBe('git status\r')

    const { t, r, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setRights(host.guests()[0].id, ALL)
    await until(() => r.rights.length === 2)
    guest.write('p1', '\x1b[5;1R')
    guest.write('p1', 'echo hi\r\x1b[?1;2c')
    await until(() => t.writes.length)
    await wait(30)
    expect(t.writes).toEqual([['p1', 'echo hi\r']])
  })

  it('limits how often a guest opens terminals', async () => {
    const { t, r, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setRights(host.guests()[0].id, ALL)
    await until(() => r.rights.length === 2)
    for (let i = 0; i < 5; i++) guest.open({ kind: 'terminal' })
    await until(() => r.notices.length >= 2)
    expect(t.opened).toHaveLength(3)
    expect(r.notices[0]).toBe('limit')
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

  it('tells a guest the host said no, and makes the next one wait', async () => {
    const secret = newSecret()
    const t = fakeTessel({ approve: false })
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bob', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('denied')
    expect(r.panes).toBe(null)
    // Right after a no, a new guest is turned away without asking the host.
    const again = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Bob', callbacks: again.callbacks }).connect()
    await until(() => again.closed)
    expect(again.closed).toBe('busy')
    expect(t.asked).toHaveLength(1)
  })

  it('a new invite code: the old one stops working, guests already in stay', async () => {
    const { t, r, port, secret } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.rotate(newSecret())
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('refused')
    expect(host.guests().map((g) => g.name)).toEqual(['Alex'])
    host.sendData('p1', 'still here')
    await until(() => r.screens.p1.endsWith('still here'))
    expect(t.asked).toHaveLength(1)
  })

  it('an invite code expires after an hour', async () => {
    let clock = 1000
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks, now: () => clock })
    const port = await host.start()
    expect(host.inviteExpires()).toBe(1000 + INVITE_TTL_MS)
    clock += INVITE_TTL_MS + 1
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    expect(t.asked).toEqual([])
  })

  it('refuses a web page (an Origin header)', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: 'https://evil.example' })
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('refused'))
    })
    expect(result).toBe('refused')
  })

  it('lets in a Tessel from before the key exchange, and says so', async () => {
    const secret = newSecret()
    const t = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    // An older guest: no X25519 key in its handshake.
    const msgs = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    let channel = null
    ws.on('message', (data, isBinary) => {
      if (!channel) {
        const hello = JSON.parse(data.toString())
        const guestNonce = newNonce()
        ws.send(JSON.stringify({ t: 'nonce', n: guestNonce.toString('base64') }))
        channel = createChannel(sessionKeys(secret, Buffer.from(hello.n, 'base64'), guestNonce, 'guest'))
        ws.send(channel.seal({ t: 'join', name: 'Old' }))
        return
      }
      msgs.push(isBinary ? channel.open(data) : null)
    })
    await until(() => msgs.some((m) => m && m.t === 'snapshot'))
    expect(msgs[0]).toEqual({ t: 'waiting' })
    expect(t.asked[0]).toMatchObject({ name: 'Old', forward: false })
    ws.close()
  })

  it('sends a screen that takes a moment first, then the output that came meanwhile', async () => {
    const t = fakeTessel()
    let finish
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => (finish = resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish)
    host.sendData('p1', 'after')
    host.sendExit('p1', 2)
    await wait(40)
    expect(r.order).toEqual([])
    finish('screen')
    await until(() => r.order.length === 3)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'screen'],
      ['data', 'p1', 'after'],
      ['exit', 'p1', 2]
    ])
  })

  it('a pane taken out of the shared project sends nothing more, at once', async () => {
    const { t, r } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    // Output waiting to go out when the pane leaves: dropped.
    host.sendData('p1', 'QUEUED')
    t.panes = []
    // Output after it left, before the guests are told (panesChanged).
    host.sendData('p1', 'PRIVATE-AFTER-MOVE')
    host.sendExit('p1', 0)
    await wait(60)
    expect(r.screens.p1).toBe('screen of p1')
    expect(r.exits).toEqual({})
    // Back in the project: its screen again, then its output.
    t.panes = [{ id: 'p1', title: 'Claude Code', kind: 'agent', cols: 100, rows: 30 }]
    host.panesChanged()
    await wait(30)
    host.sendData('p1', 'back')
    await until(() => r.screens.p1 === 'screen of p1back')
  })

  it('a screen still being prepared when its pane leaves the project is not sent', async () => {
    const t = fakeTessel()
    let finish
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => (finish = resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish)
    host.sendData('p1', 'during')
    t.panes = []
    finish('PRIVATE-SCREEN')
    await wait(60)
    expect(r.order).toEqual([])
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
