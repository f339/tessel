// @vitest-environment node
// Live Share browser pages (liveShare/sharePages.js): guests see the host's
// listed pages as a screencast through the page's shared debugger, capped
// (1280x800, JPEG 60 down to 40, 200 KB, 5 frames a second, 2 pages), only
// while someone watches; paused on a password field, an error page and the
// host's "hide"; with fallbacks when the page does not paint or its debugger
// is busy; the address masked. A guest's input ("use") is refused for the
// right and middle buttons, the browser's and Tessel's keys, addresses the
// browser does not open, past its rate limits, and while an agent drives
// the page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createSharePages, createPageInput, shownPageUrl, shownPageTitle, jpegSize, refusedGuestKey, PAGE_LIMITS, INPUT_LIMITS } from '../liveShare/sharePages'
import { leaseDebugger, debuggerHolders } from '../pageDebugger'

// A JPEG as far as its headers go (start of image, a frame header), padded.
function jpeg(w, h, bytes = 4000) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))])
}

// A browser page as the main process sees it. focus: where its keyboard is
// ('none', 'field', 'password', 'opaque'), as the debugger answers it.
function fakeGuest(id, { url = 'https://app.example/dash', title = 'Dashboard' } = {}) {
  const dbg = new EventEmitter()
  const state = { url, title, focus: 'none', busy: null, destroyed: false, metrics: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0 }, shot: () => ({ data: jpeg(1000, 700).toString('base64') }) }
  dbg.attached = false
  dbg.sent = []
  dbg.isAttached = () => dbg.attached
  dbg.attach = vi.fn(() => {
    if (state.busy) throw new Error(state.busy)
    dbg.attached = true
  })
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
      if (state.focus === 'opaque') return { result: { type: 'string', value: 'opaque' } }
      if (state.focus === 'none') return { result: { type: 'object', subtype: 'null' } }
      return { result: { objectId: `n${node()}` } }
    },
    'Runtime.callFunctionOn': () => ({ result: { value: state.focus === 'password' } }),
    'DOM.describeNode': () => ({ node: { backendNodeId: node(), nodeName: 'INPUT' } }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: state.metrics, cssLayoutViewport: state.metrics }),
    'Page.captureScreenshot': () => state.shot(),
    // Chromium's flow control: at most two frames unacknowledged.
    'Page.startScreencast': () => {
      state.inFlight = 0
      return {}
    },
    'Page.screencastFrameAck': () => {
      state.inFlight = Math.max(0, state.inFlight - 1)
      state.ackTimes.push(Date.now())
      return {}
    }
  }
  state.inFlight = 0
  state.ackTimes = []
  state.emitted = []
  dbg.sendCommand = vi.fn(async (method, params) => {
    dbg.sent.push([method, params])
    const a = answers[method]
    return typeof a === 'function' ? a(params) : {}
  })
  const guest = {
    id,
    state,
    debugger: dbg,
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    capturePage: vi.fn(async () => null),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => (state.focus === 'password' ? 'secret' : state.focus === 'opaque' ? 'opaque' : 'ok')),
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    // The page paints: a screencast frame, unless two wait for their
    // acknowledgement (then Chromium sends none). -> sent?
    paint(buf = jpeg(1000, 700), meta = {}) {
      if (state.inFlight >= 2) return false
      state.inFlight++
      state.emitted.push(buf.length)
      dbg.emit('message', {}, 'Page.screencastFrame', { data: buf.toString('base64'), metadata: { deviceWidth: 1000, deviceHeight: 700, ...meta }, sessionId: 1 })
      return true
    },
    sentOf: (method) => dbg.sent.filter(([m]) => m === method).map(([, p]) => p)
  }
  return guest
}

