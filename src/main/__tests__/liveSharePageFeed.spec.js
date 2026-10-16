// @vitest-environment node
// Live Share phase 2c: which of the host's browser pages guests may watch
// and how frames and input flow (liveShare/sharePageFeed.js), and the
// guest's "Open this address in my own browser" (shared/livePageUrl.js):
// only pages of a shared project's layout count (never a page the window
// lists elsewhere, each webContents under one pane); frames go only to a
// guest that watches, never while it is behind; a page hidden by the host
// or with a password field focused shows nothing; a guest's input goes only
// to the page it watches and stops the moment its rights do; a new window
// from a guest's click is its own, a few a minute; the guest checks frames
// and news before its window gets them; the address opened is origin and
// path, http(s), never one of the host's network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createPageFeed, checkPageFrame, checkPageEvent, PAGE_FEED } from '../liveShare/sharePageFeed'
import { PAGE_LIMITS, refusedGuestKey, shownPageUrl } from '../liveShare/sharePages'
import { externalPageUrl, localOnlyHost } from '../../shared/livePageUrl'

function jpeg(w, h, bytes = 4000) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))])
}

// A browser page as the main process sees it (sharePages' fake, smaller).
function fakeGuest(id, { url = 'https://app.example/dash?code=1', title = 'Dashboard' } = {}) {
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
      const ex = String(p.expression)
      if (ex.includes("querySelectorAll('*')")) return { result: {} }
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
    paint(buf = jpeg(1000, 700)) {
      if (state.inFlight >= 2) return false
      state.inFlight++
      dbg.emit('message', {}, 'Page.screencastFrame', { data: buf.toString('base64'), metadata: { deviceWidth: 1000, deviceHeight: 700 }, sessionId: 1 })
      return true
    },
    sentOf: (method) => dbg.sent.filter(([m]) => m === method).map(([, p]) => p)
  }
}

// A guest's 'page' subscription as shareHost.js gives it.
function stream(guest = 'g1', { person = 'p1' } = {}) {
  const s = { guest, person, name: guest, sent: [], buffered: 0, alive: true }
  s.live = () => s.alive
  s.behind = () => s.buffered
  s.send = (type, body) => (s.alive ? (s.sent.push({ type, ...body }), true) : false)
  s.frames = () => s.sent.filter((m) => m.type === 'frame')
  s.last = () => s.sent[s.sent.length - 1]
  return s
}

const tick = (ms = 1) => vi.advanceTimersByTimeAsync(ms)
beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
afterEach(() => vi.useRealTimers())

function setup(guests = [fakeGuest(11), fakeGuest(12)], { shared = ['ws-1'], layout = { 'ws-1': ['pane-a'], 'ws-2': ['pane-b'] } } = {}) {
  const byId = new Map(guests.map((g) => [g.id, g]))
  const watchersChanged = vi.fn()
  const feed = createPageFeed({ guestById: (id) => byId.get(id) || null, clock: () => Date.now(), onWatchers: watchersChanged })
  const allowed = (project, paneId) => shared.includes(project) && (layout[project] || []).includes(paneId)
  return { feed, guests, byId, allowed, watchersChanged }
}

describe('Live Share page feed: which pages count', () => {
  it('only a browser pane of a shared project layout; a side-panel page or another project never does', async () => {
    const { feed, allowed, guests } = setup()
    feed.setPages(
      [
        { project: 'ws-1', paneId: 'pane-a', webContentsId: 11 },
        // Another project, not shared.
        { project: 'ws-2', paneId: 'pane-b', webContentsId: 12 },
        // A page the window lists in a shared project that is not one of its panes (the side panel's).
        { project: 'ws-1', paneId: 'web-side1', webContentsId: 12 },
        // The same webContents under a second pane.
        { project: 'ws-1', paneId: 'pane-a2', webContentsId: 11 },
        { project: 'ws-1', paneId: '../x', webContentsId: 13 }
      ],
      allowed
    )
    expect(feed.projectOf('pane-a')).toBe('ws-1')
    for (const id of ['pane-b', 'web-side1', 'pane-a2', '../x']) expect(feed.projectOf(id)).toBe(null)
    const s = stream()
    feed.watchGuest(s, 'ws-2', 'pane-b', true)
    expect(s.sent).toEqual([{ type: 'page', state: 'ended', reason: 'gone' }])
    // Watching a covered page under the wrong project: refused too.
    const s2 = stream('g2')
    feed.watchGuest(s2, 'ws-2', 'pane-a', true)
    expect(s2.last()).toEqual({ type: 'page', state: 'ended', reason: 'gone' })
    expect(guests[1].debugger.attach).not.toHaveBeenCalled()
  })

  it('a page that leaves its project (or the share) ends for its watchers', async () => {
    const { feed, allowed, guests } = setup()
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    expect(guests[0].debugger.attached).toBe(true)
    feed.setPages([], allowed)
    expect(s.last()).toMatchObject({ type: 'page', state: 'ended', reason: 'gone' })
    expect(guests[0].debugger.attached).toBe(false)
    expect(feed.watched()).toEqual([])
  })
})

