import { describe, it, expect, afterEach } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createShareHost, cleanName, stripTerminalReplies, INVITE_TTL_MS } from '../liveShare/shareHost'
import { createShareGuest as makeGuest } from '../liveShare/shareGuest'
import { newSecret, newNonce, newKeyPair, commitment, newSigningKey } from '../liveShare/shareCrypto'

// A guest connection: its reconnect key made here unless given.
const createShareGuest = (opts) => makeGuest({ signingKey: newSigningKey(), ...opts })

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
    onRestart: (id) => r.order.push(['restart', id]),
    onClosed: (reason) => (r.closed = reason)
  }
  return r
}

// A connection that goes as far as the host's keys, then stops (what someone
// in the middle trying codes would do).
function stopAfterKeys(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
      else if (msg.t === 'keys') ws.close()
    })
    ws.on('close', () => setTimeout(resolve, 20))
    ws.on('error', () => resolve())
  })
}

const ALL = { type: true, open: true, close: true }

describe('Live Share session', () => {
  let host
  afterEach(() => host?.stop())

  async function joinOne({ t = fakeTessel(), secret = newSecret(), name = 'Alex', now } = {}) {
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks, ...(now ? { now } : {}) })
    const port = await host.start()
    const r = guestRecorder()
    const key = newSigningKey()
    const guest = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: key, callbacks: r.callbacks })
    guest.connect()
    return { t, r, guest, port, secret, key }
  }
  const comeBack = (port, secret, key, extra = {}) => {
    const back = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, callbacks: back.callbacks, ...extra }).connect()
    return back
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

  it('both sides show the same verification code', async () => {
    const { t, r } = await joinOne()
    await until(() => r.states.includes('joined'))
    const waiting = r.info[r.states.indexOf('waiting')]
    expect(waiting.code).toMatch(/^\d{3} \d{3}$/)
    expect(t.asked[0].code).toBe(waiting.code)
  })

  it('a guest that does not reveal what it committed to is dropped', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'commit', c: commitment(newNonce(), newKeyPair().publicRaw).toString('base64') }))
        else if (msg.t === 'keys') ws.send(JSON.stringify({ t: 'reveal', n: newNonce().toString('base64'), kx: newKeyPair().publicRaw.toString('base64') }))
      })
      ws.on('close', () => resolve(true))
    })
    expect(closed).toBe(true)
    expect(t.asked).toEqual([])
  })

  it('connections that stop after the handshake block the code until a new one', async () => {
    const t = fakeTessel()
    let blocked = 0
    t.callbacks.onInviteBlocked = () => blocked++
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    for (let i = 0; i < 8; i++) await stopAfterKeys(port)
    await until(() => blocked === 1)
    expect(host.inviteBlocked()).toBe(true)
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    // A new code lets guests in again.
    const fresh = newSecret()
    host.rotate(fresh)
    expect(host.inviteBlocked()).toBe(false)
    const r2 = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret: fresh, name: 'Alex', callbacks: r2.callbacks }).connect()
    await until(() => r2.states.includes('joined'))
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
    expect(late.closed).toBe('expired')
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

  it('tells a Tessel with the first protocol it is out of date, both ways', async () => {
    const t = fakeTessel()
    host = createShareHost({ secret: newSecret(), hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    // An older guest sends its nonce right away.
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.on('message', () => ws.send(JSON.stringify({ t: 'nonce', n: newNonce().toString('base64') })))
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4003)
    expect(t.asked).toEqual([])
    // An older host puts its nonce in its hello.
    const old = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((r) => old.once('listening', r))
    old.on('connection', (ws) => ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: 1, n: newNonce().toString('base64') })))
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${old.address().port}/`, secret: newSecret(), name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('outdated-host')
    old.close()
  })

  it('a guest let in comes back with its key: in at once, with its rights, no question', async () => {
    const { t, r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setRights(host.guests()[0].id, { type: true, open: false, close: false })
    await until(() => r.rights.length === 2)
    // Its connection drops; it comes back, signing the new connection.
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    expect(t.asked).toHaveLength(1)
    expect(back.rights[0]).toEqual({ type: true, open: false, close: false })
    // Its old connection is replaced.
    await until(() => r.closed)
    expect(r.closed).toBe('replaced')
    expect(host.guests().map((g) => g.state)).toEqual(['joined'])
  })

  it('someone with the guest public key but not its private key can not come back as it', async () => {
    const { t, r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    // The public half is public; a signature must come from the private one.
    const forged = { publicRaw: key.publicRaw, privateKey: newSigningKey().privateKey }
    const intruder = comeBack(port, secret, forged)
    await until(() => intruder.closed)
    expect(intruder.closed).toBe('rejoin-refused')
    expect(r.closed).toBe(null)
    expect(t.asked).toHaveLength(1)
  })

  it('an unknown key is turned away without a question, and a guest who left can not come back', async () => {
    const { t, r, guest, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    const stranger = comeBack(port, secret, newSigningKey())
    await until(() => stranger.closed)
    expect(stranger.closed).toBe('rejoin-refused')
    guest.leave()
    await until(() => host.guests().length === 0)
    const again = comeBack(port, secret, key)
    await until(() => again.closed)
    expect(again.closed).toBe('rejoin-refused')
    expect(t.asked).toHaveLength(1)
  })

  it('the guests let in carry over to the next Tessel (a restart), and an expired code still lets them back', async () => {
    let clock = 1000
    const { r, secret, key } = await joinOne({ now: () => clock })
    await until(() => r.states.includes('joined'))
    host.setRights(host.guests()[0].id, { type: true, open: true, close: true })
    const known = host.knownGuests()
    expect(known).toEqual([{ key: key.publicRaw.toString('base64'), name: 'Alex', rights: { type: true, open: true, close: true } }])
    const expires = host.inviteExpires()
    host.stop('restarting')
    await until(() => r.closed)
    expect(r.closed).toBe('restarting')
    // The next Tessel, an hour and more later.
    clock += 2 * 60 * 60 * 1000
    const t2 = fakeTessel()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t2.callbacks, known, inviteExpires: expires, now: () => clock })
    const port = await host.start()
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    expect(back.rights[0]).toEqual({ type: true, open: true, close: true })
    expect(t2.asked).toEqual([])
    // A new guest with the expired code: turned away.
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
  })

  it('a guest let in before a new code comes back with the secret it had', async () => {
    const { r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.rotate(newSecret())
    expect(host.earlierSecrets()).toHaveLength(1)
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    // A new guest with that old secret: no.
    const late = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Late', callbacks: late.callbacks }).connect()
    await until(() => late.closed)
    expect(late.closed).toBe('expired')
  })

  it('a guest let in comes back even while the code is blocked or new guests must wait', async () => {
    const { r, port, secret, key } = await joinOne()
    await until(() => r.states.includes('joined'))
    for (let i = 0; i < 8; i++) await stopAfterKeys(port)
    await until(() => host.inviteBlocked())
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
  })

  it('every connection that got the host keys and never got in counts, whatever its way out', async () => {
    const t = fakeTessel()
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    // Coming back with a key the host never let in, eight times.
    for (let i = 0; i < 8; i++) {
      const g = comeBack(port, secret, newSigningKey())
      await until(() => g.closed)
      expect(g.closed).toBe('rejoin-refused')
    }
    expect(host.inviteBlocked()).toBe(true)
    expect(t.asked).toEqual([])
  })

  it('what a guest may open or close a minute stays counted across its reconnects', async () => {
    const { t, r, port, secret, key, guest } = await joinOne()
    await until(() => r.states.includes('joined'))
    host.setRights(host.guests()[0].id, { type: false, open: true, close: false })
    await until(() => r.rights.length === 2)
    for (let i = 0; i < 3; i++) guest.open({ kind: 'terminal' })
    await until(() => t.opened.length === 3)
    const back = comeBack(port, secret, key)
    await until(() => back.states.includes('joined'))
    // The same guest, a new connection: still at its limit.
    const conn = guestRecorder()
    const g2 = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Alex', signingKey: key, back: true, callbacks: conn.callbacks })
    g2.connect()
    await until(() => conn.states.includes('joined'))
    g2.open({ kind: 'terminal' })
    await until(() => conn.notices.length)
    expect(conn.notices[0]).toBe('limit')
    expect(t.opened).toHaveLength(3)
  })

  it('a host with a newer protocol than this Tessel: this one is out of date', async () => {
    const newer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((res) => newer.once('listening', res))
    newer.on('connection', (ws) => ws.send(JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: 3 })))
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${newer.address().port}/`, secret: newSecret(), name: 'Alex', callbacks: r.callbacks }).connect()
    await until(() => r.closed)
    expect(r.closed).toBe('outdated')
    newer.close()
  })

  it('a new code turns away guests still waiting under the old one', async () => {
    const t = fakeTessel({ approve: () => new Promise(() => {}) })
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Leaked', callbacks: r.callbacks }).connect()
    await until(() => r.states.includes('waiting'))
    host.rotate(newSecret())
    await until(() => r.closed)
    expect(r.closed).toBe('expired')
    expect(host.guests()).toEqual([])
  })

  it('a guest leaving while waiting makes the next one wait, as after a no', async () => {
    const t = fakeTessel({ approve: () => new Promise(() => {}) })
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Cedric', callbacks: t.callbacks })
    const port = await host.start()
    const r = guestRecorder()
    const g = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Pest', callbacks: r.callbacks })
    g.connect()
    await until(() => r.states.includes('waiting'))
    g.leave()
    await until(() => host.guests().length === 0)
    const next = guestRecorder()
    createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name: 'Pest', callbacks: next.callbacks }).connect()
    await until(() => next.closed)
    expect(next.closed).toBe('busy')
  })

  it('a pane restarted on the host: guests are told, then get its new screen', async () => {
    const { r } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    host.paneRestarted('p1')
    await until(() => r.order.filter((o) => o[0] === 'snapshot').length === 2)
    expect(r.order.slice(-2)).toEqual([
      ['restart', 'p1'],
      ['snapshot', 'p1', 'screen of p1']
    ])
  })

  it('a guest whose window reloaded gets the pane screen again', async () => {
    const { r, guest } = await joinOne()
    await until(() => r.screens.p1 === 'screen of p1')
    guest.resync('p1')
    await until(() => r.order.filter((o) => o[0] === 'snapshot').length === 2)
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

  it('a pane that leaves and comes back while its first screen is prepared gets its new screen, in order', async () => {
    const t = fakeTessel()
    const finish = []
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => finish.push(resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish.length === 1)
    const shown = t.panes
    t.panes = []
    host.panesChanged()
    t.panes = shown
    host.panesChanged()
    await until(() => finish.length === 2)
    host.sendData('p1', 'LIVE')
    // The old screen comes back first: ignored, the new one still holds the output.
    finish[0]('OLD-SCREEN')
    await wait(40)
    expect(r.order).toEqual([])
    finish[1]('NEW-SCREEN')
    await until(() => r.order.length === 2)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'NEW-SCREEN'],
      ['data', 'p1', 'LIVE']
    ])
  })

  it('an old screen coming back after the new one changes nothing', async () => {
    const t = fakeTessel()
    const finish = []
    t.callbacks.snapshot = (id, ready) => {
      ready({ data: new Promise((resolve) => finish.push(resolve)), cols: 100, rows: 30 })
      return new Promise(() => {})
    }
    const { r } = await joinOne({ t })
    await until(() => finish.length === 1)
    const shown = t.panes
    t.panes = []
    host.panesChanged()
    t.panes = shown
    host.panesChanged()
    await until(() => finish.length === 2)
    finish[1]('NEW-SCREEN')
    await until(() => r.order.length === 1)
    finish[0]('OLD-SCREEN')
    host.sendData('p1', 'LIVE')
    await until(() => r.order.length === 2)
    await wait(30)
    expect(r.order).toEqual([
      ['snapshot', 'p1', 'NEW-SCREEN'],
      ['data', 'p1', 'LIVE']
    ])
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
    expect(cleanName('')).toBe('')
    expect(cleanName('x'.repeat(100)).length).toBe(40)
  })
})