function setup(guests = [fakeGuest(11)], { list = null } = {}) {
  const byId = new Map(guests.map((g) => [g.id, g]))
  const pages = createSharePages({ guestById: (id) => byId.get(id) || null, clock: () => Date.now() })
  pages.setPages(list || guests.map((g, i) => ({ id: `pane-${i + 1}`, webContentsId: g.id, hidden: false })))
  return { pages, guests, byId }
}
function watcher() {
  const events = []
  const w = { events, behind: false, onFrame: (e) => events.push(e) }
  w.frames = () => events.filter((e) => e.type === 'frame')
  w.last = () => events[events.length - 1]
  w.opts = { behind: () => w.behind }
  return w
}
const tick = (ms = 1) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Live Share pages: the address and the title', () => {
  it('shows scheme, host and path; no user or password; the query and fragment as ?… and #…', () => {
    expect(shownPageUrl('https://ana:hunter2@app.example:8443/inbox/42?code=abc&state=x#token=1')).toBe('https://app.example:8443/inbox/42?…#…')
    expect(shownPageUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(shownPageUrl('about:blank')).toBe('about:blank')
    for (const bad of ['chrome-error://chromewebdata/', 'file:///C:/Users/x/secret.txt', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', null]) expect(shownPageUrl(bad)).toBe('')
  })

  it('masks path segments that look like secrets, tokens or addresses; keeps slugs', () => {
    expect(shownPageUrl('https://docs.example/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit')).toBe('https://docs.example/document/d/••••/edit')
    expect(shownPageUrl('https://app.example/reset/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('https://app.example/reset/••••')
    expect(shownPageUrl('https://app.example/magic/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('https://app.example/magic/••••')
    expect(shownPageUrl('https://app.example/users/ana%40example.com/settings')).toBe('https://app.example/users/••••/settings')
    expect(shownPageUrl('https://api.example/keys/sk-ant-api03-AbCdEfGhIjKlMnOpQrSt')).toBe('https://api.example/keys/••••')
    expect(shownPageUrl('https://blog.example/2024-05-01-my-long-article-title-here')).toBe('https://blog.example/2024-05-01-my-long-article-title-here')
    expect(shownPageUrl(`https://a.example/${'x/'.repeat(2000)}`).length).toBeLessThanOrEqual(PAGE_LIMITS.url)
  })

  it('cuts and masks the title', () => {
    expect(shownPageTitle('Inbox\u202e (3) — token=abcd1234efgh\n')).toBe('Inbox (3) — token=••••')
    expect(shownPageTitle('x'.repeat(500))).toHaveLength(PAGE_LIMITS.title)
    expect(shownPageTitle(undefined)).toBe('')
  })

  it('reads a JPEG size from its frame header, nothing else', () => {
    expect(jpegSize(jpeg(1280, 800))).toEqual({ w: 1280, h: 800 })
    expect(jpegSize(Buffer.from('not a jpeg at all'))).toBe(null)
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0]))).toBe(null)
    expect(jpegSize(null)).toBe(null)
  })
})

describe('Live Share pages: the screencast', () => {
  it('starts with the caps through the page debugger lease, sends frames with metadata, and stops with the last watcher', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    const unwatch = pages.watch('pane-1', w.onFrame, w.opts)
    expect(g.debugger.attach).toHaveBeenCalledTimes(1)
    expect(debuggerHolders(g)).toEqual(['live-share'])
    expect(g.sentOf('Page.startScreencast')).toEqual([{ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }])
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(1)
    const f = w.frames()[0]
    expect(f).toMatchObject({ seq: 1, w: 1000, h: 700, viewport: { width: 1000, height: 700 }, meta: { title: 'Dashboard', url: 'https://app.example/dash' } })
    expect(Buffer.isBuffer(f.jpeg)).toBe(true)
    await tick(PAGE_LIMITS.frameMs)
    expect(g.sentOf('Page.screencastFrameAck')).toEqual([{ sessionId: 1 }])
    // Two watchers, one leaves: still running; the last leaves: stopped, debugger let go.
    const w2 = watcher()
    const unwatch2 = pages.watch('pane-1', w2.onFrame, w2.opts)
    await tick()
    expect(w2.frames()).toHaveLength(1) // the latest frame at once
    unwatch()
    expect(g.debugger.attached).toBe(true)
    unwatch2()
    // Alone on the debugger: detaching it ends the screencast.
    expect(g.debugger.attached).toBe(false)
    expect(debuggerHolders(g)).toEqual([])
    g.paint()
    await tick(5000)
    expect(w2.frames()).toHaveLength(1)
    expect(g.sentOf('Page.captureScreenshot')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('at most one frame per 200 ms to a watcher, the latest; acknowledged no sooner than 200 ms apart', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    for (let i = 0; i < 5; i++) {
      g.paint(jpeg(1000, 700, 4000 + i))
      await tick(20)
    }
    expect(w.frames()).toHaveLength(1)
    await tick(PAGE_LIMITS.frameMs)
    expect(w.frames()).toHaveLength(2)
    // The latest the page sent; the ones between were skipped.
    expect(w.frames()[1].jpeg.length).toBe(g.state.emitted[g.state.emitted.length - 1])
    expect(g.state.emitted.length).toBeGreaterThan(2)
  })

  it('acknowledges every frame once, 200 ms apart at least: the screencast never stalls', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    // A page that repaints every 50 ms for 10 s.
    let sent = 0
    for (let i = 0; i < 200; i++) {
      if (g.paint(jpeg(1000, 700, 4000 + (i % 50)))) sent++
      await tick(50)
    }
    expect(sent).toBeGreaterThan(40)
    expect(sent).toBeLessThanOrEqual(52)
    expect(w.frames().length).toBeGreaterThan(40)
    const gaps = g.state.ackTimes.slice(1).map((t, i) => t - g.state.ackTimes[i])
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PAGE_LIMITS.frameMs)
    // Frames still come at the end.
    const last = w.frames()[w.frames().length - 1]
    expect(last.seq).toBeGreaterThan(40)
    expect(g.sentOf('Page.captureScreenshot')).toHaveLength(0)
  })

  it('drops a frame over 200 KB and lowers the quality, at most every 2 s, never below 40', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.paint(jpeg(1280, 800, 210 * 1024))
    await tick(10)
    expect(w.frames()).toHaveLength(0)
    expect(g.sentOf('Page.startScreencast').map((p) => p.quality)).toEqual([60, 50])
    // A big frame (over 150 KB) is sent, and lowers it again only 2 s later.
    g.paint(jpeg(1280, 800, 160 * 1024))
    await tick(10)
    expect(w.frames()).toHaveLength(1)
    expect(g.sentOf('Page.startScreencast').map((p) => p.quality)).toEqual([60, 50])
    for (let i = 0; i < 5; i++) {
      await tick(2000)
      g.paint(jpeg(1280, 800, 160 * 1024))
      await tick(10)
    }
    expect(g.sentOf('Page.startScreencast').map((p) => p.quality)).toEqual([60, 50, 40])
    expect(pages.watching()[0].quality).toBe(40)
  })

  it('raises the quality again after a run of small frames with nobody behind', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.paint(jpeg(1280, 800, 210 * 1024))
    await tick(10)
    expect(pages.watching()[0].quality).toBe(50)
    for (let i = 0; i < 12; i++) {
      await tick(1000)
      g.paint(jpeg(1000, 700, 20 * 1024))
    }
    await tick(10)
    expect(pages.watching()[0].quality).toBe(60)
  })

  it('skips frames while the watcher is behind (no queue), holds the acknowledgement, then sends the latest', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(1)
    w.behind = true
    for (let i = 0; i < 4; i++) {
      await tick(PAGE_LIMITS.frameMs)
      g.paint(jpeg(1000, 700, 5000 + i))
    }
    // (Less than 2 s after the last frame: no screenshot comes in between.)
    await tick(300)
    expect(w.frames()).toHaveLength(1)
    const acksBefore = g.sentOf('Page.screencastFrameAck').length
    await tick(600)
    expect(g.sentOf('Page.screencastFrameAck').length).toBe(acksBefore) // held
    // The page waited for acknowledgements (only the restart at a lower
    // quality let one more through).
    expect(g.state.emitted.length).toBeLessThan(5)
    w.behind = false
    await tick(PAGE_LIMITS.frameMs + 10)
    expect(w.frames()).toHaveLength(2)
    expect(w.frames()[1].jpeg.length).toBe(g.state.emitted[g.state.emitted.length - 1])
    expect(g.sentOf('Page.screencastFrameAck').length).toBeGreaterThan(acksBefore)
    // Being behind lowered the quality.
    expect(pages.watching()[0].quality).toBeLessThan(60)
  })

  it('captures at most 2 pages at once on a host; a third waits and starts when one stops', async () => {
    const guests = [fakeGuest(11), fakeGuest(12), fakeGuest(13)]
    const { pages } = setup(guests)
    const ws = [watcher(), watcher(), watcher()]
    const offs = ws.map((w, i) => pages.watch(`pane-${i + 1}`, w.onFrame, w.opts))
    expect(guests.map((g) => g.sentOf('Page.startScreencast').length)).toEqual([1, 1, 0])
    expect(ws[2].last()).toEqual({ type: 'paused', reason: 'limit' })
    offs[0]()
    expect(guests[2].sentOf('Page.startScreencast')).toHaveLength(1)
    guests[2].paint()
    await tick()
    expect(ws[2].frames()).toHaveLength(1)
    offs[1]()
    offs[2]()
  })
})