describe('Live Share page feed: frames', () => {
  it('only while watched: nothing captured before, frames to that guest, capture stops with the last watcher', async () => {
    const { feed, allowed, guests, watchersChanged } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    expect(g.debugger.attach).not.toHaveBeenCalled()
    expect(g.paint()).toBe(true)
    const s = stream('g1')
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    expect(watchersChanged).toHaveBeenCalled()
    expect(feed.watched()).toEqual([{ id: 'pane-a', guests: [{ id: 'g1', name: 'g1' }] }])
    expect(g.sentOf('Page.startScreencast')).toEqual([{ format: 'jpeg', quality: PAGE_LIMITS.quality, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }])
    g.state.inFlight = 0
    g.paint()
    await tick(5)
    expect(s.frames()).toHaveLength(1)
    const f = s.frames()[0]
    expect(f).toMatchObject({ seq: 1, w: 1000, h: 700, viewport: { width: 1000, height: 700 }, meta: { title: 'Dashboard', url: 'https://app.example/dash?…' } })
    expect(typeof f.jpeg).toBe('string')
    expect(Buffer.from(f.jpeg, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    feed.watchGuest(s, 'ws-1', 'pane-a', false)
    expect(g.debugger.attached).toBe(false)
    expect(feed.watched()).toEqual([])
    expect(feed.capturing()).toEqual([])
  })

  it('skips frames while the guest is behind, then sends the latest', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    s.buffered = PAGE_FEED.behindBytes + 1
    g.paint()
    await tick(5)
    expect(s.frames()).toHaveLength(0)
    s.buffered = 0
    await tick(400)
    expect(s.frames()).toHaveLength(1)
  })

  it('a page hidden by the host shows nothing; a password field pauses it', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11, hidden: true }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    expect(s.last()).toEqual({ type: 'page', state: 'paused', reason: 'hidden' })
    expect(g.debugger.attach).not.toHaveBeenCalled()
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11, hidden: false }], allowed)
    g.state.focus = 'password'
    g.paint()
    await tick(5)
    expect(s.frames()).toHaveLength(0)
    expect(s.last()).toEqual({ type: 'page', state: 'paused', reason: 'password' })
    g.state.focus = 'none'
    await tick(600)
    g.state.inFlight = 0
    g.paint()
    await tick(5)
    expect(s.frames()).toHaveLength(1)
  })

  it('a subscription that no longer stands gets nothing', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    s.alive = false
    g.paint()
    await tick(5)
    expect(s.frames()).toHaveLength(0)
  })
})

