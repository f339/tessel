// Live Share phase 2c: the host's browser pages on guests' screens, wired to
// the channel (sharePages.js makes the frames and takes a guest's input;
// this file says which pages, to whom, and when).
//
// Which pages: the host's window lists the browser panes of the projects it
// shares (liveShare:pages: the pane, its page's webContents id, the host's
// "Hide this page from guests"); a page counts only when its project is
// shared and the pane is a browser pane of that project's layout as guests
// get it (so a page of the right panel, which is in no project, never does,
// whatever the window says), each webContents under one pane at most, and
// sharePages checks each one is a page of Tessel's browser. Guests know a
// page by its pane only.
//
// Who sees one: a guest with "See my browser pages" on that project that
// watches it ('page' topic, one page per guest: shareChannel.js), while its
// page view is on screen (the guest's window watches only then). Frames go
// to that guest alone ('frame' messages); none while its connection is more
// than PAGE_FEED.behindBytes behind (they are skipped, the latest comes once
// it caught up). The last watcher leaving stops the capture. Taking the
// right or the project away ends the watch at once (shareHost.js revalidate
// ends the subscription, and a frame is never sent to a subscription that no
// longer stands).
//
// A guest's input ("Use my browser pages", which needs seeing them): only on
// the page it watches, with both rights checked again before each event
// (input.handle one event at a time), with sharePages' refusals and limits.
// A new window a guest's click opens (browserGuest.js asks popupFrom) opens
// in a new pane, in the browser's guest session (no logins of the host's),
// a few a minute at most; one that comes while the guest's input is being
// dispatched or shortly after is the guest's (unsure: the guest's, the safe
// side). While a guest uses a page, and a while after, the page gets no
// clipboard permission (guestActive: a guest's "Copy" click never writes the
// host's clipboard through it).
//
// Guest side: checkPageFrame / checkPageEvent check what a host sends before
// the window gets it (a JPEG of the capped size, the address masked again).
import { createSharePages, createPageInput, shownPageUrl, shownPageTitle, jpegSize, PAGE_LIMITS, PAUSE_REASONS, END_REASONS } from './sharePages.js'
import { leaseDebugger, debuggerHolders } from '../pageDebugger.js'

export const PAGE_FEED = Object.freeze({
  // A guest this far behind gets no frame (the latest comes later).
  behindBytes: 512 * 1024,
  // A new window while a guest's click or key is being dispatched, or this
  // soon after it was (more than the browser's own 1.5 s from the input's
  // arrival: an unsure one is the guest's), is the guest's.
  popupMs: 2000,
  // A page a guest used this recently (or holds input on): no clipboard
  // permission (browserGuest.js guestInput).
  clipboardMs: 30 * 1000,
  // Pages listed by the window, at most.
  listed: 64,
  // A guest's input messages waiting their turn, at most.
  inputQueue: 16
})
const PAGE_ID = /^[\w-]{1,80}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_B64 = Math.ceil((PAGE_LIMITS.frameBytes * 4) / 3) + 4
const STATES = ['paused', 'ended', 'input']
const CODES = /^[a-z_-]{1,24}$/