describe('Live Share pages: paused', () => {
  it('while the keyboard is in a password field (or where Tessel cannot see), then frames again', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.state.focus = 'password'
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(0)
    expect(w.last()).toEqual({ type: 'paused', reason: 'password' })
    // Still in it a second later: still nothing, said once.
    await tick(600)
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(0)
    expect(w.events.filter((e) => e.type === 'paused')).toHaveLength(1)
    g.state.focus = 'field'
    await tick(600)
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(1)
    g.state.focus = 'opaque'
    await tick(600)
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(1)
    expect(w.last()).toEqual({ type: 'paused', reason: 'password' })
  })

  it("on Chromium's error page", async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.state.url = 'chrome-error://chromewebdata/'
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(0)
    expect(w.last()).toEqual({ type: 'paused', reason: 'error-page' })
  })

  it("while the host hides the page: nothing captured, back when shown", async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.paint()
    await tick()
    pages.setHidden('pane-1', true)
    expect(w.last()).toEqual({ type: 'paused', reason: 'hidden' })
    expect(g.debugger.attached).toBe(false)
    g.paint()
    await tick(5000)
    expect(w.frames()).toHaveLength(1)
    expect(g.sentOf('Page.captureScreenshot')).toHaveLength(0)
    // A new watcher of a hidden page hears it at once.
    const w2 = watcher()
    pages.watch('pane-1', w2.onFrame, w2.opts)
    expect(w2.last()).toEqual({ type: 'paused', reason: 'hidden' })
    pages.setHidden('pane-1', false)
    expect(g.sentOf('Page.startScreencast')).toHaveLength(2)
    g.paint()
    await tick()
    expect(w.frames()).toHaveLength(2)
    // The window's list says so too.
    pages.setPages([{ id: 'pane-1', webContentsId: 11, hidden: true }])
    expect(w.last()).toEqual({ type: 'paused', reason: 'hidden' })
  })
})