describe('Live Share page feed: a guest using a page', () => {
  const click = [
    { type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' },
    { type: 'mouse', action: 'up', x: 0.5, y: 0.5, button: 'left' }
  ]
  it('only on the page it watches, with the refusals of sharePages', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    expect(await feed.input(s, 'ws-1', 'pane-a', click, () => true)).toMatchObject({ ok: false, code: 'not-watching' })
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    const r = await feed.input(s, 'ws-1', 'pane-a', [...click, { type: 'mouse', action: 'down', x: 0.1, y: 0.1, button: 'right' }, { type: 'key', key: 'v', modifiers: { ctrl: true } }], () => true)
    expect(r).toEqual({ ok: true, done: 2, refused: ['button', 'key'] })
    expect(g.sentOf('Input.dispatchMouseEvent')).toHaveLength(2)
  })

  it('stops the moment the rights or the subscription go, before the next event', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    let may = true
    const events = [click[0], click[1], { type: 'text', text: 'abc' }]
    const run = feed.input(s, 'ws-1', 'pane-a', events, () => {
      const now = may
      may = false
      return now
    })
    const r = await run
    expect(r).toMatchObject({ ok: false, code: 'forbidden', done: 1 })
    expect(g.sentOf('Input.dispatchMouseEvent')).toHaveLength(1)
    s.alive = false
    expect(await feed.input(s, 'ws-1', 'pane-a', events, () => true)).toMatchObject({ ok: false, code: 'forbidden', done: 0 })
  })

  it('keeps what it knows of the pages guests used lately: the latest used last, never one mid-dispatch', async () => {
    const guests = Array.from({ length: 70 }, (_, i) => fakeGuest(100 + i))
    const ids = guests.map((_, i) => `pane-${i}`)
    const { feed } = setup(guests, { layout: { 'ws-1': ids } })
    const allowed = () => true
    const click = [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }]
    const use = async (from, to) => {
      feed.setPages(guests.slice(from, to).map((g, i) => ({ project: 'ws-1', paneId: ids[from + i], webContentsId: g.id })), allowed)
      for (let i = from; i < to; i++) {
        const s = stream(`g${i}`)
        feed.watchGuest(s, 'ws-1', ids[i], true)
        await feed.input(s, 'ws-1', ids[i], click, () => true)
      }
    }
    // A click on page 0 that hangs in its dispatch (the page opens a window
    // meanwhile, later).
    let release
    const real = guests[0].debugger.sendCommand.getMockImplementation()
    guests[0].debugger.sendCommand.mockImplementation((method, params) => (method === 'Input.dispatchMouseEvent' ? new Promise((r) => (release = r)) : real(method, params)))
    feed.setPages([{ project: 'ws-1', paneId: ids[0], webContentsId: 100 }], allowed)
    const s0 = stream('g0')
    feed.watchGuest(s0, 'ws-1', ids[0], true)
    const pending = feed.input(s0, 'ws-1', ids[0], click, () => true)
    await tick(1)
    // 63 other pages used since (64 known in all), page 1 first, then page 1
    // again (the latest), then 3 more: 3 have to go.
    await use(1, 64)
    feed.setPages([{ project: 'ws-1', paneId: ids[1], webContentsId: 101 }], allowed)
    const s1 = stream('g1b')
    feed.watchGuest(s1, 'ws-1', ids[1], true)
    await feed.input(s1, 'ws-1', ids[1], click, () => true)
    await use(64, 67)
    // Page 0, mid-dispatch, is still known (its window is the guest's), and
    // page 1, used again, too; page 2, the oldest done, was let go.
    expect(feed.popupFrom(100)).toEqual({ allowed: true })
    expect(feed.guestActive(101)).toBe(true)
    expect(feed.guestActive(102)).toBe(false)
    expect(feed.guestActive(166)).toBe(true)
    release({})
    await pending
  })

  it('takes a guest’s messages in order, one at a time; past a few waiting, a limit', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    const letters = 'abcdefghijklmnopqrst'.split('')
    const results = await Promise.all(letters.map((k) => feed.input(s, 'ws-1', 'pane-a', [{ type: 'key', key: k }], () => true)))
    expect(results.filter((r) => r.notice === 'limit' && r.done === 0)).toHaveLength(letters.length - PAGE_FEED.inputQueue)
    const typed = g.sendInputEvent.mock.calls.filter(([e]) => e.type === 'char').map(([e]) => e.keyCode)
    expect(typed).toEqual(letters.slice(0, PAGE_FEED.inputQueue))
  })

  it('a new window while a guest click is dispatched is the guest’s (the safe side), and for a while after', async () => {
    const { feed, allowed, guests } = setup()
    const [g] = guests
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    // The page opens its window from inside the click's dispatch (before the
    // dispatch answers): the guest's, and the page counts as used meanwhile.
    const seen = []
    const real = g.debugger.sendCommand.getMockImplementation()
    g.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') seen.push({ popup: feed.popupFrom(11), active: feed.guestActive(11) })
      return real(method, params)
    })
    expect(feed.guestActive(11)).toBe(false)
    expect(feed.guestActive(null)).toBe(false)
    await feed.input(s, 'ws-1', 'pane-a', [{ type: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left' }], () => true)
    expect(seen).toEqual([{ popup: { allowed: true }, active: true }])
    // After the dispatch: still the guest's for popupMs, used for clipboardMs.
    await tick(PAGE_FEED.popupMs - 100)
    expect(feed.popupFrom(11)).toEqual({ allowed: true })
    await tick(200)
    expect(feed.popupFrom(11)).toBe(null)
    expect(feed.guestActive(11)).toBe(true)
    expect(feed.guestActive(null)).toBe(true)
    expect(feed.guestActive(12)).toBe(false)
    await tick(PAGE_FEED.clipboardMs)
    expect(feed.guestActive(11)).toBe(false)
  })

  it('a new window right after a guest click is the guest’s, a few a minute; the host’s own is not', async () => {
    const { feed, allowed } = setup()
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 11 }], allowed)
    const s = stream()
    feed.watchGuest(s, 'ws-1', 'pane-a', true)
    expect(feed.popupFrom(11)).toBe(null)
    await feed.input(s, 'ws-1', 'pane-a', click, () => true)
    expect(feed.popupFrom(11)).toEqual({ allowed: true })
    expect(feed.popupFrom(11)).toEqual({ allowed: true })
    expect(feed.popupFrom(11)).toEqual({ allowed: true })
    expect(feed.popupFrom(11)).toEqual({ allowed: false })
    expect(s.last()).toEqual({ type: 'page', state: 'input', refused: [], notice: 'limit' })
    await tick(PAGE_FEED.popupMs + 10)
    expect(feed.popupFrom(11)).toBe(null)
  })
})