// deps: guestById(webContentsId) -> webContents | null (browserGuest.js
// pageById: any of the browser's sessions, the user's own pages included),
// lease / holders (pageDebugger.js), clock, timers, log; onWatchers(): who
// watches which page changed (watched()).
export function createPageFeed({ guestById, lease = leaseDebugger, holders = debuggerHolders, clock = Date.now, timers = globalThis, log = null, onWatchers = () => {} } = {}) {
  const pages = createSharePages({ guestById, lease, clock, timers, log })
  const input = createPageInput({ target: (id) => pages.target(id), lease, holders, clock, timers })
  // page id -> { project, webContentsId } of the pages that count now.
  let listed = new Map()
  // stream (a guest's subscription, shareHost.js) -> { project, page, unwatch }
  const watching = new Map()
  // webContents id -> { busy (clicks or keys being dispatched), end (when
  // the last one was), used (when any input was), stream } of a guest's input.
  const lastInput = new Map()
  // The latest used last (a page in use is never the one let go), and never
  // one whose input is being dispatched.
  function inputOf(webContentsId, stream) {
    let r = lastInput.get(webContentsId)
    if (r) lastInput.delete(webContentsId)
    else r = { busy: 0, end: -Infinity, used: -Infinity, stream }
    lastInput.set(webContentsId, r)
    r.stream = stream
    for (const [id, x] of lastInput) {
      if (lastInput.size <= PAGE_FEED.listed) break
      if (x.busy <= 0 && x !== r) lastInput.delete(id)
    }
    return r
  }

  const changed = () => {
    try {
      onWatchers()
    } catch {
      // only a display
    }
  }

  function deliver(stream, ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'frame') {
      stream.send('frame', { seq: ev.seq, jpeg: ev.jpeg.toString('base64'), w: ev.w, h: ev.h, viewport: ev.viewport || null, meta: ev.meta || { title: '', url: '' } })
    } else if (ev.type === 'paused' || ev.type === 'ended') stream.send('page', { state: ev.type, reason: ev.reason })
  }

  function unwatch(stream) {
    const w = watching.get(stream)
    if (!w) return
    watching.delete(stream)
    w.unwatch()
    // Nobody on that page any more: a guest's hold on its debugger goes too.
    if (![...watching.values()].some((x) => x.page === w.page)) input.release(w.page)
    changed()
  }

  // One guest message's events, in order, each with the rights checked
  // just before it (sharePages' createPageInput, one event at a time).
  async function runInput(stream, w, page, events, mayUse) {
    const refused = new Set()
    let done = 0
    let notice = null
    let code = null
    for (const event of events.slice(0, 50)) {
      if (!stream.live() || !mayUse() || watching.get(stream) !== w) {
        code = 'forbidden'
        break
      }
      // A click or a key: a window it opens meanwhile, or right after, is
      // the guest's.
      const p = listed.get(page)
      const mark = p ? inputOf(p.webContentsId, stream) : null
      const gesture = !!event && ((event.type === 'mouse' && (event.action === 'down' || event.action === 'up')) || event.type === 'key' || event.type === 'text')
      if (mark) {
        mark.used = clock()
        if (gesture) mark.busy++
      }
      let r
      try {
        r = await input.handle(stream.person, page, [event])
      } finally {
        if (mark) {
          mark.used = clock()
          if (gesture) {
            mark.busy--
            mark.end = clock()
          }
        }
      }
      if (!r.ok) {
        code = r.code || 'failed'
        break
      }
      done += r.done
      for (const c of r.refused) refused.add(c)
      if (r.notice) notice = r.notice
    }
    return { ok: !code, ...(code ? { code } : {}), done, refused: [...refused], ...(notice ? { notice } : {}) }
  }

  return {
    // The window's list: [{ project, paneId, webContentsId, hidden }];
    // allowed(project, paneId): the project is shared and the pane is a
    // browser pane of its layout.
    setPages(list, allowed) {
      const next = new Map()
      const wcs = new Set()
      for (const item of Array.isArray(list) ? list.slice(0, PAGE_FEED.listed) : []) {
        if (!item || typeof item.paneId !== 'string' || !PAGE_ID.test(item.paneId) || !Number.isSafeInteger(item.webContentsId)) continue
        if (next.has(item.paneId) || wcs.has(item.webContentsId)) continue
        let ok
        try {
          ok = !!allowed(item.project, item.paneId)
        } catch {
          ok = false
        }
        if (!ok) continue
        next.set(item.paneId, { project: item.project, webContentsId: item.webContentsId, hidden: item.hidden === true })
        wcs.add(item.webContentsId)
      }
      // A page gone or hidden now: a guest's hold on its debugger (its input)
      // goes too.
      for (const id of listed.keys()) if (!next.has(id) || next.get(id).hidden) input.release(id)
      listed = next
      pages.setPages([...next].map(([id, p]) => ({ id, webContentsId: p.webContentsId, hidden: p.hidden })))
      // A page moved to another project: its watchers there stop.
      for (const [stream, w] of [...watching]) {
        const p = listed.get(w.page)
        if (!p || p.project !== w.project) {
          stream.send('page', { state: 'ended', reason: 'gone' })
          unwatch(stream)
        }
      }
    },
    // A guest's 'page' subscription (shareHost.js stream: send, behind, live,
    // guest, person, name) started or ended.
    watchGuest(stream, project, page, on) {
      if (!on) return unwatch(stream)
      unwatch(stream)
      const p = listed.get(page)
      if (!p || p.project !== project) {
        stream.send('page', { state: 'ended', reason: 'gone' })
        return
      }
      const w = { project, page, unwatch: () => {}, chain: Promise.resolve(), waiting: 0 }
      watching.set(stream, w)
      w.unwatch = pages.watch(page, (ev) => watching.get(stream) === w && deliver(stream, ev), {
        behind: () => {
          try {
            return stream.behind() > PAGE_FEED.behindBytes
          } catch {
            return true
          }
        }
      })
      changed()
    },
    // A guest's input on a page it watches; mayUse() -> the guest still has
    // both rights there (asked before each event). A guest's messages are
    // taken in order, one at a time (a few waiting at most).
    // -> { ok, done, refused: [codes], notice?, code? }
    input(stream, project, page, events, mayUse) {
      const w = watching.get(stream)
      if (!w || w.project !== project || w.page !== page) return Promise.resolve({ ok: false, code: 'not-watching', done: 0, refused: [] })
      if (!Array.isArray(events) || !events.length) return Promise.resolve({ ok: true, done: 0, refused: [] })
      // Too many waiting: dropped, said as the limit it is.
      if (w.waiting >= PAGE_FEED.inputQueue) return Promise.resolve({ ok: true, done: 0, refused: [], notice: 'limit' })
      w.waiting++
      const run = w.chain.then(() => runInput(stream, w, page, events, mayUse))
      w.chain = run.catch(() => {}).then(() => w.waiting--)
      return run
    },
    // A new window a page opens (browserGuest.js): the guest's when one of
    // them clicked or typed in it just now. -> null (the host's own) |
    // { allowed } (the guest's: a new pane in the guest session, if under
    // its limit; past it, refused and the guest told).
    popupFrom(webContentsId) {
      const r = lastInput.get(webContentsId)
      if (!r || (r.busy <= 0 && clock() - r.end > PAGE_FEED.popupMs)) return null
      const allowed = input.newPage(r.stream.person)
      if (!allowed) r.stream.send('page', { state: 'input', refused: [], notice: 'limit' })
      return { allowed }
    },
    // A guest uses this page now or did lately (its clipboard permission is
    // refused meanwhile: browserGuest.js guestInput).
    // (null: any page, when the browser cannot say which one asks.)
    guestActive(webContentsId) {
      const active = (r) => !!r && (r.busy > 0 || clock() - r.used <= PAGE_FEED.clipboardMs)
      return webContentsId == null ? [...lastInput.values()].some(active) : active(lastInput.get(webContentsId))
    },
    // Watched pages: [{ id (pane), guests: [{ id, name }] }], for the host's
    // eye on each page.
    watched() {
      const by = new Map()
      for (const [stream, w] of watching) {
        if (!by.has(w.page)) by.set(w.page, [])
        const list = by.get(w.page)
        if (!list.some((g) => g.id === stream.guest)) list.push({ id: stream.guest, name: stream.name || '' })
      }
      return [...by].map(([id, guests]) => ({ id, guests }))
    },
    // The project a page is listed in, or null.
    projectOf: (page) => (listed.get(page) || {}).project || null,
    // Tests and diagnostics.
    capturing: () => pages.watching(),
    stop() {
      for (const stream of [...watching.keys()]) unwatch(stream)
      pages.stop()
      input.stop()
      listed = new Map()
      lastInput.clear()
    }
  }
}