describe('Live Share pages: fallbacks', () => {
  it('no frame for 2 s (a page out of sight): a capped screenshot every 2 s, until frames come back', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    g.state.metrics = { clientWidth: 2560, clientHeight: 1600, pageX: 0, pageY: 300 }
    g.state.shot = () => ({ data: jpeg(1280, 800).toString('base64') })
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    await tick(PAGE_LIMITS.idleMs + 10)
    expect(g.sentOf('Page.captureScreenshot')).toEqual([{ format: 'jpeg', quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 300, width: 2560, height: 1600, scale: 0.5 } }])
    expect(w.frames()).toHaveLength(1)
    await tick(PAGE_LIMITS.screenshotMs)
    expect(g.sentOf('Page.captureScreenshot')).toHaveLength(2)
    // Frames again: no screenshot while they come.
    for (let i = 0; i < 10; i++) {
      g.paint()
      await tick(500)
    }
    expect(g.sentOf('Page.captureScreenshot')).toHaveLength(2)
  })

  it('a screenshot too big for the caps (a high-density screen) is taken again smaller; an unanswered one is never doubled', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    g.state.metrics = { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }
    // Device pixels: twice the CSS pixels.
    g.state.shot = (p) => ({ data: jpeg(Math.round(1280 * p.clip.scale * 2), Math.round(800 * p.clip.scale * 2)).toString('base64') })
    const answers = g.debugger.sendCommand.getMockImplementation()
    g.debugger.sendCommand.mockImplementation(async (method, params) => (method === 'Page.captureScreenshot' ? (g.debugger.sent.push([method, params]), g.state.shot(params)) : answers(method, params)))
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    await tick(PAGE_LIMITS.idleMs + 10)
    expect(g.sentOf('Page.captureScreenshot').map((p) => p.clip.scale)).toEqual([1, 0.5])
    expect(w.frames()).toHaveLength(1)
    expect(w.frames()[0]).toMatchObject({ w: 1280, h: 800 })
    // A page that never answers: one screenshot waiting, no second one.
    g.debugger.sendCommand.mockImplementation(async (method, params) => (method === 'Page.captureScreenshot' ? (g.debugger.sent.push([method, params]), new Promise(() => {})) : answers(method, params)))
    const before = g.sentOf('Page.captureScreenshot').length
    await tick(20000)
    expect(g.sentOf('Page.captureScreenshot').length).toBe(before + 1)
  })

  it("the debugger busy (devtools open): the page's capture at 1 fps, raced with a timeout, never two at once; back to the screencast once free", async () => {
    const g = fakeGuest(11)
    g.state.busy = 'Another debugger is already attached'
    const img = (w, h) => ({ isEmpty: () => false, getSize: () => ({ width: w, height: h }), resize: vi.fn(({ width, height }) => img(width, height)), toJPEG: vi.fn(() => jpeg(w, h, 3000)) })
    const big = img(2560, 1600)
    g.capturePage.mockImplementation(async () => big)
    const { pages } = setup([g])
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    expect(pages.watching()[0].mode).toBe('capture')
    await tick(10)
    expect(g.capturePage).toHaveBeenCalledTimes(1)
    expect(big.resize).toHaveBeenCalledWith({ width: 1280, height: 800 })
    expect(w.frames()).toHaveLength(1)
    expect(w.frames()[0]).toMatchObject({ w: 1280, h: 800, viewport: null })
    // The keyboard is looked at from an isolated world (no debugger).
    expect(g.executeJavaScriptInIsolatedWorld).toHaveBeenCalled()
    await tick(1000)
    expect(g.capturePage).toHaveBeenCalledTimes(2)
    // A capture that never answers: none started while it waits.
    g.capturePage.mockImplementation(() => new Promise(() => {}))
    await tick(1000)
    const calls = g.capturePage.mock.calls.length
    await tick(PAGE_LIMITS.captureTimeoutMs * 2)
    expect(g.capturePage.mock.calls.length).toBe(calls)
    // The debugger free again: the screencast.
    g.state.busy = null
    await tick(PAGE_LIMITS.retryDebuggerMs)
    expect(pages.watching()[0].mode).toBe('screencast')
    expect(g.sentOf('Page.startScreencast')).toHaveLength(1)
  })

  it('the debugger taken away (devtools opened) while watching: the capture fallback', async () => {
    const g = fakeGuest(11)
    g.capturePage.mockImplementation(async () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), resize: vi.fn(), toJPEG: vi.fn(() => jpeg(800, 600)) }))
    const { pages } = setup([g])
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.state.busy = 'devtools'
    g.debugger.attached = false
    g.debugger.emit('detach', {}, 'replaced_with_devtools')
    expect(pages.watching()[0].mode).toBe('capture')
    await tick(10)
    expect(g.capturePage).toHaveBeenCalled()
    expect(w.frames()).toHaveLength(1)
  })

  it("shares the page's debugger: an agent holding it keeps it attached when the last watcher leaves", async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const agent = leaseDebugger(g, 'agent')
    const w = watcher()
    const off = pages.watch('pane-1', w.onFrame, w.opts)
    expect(g.debugger.attach).toHaveBeenCalledTimes(1)
    off()
    expect(g.sentOf('Page.stopScreencast')).toHaveLength(1)
    expect(g.debugger.attached).toBe(true)
    agent.release()
    expect(g.debugger.attached).toBe(false)
  })
})