describe('Live Share pages: the keys of the host window’s menu', () => {
  it('refuses Alt with anything, Alt alone, F10 and the context menu key (the host window’s menu, File > Exit)', () => {
    for (const combo of ['Alt+f', 'Alt+F', 'Alt+e', 'Alt+Space', 'Alt+1', 'Alt+Shift+x', 'Alt', 'F10', 'Shift+F10', 'ContextMenu', 'Meta'])
      expect(refusedGuestKey(combo)).toBe(true)
    for (const combo of ['a', 'F', 'Enter', 'Tab', 'Shift+Tab', 'ArrowDown', 'Backspace', 'Escape', 'Control+a', 'Control+z', 'F2'])
      expect(refusedGuestKey(combo)).toBe(false)
  })
})

describe('Live Share pages: tokens in the address', () => {
  it('masks random-looking segments of 12 characters or more, split ones too, and what follows a code word', () => {
    expect(shownPageUrl('https://a.example/s/AbCdEfGhIjKlMn')).toBe('https://a.example/s/••••')
    expect(shownPageUrl('https://a.example/s/x7Kq-9pLm-Zr2T')).toBe('https://a.example/s/••••')
    expect(shownPageUrl('https://a.example/d/qwrtzpsdfghjklmnb')).toBe('https://a.example/d/••••')
    expect(shownPageUrl('https://a.example/f/report2024final7')).toBe('https://a.example/f/••••')
    for (const word of ['reset', 'reset-password', 'verify', 'invite', 'invites', 'token', 'magic', 'share', 'auth', 'login', 'callback', 'confirm'])
      expect(shownPageUrl(`https://a.example/${word}/hello`)).toBe(`https://a.example/${word}/••••`)
    expect(shownPageUrl('https://a.example/auth/callback')).toBe('https://a.example/auth/••••')
    // Words, slugs, CamelCase and numbers stay.
    for (const keep of ['https://github.com/facebook/ReactNativeComponentsList', 'https://docs.example/getting-started/installation', 'https://blog.example/2024/05/my-long-article-title-here', 'https://mail.example/inbox/42', 'https://a.example/IMG_20240501_123456.jpg', 'https://a.example/shared'])
      expect(shownPageUrl(keep)).toBe(keep)
  })
})