// --- The guest's checks of what a host sends ---------------------------------------
// A frame: { project, page, seq, jpeg (base64), w, h, viewport, meta } with a
// JPEG within the caps; the title and the address made again as guests see
// them (an address is masked again: a host's own Tessel did it already).
export function checkPageFrame(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.page !== 'string' || !PAGE_ID.test(msg.page) || !Number.isSafeInteger(msg.seq) || msg.seq < 1) return null
  if (typeof msg.jpeg !== 'string' || msg.jpeg.length > MAX_B64 || !B64.test(msg.jpeg)) return null
  const bytes = Buffer.from(msg.jpeg, 'base64')
  const size = jpegSize(bytes)
  if (!size || size.w > PAGE_LIMITS.width || size.h > PAGE_LIMITS.height || bytes.length > PAGE_LIMITS.frameBytes) return null
  const v = msg.viewport && typeof msg.viewport === 'object' ? msg.viewport : null
  const viewport = v && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0 && v.width < 100000 && v.height < 100000 ? { width: v.width, height: v.height } : null
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {}
  return { page: msg.page, seq: msg.seq, jpeg: bytes, w: size.w, h: size.h, viewport, meta: { title: shownPageTitle(meta.title), url: shownPageUrl(meta.url) } }
}

// A page's news: paused (why), ended (why), or what became of an input
// (codes refused, a limit notice). -> { page, state, reason?, refused, notice? } | null
export function checkPageEvent(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.page !== 'string' || !PAGE_ID.test(msg.page) || !STATES.includes(msg.state)) return null
  const out = { page: msg.page, state: msg.state }
  if (msg.state === 'paused') out.reason = PAUSE_REASONS.includes(msg.reason) ? msg.reason : 'hidden'
  else if (msg.state === 'ended') out.reason = END_REASONS.includes(msg.reason) ? msg.reason : 'gone'
  else {
    out.refused = (Array.isArray(msg.refused) ? msg.refused : []).filter((c) => typeof c === 'string' && CODES.test(c)).slice(0, 12)
    if (msg.notice === 'limit') out.notice = 'limit'
    if (typeof msg.code === 'string' && CODES.test(msg.code)) out.code = msg.code
  }
  return out
}