describe('Live Share pages: only listed pages', () => {
  it("only the window's listed pages that guestById vouches for; a page gone from the list ends for its watchers", async () => {
    const g = fakeGuest(11)
    const { pages } = setup([g], { list: [{ id: 'pane-1', webContentsId: 11 }, { id: 'pane-x', webContentsId: 999 }, { id: '../bad', webContentsId: 11 }, { id: 'pane-2', webContentsId: 1.5 }] })
    const stranger = watcher()
    pages.watch('pane-x', stranger.onFrame)
    expect(stranger.events).toEqual([{ type: 'ended', reason: 'gone' }])
    expect(pages.meta('pane-x')).toBe(null)
    expect(pages.meta('pane-1')).toEqual({ title: 'Dashboard', url: 'https://app.example/dash' })
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    pages.setPages([])
    expect(w.last()).toEqual({ type: 'ended', reason: 'gone' })
    expect(g.debugger.attached).toBe(false)
    expect(pages.target('pane-1')).toBe(null)
  })

  it('a page whose webContents went away ends for its watchers', async () => {
    const { pages, guests } = setup()
    const [g] = guests
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    g.state.destroyed = true
    g.paint()
    await tick()
    expect(w.last()).toEqual({ type: 'ended', reason: 'gone' })
  })
})