describe('Live Share page feed: the guest checks the host', () => {
  it('a frame: a JPEG within the caps, the address masked again', () => {
    const ok = checkPageFrame({ page: 'pane-a', seq: 3, jpeg: jpeg(800, 600).toString('base64'), w: 1, h: 1, viewport: { width: 800, height: 600 }, meta: { title: 'T\u0000itle', url: 'https://ana:pw@app.example/x?code=1' } })
    expect(ok).toMatchObject({ page: 'pane-a', seq: 3, w: 800, h: 600, viewport: { width: 800, height: 600 }, meta: { url: 'https://app.example/x?…' } })
    expect(Buffer.isBuffer(ok.jpeg)).toBe(true)
    expect(checkPageFrame({ page: 'pane-a', seq: 1, jpeg: jpeg(2000, 600).toString('base64') })).toBe(null)
    expect(checkPageFrame({ page: 'pane-a', seq: 1, jpeg: Buffer.from('not a jpeg').toString('base64') })).toBe(null)
    expect(checkPageFrame({ page: 'pane-a', seq: 1, jpeg: 'x'.repeat(400000) })).toBe(null)
    expect(checkPageFrame({ page: '../a', seq: 1, jpeg: jpeg(10, 10).toString('base64') })).toBe(null)
    expect(checkPageFrame({ page: 'pane-a', seq: 0, jpeg: jpeg(10, 10).toString('base64') })).toBe(null)
  })
  it('news: known states and codes only', () => {
    expect(checkPageEvent({ page: 'pane-a', state: 'paused', reason: 'password' })).toEqual({ page: 'pane-a', state: 'paused', reason: 'password' })
    expect(checkPageEvent({ page: 'pane-a', state: 'paused', reason: '<x>' })).toEqual({ page: 'pane-a', state: 'paused', reason: 'hidden' })
    expect(checkPageEvent({ page: 'pane-a', state: 'ended', reason: 'stopped' })).toEqual({ page: 'pane-a', state: 'ended', reason: 'stopped' })
    expect(checkPageEvent({ page: 'pane-a', state: 'input', refused: ['key', '<b>', 5], notice: 'limit', code: 'forbidden' })).toEqual({ page: 'pane-a', state: 'input', refused: ['key'], notice: 'limit', code: 'forbidden' })
    expect(checkPageEvent({ page: 'pane-a', state: 'boom' })).toBe(null)
  })
})

describe('Live Share pages: open this address in my own browser', () => {
  it('origin and path, http(s) only, no user or password, never the masked query', () => {
    expect(externalPageUrl('https://app.example:8443/inbox/42?…#…')).toEqual({ ok: true, url: 'https://app.example:8443/inbox/42' })
    expect(externalPageUrl('http://docs.example/guide')).toEqual({ ok: true, url: 'http://docs.example/guide' })
    expect(externalPageUrl('https://ana:pw@app.example/x')).toEqual({ ok: true, url: 'https://app.example/x' })
    // A masked segment: the site's root.
    expect(externalPageUrl('https://docs.example/document/d/••••/edit')).toEqual({ ok: true, url: 'https://docs.example/' })
    expect(externalPageUrl('https://docs.example/a/b…')).toEqual({ ok: true, url: 'https://docs.example/' })
    for (const bad of ['about:blank', 'file:///C:/x', 'javascript:alert(1)', 'chrome://settings', 'ftp://x.example/']) expect(externalPageUrl(bad).ok).toBe(false)
    expect(externalPageUrl('').reason).toBe('invalid')
    expect(externalPageUrl('ftp://x.example/').reason).toBe('scheme')
  })
  it('disabled for the host computer, its private ranges and local names', () => {
    for (const host of ['http://localhost:5173/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.1/', 'http://192.168.1.10/', 'http://169.254.1.1/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:192.168.0.1]/', 'http://nas.local/', 'http://app.localhost/', 'http://intranet/', 'http://box.lan/', 'http://svc.internal/'])
      expect(externalPageUrl(host)).toEqual({ ok: false, reason: 'local' })
    for (const host of ['http://127.0.0.1.nip.io/', 'http://10-0-0-1.sslip.io/', 'http://localtest.me/', 'http://app.localtest.me/', 'http://lvh.me:3000/', 'http://localhost.direct/', 'http://[::7f00:1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://localhost.localdomain/', 'http://x.test/', 'http://2130706433/', 'http://0x7f000001/'])
      expect(externalPageUrl(host)).toEqual({ ok: false, reason: 'local' })
    for (const host of ['https://example.com/', 'http://172.32.0.1/', 'http://8.8.8.8/', 'https://[2606:4700::1111]/']) expect(externalPageUrl(host).ok).toBe(true)
    expect(localOnlyHost('')).toBe(true)
  })
})