describe('Live Share pages: a guest using a page', () => {
  function inputSetup() {
    const { pages, guests } = setup()
    const input = createPageInput({ target: (id) => pages.target(id), clock: () => Date.now() })
    return { pages, g: guests[0], input }
  }
  const down = (x = 0.5, y = 0.5, extra = {}) => ({ type: 'mouse', action: 'down', x, y, button: 'left', ...extra })

  it('maps a click to the page and refuses the right and middle buttons', async () => {
    const { g, input } = inputSetup()
    const r = await input.handle('ana', 'pane-1', [down(0.5, 0.5), { type: 'mouse', action: 'up', x: 0.5, y: 0.5, button: 'left' }, down(0.1, 0.1, { button: 'right' }), down(0.1, 0.1, { button: 'middle' })])
    expect(r).toEqual({ ok: true, done: 2, refused: ['button'] })
    expect(g.sentOf('Input.dispatchMouseEvent')).toEqual([
      { type: 'mousePressed', x: 500, y: 350, modifiers: 0, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 500, y: 350, modifiers: 0, button: 'left', buttons: 0, clickCount: 1 }
    ])
    expect(g.sentOf('Emulation.setFocusEmulationEnabled')).toEqual([{ enabled: true }])
    // Out of the frame, or not a number: refused.
    expect((await input.handle('ana', 'pane-1', [down(1.5, 0.5), down(NaN, 0)])).refused).toEqual(['invalid'])
  })

  it("refuses the browser's and Tessel's keys, paste, copy, devtools, view source, save, print and open", async () => {
    for (const combo of ['Control+v', 'Shift+Insert', 'Control+w', 'Control+m', 'Control+q', 'Alt+F4', 'F11', 'F12', 'Control+Shift+i', 'Control+u', 'Control+s', 'Control+p', 'Control+o', 'Control+r', 'F5', 'Control+l', 'Control+f', 'Control+c', 'Control+x', 'Control+Shift+w', 'Alt+ArrowLeft', 'Control++'])
      expect(refusedGuestKey(combo)).toBe(true)
    for (const combo of ['Enter', 'Tab', 'a', 'Shift+Tab', 'ArrowDown', 'Backspace', 'Escape', 'Control+a', 'Control+z'])
      expect(refusedGuestKey(combo)).toBe(false)
    const { g, input } = inputSetup()
    const r = await input.handle('ana', 'pane-1', [{ type: 'key', key: 'v', modifiers: { ctrl: true } }, { type: 'key', key: 'F12' }, { type: 'key', key: 'Enter' }])
    expect(r).toEqual({ ok: true, done: 1, refused: ['key'] })
    expect(g.sendInputEvent.mock.calls.map(([e]) => e.type)).toEqual(['keyDown', 'char', 'keyUp'])
  })

  it('never types into a password field (text or a printable key); Enter is fine', async () => {
    const { g, input } = inputSetup()
    g.state.focus = 'field'
    expect(await input.handle('ana', 'pane-1', [{ type: 'text', text: 'hello' }])).toEqual({ ok: true, done: 1, refused: [] })
    expect(g.insertText).toHaveBeenCalledWith('hello')
    g.state.focus = 'password'
    const r = await input.handle('ana', 'pane-1', [{ type: 'text', text: 'hunter2' }, { type: 'key', key: 'x' }, { type: 'key', key: 'Enter' }])
    expect(r).toEqual({ ok: true, done: 1, refused: ['password'] })
    expect(g.insertText).toHaveBeenCalledTimes(1)
    expect((await input.handle('ana', 'pane-1', [{ type: 'text', text: 'x'.repeat(INPUT_LIMITS.text + 1) }])).refused).toEqual(['too_long'])
  })

  it('opens only addresses the browser allows, deferred', async () => {
    const { g, input } = inputSetup()
    const bad = ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://user:pw@example.com/', 'chrome://settings', 'data:text/html,hi', 'devtools://devtools/x']
    const r = await input.handle('ana', 'pane-1', bad.map((url) => ({ type: 'navigate', url })))
    expect(r).toEqual({ ok: true, done: 0, refused: ['url'] })
    await input.handle('ana', 'pane-1', [{ type: 'navigate', url: 'https://example.com/a' }, { type: 'navigate', action: 'back' }])
    expect(g.loadURL).not.toHaveBeenCalled()
    await tick(1)
    expect(g.loadURL).toHaveBeenCalledWith('https://example.com/a')
    expect(g.navigationHistory.goBack).toHaveBeenCalled()
  })

  it('rate limits: moves 30/s dropped quietly; clicks and keys 20/s and 600/min, said once a minute', async () => {
    const { g, input } = inputSetup()
    const moves = Array.from({ length: 40 }, (_, i) => ({ type: 'mouse', action: 'move', x: i / 40, y: 0.5 }))
    expect(await input.handle('ana', 'pane-1', moves)).toEqual({ ok: true, done: 30, refused: [] })
    const clicks = Array.from({ length: 25 }, () => down())
    expect(await input.handle('ana', 'pane-1', clicks)).toEqual({ ok: true, done: 20, refused: [], notice: 'limit' })
    expect(await input.handle('ana', 'pane-1', [down()])).toEqual({ ok: true, done: 0, refused: [] }) // no second notice
    // Another guest has its own budget.
    expect((await input.handle('ben', 'pane-1', [down()])).done).toBe(1)
    // 600 a minute: 20 a second for 30 s, then nothing until the minute passed.
    let done = 0
    for (let s = 0; s < 31; s++) {
      await tick(1000)
      done += (await input.handle('carl', 'pane-1', Array.from({ length: 20 }, () => down()))).done
    }
    expect(done).toBe(600)
    await tick(1000)
    expect((await input.handle('carl', 'pane-1', [down()])).done).toBe(0)
    await tick(30_000)
    expect((await input.handle('carl', 'pane-1', [down()])).done).toBe(1)
    expect(g.sentOf('Input.dispatchMouseEvent').length).toBeGreaterThan(600)
    // Pages opened by a guest's clicks: 3 a minute.
    expect([1, 2, 3, 4].map(() => input.newPage('ana'))).toEqual([true, true, true, false])
    await tick(60_000)
    expect(input.newPage('ana')).toBe(true)
  })

  it('refuses everything while an agent drives the page, a hidden page and an unknown one', async () => {
    const { pages, g, input } = inputSetup()
    const agent = leaseDebugger(g, 'agent')
    expect(await input.handle('ana', 'pane-1', [down()])).toEqual({ ok: false, code: 'agent', done: 0, refused: [] })
    expect(g.sentOf('Input.dispatchMouseEvent')).toEqual([])
    agent.release()
    expect((await input.handle('ana', 'pane-1', [down()])).done).toBe(1)
    pages.setHidden('pane-1', true)
    expect((await input.handle('ana', 'pane-1', [down()])).code).toBe('hidden')
    expect((await input.handle('ana', 'pane-9', [down()])).code).toBe('gone')
    expect((await input.handle('ana', 'pane-1', 'click')).code).toBe('invalid')
    expect((await input.handle('', 'pane-1', [down()])).code).toBe('invalid')
    expect((await input.handle('ana', 'pane-1', Array.from({ length: INPUT_LIMITS.events + 1 }, () => down()))).code).toBe('invalid')
  })

  it('lets the debugger go after a while without input, undoing focus emulation when another holder stays', async () => {
    const { pages, g, input } = inputSetup()
    const w = watcher()
    pages.watch('pane-1', w.onFrame, w.opts)
    await input.handle('ana', 'pane-1', [down()])
    expect(debuggerHolders(g).sort()).toEqual(['live-share', 'live-share-input'])
    await tick(INPUT_LIMITS.idleMs + 10)
    expect(debuggerHolders(g)).toEqual(['live-share'])
    expect(g.sentOf('Emulation.setFocusEmulationEnabled')).toEqual([{ enabled: true }, { enabled: false }])
    expect(g.debugger.attached).toBe(true)
  })
})
