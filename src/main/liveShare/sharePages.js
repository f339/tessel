// Live Share: the host's browser pages for guests who have "See my browser
// pages" (phase 2c), and their input for those who also have "Use my browser
// pages" (createPageInput, below).
//
// Which pages: only those the host's window lists for the shared projects
// (setPages: the page's id as guests know it, its webContents id, the host's
// "Hide this page from guests"), each checked with guestById (browserGuest.js:
// a page of Tessel's browser, in the browser's own sessions), as agents'
// pages are. Never a page the window did not list, never another webContents.
// Guests only ever see the page's own id, never its webContents id.
//
// How a page is seen: CDP's screencast (Page.startScreencast) through the
// page's shared debugger (pageDebugger.js): the page encodes and scales its
// frames itself, only when it repaints, and sends the next one only once the
// last one is acknowledged, which is held back to keep at most 5 a second and
// while every watcher is behind. When no frame came for 2 s (a page out of
// sight does not paint), a screenshot every 2 s instead (Page.captureScreenshot).
// When the debugger cannot be had (the page's devtools are open), the page's
// own capture (capturePage) once a second, always raced with a timeout
// (Electron 42 can leave it unanswered on a page that is not painted), never
// two at once; the debugger is asked for again every few seconds.
//
// Caps (PAGE_LIMITS): at most 1280x800, JPEG quality 60, lowered to 40 when
// frames come out big or watchers fall behind (raised again once they are
// small); a frame over 200 KB is never sent; at most one frame per 200 ms to
// a watcher, the latest one (frames are skipped, never queued, while it says
// it is behind); at most 2 pages captured at once on a host (a third waits).
// Capture runs only while someone watches: the last watcher leaving stops it
// and lets the debugger go.
//
// Paused, the guest seeing "Hidden by the host" and no frame at all:
// - while the keyboard is in a password field, or somewhere Tessel cannot
//   see (a frame from another site, a closed component: fail closed), looked
//   at again (agentBrowserInput.js focusedField) before a frame goes out when
//   the last look is older than half a second;
// - on Chromium's error page and any address the browser does not show
//   (chrome-error:...);
// - while the host hides the page from guests (setHidden): nothing is
//   captured then.
//
// The address shown (meta): the scheme, host and path only. No user or
// password; a path segment that looks like a secret, a token or an address is
// masked; the query and the fragment (OAuth codes, magic links, session ids)
// show as ?… and #…. The title is cut and masked the same way.

import { leaseDebugger, debuggerHolders } from '../pageDebugger'
import { focusedField, rememberSecrets, parseKeyCombo, pressKey, insertFocusedText, BrowserInputError } from '../agentBrowserInput'
import { reservedKey } from '../agentBrowser'
import { allowedBrowserUrl, BLANK_URL } from '../../shared/browserUrl'
import { maskSecrets } from './shareChat'

export const PAGE_LIMITS = Object.freeze({
  width: 1280,
  height: 800,
  quality: 60,
  minQuality: 40,
  qualityStep: 10,
  frameBytes: 200 * 1024,
  // At most 5 frames a second.
  frameMs: 200,
  // Pages captured at once on a host.
  pages: 2,
  // A page listed by the window, at most.
  listed: 64,
  // No screencast frame for this long: a screenshot, then one this often.
  idleMs: 2000,
  screenshotMs: 2000,
  // The debugger busy: the page's own capture this often, each raced with
  // captureTimeoutMs; the debugger asked for again this often.
  captureMs: 1000,
  captureTimeoutMs: 4000,
  retryDebuggerMs: 5000,
  // The keyboard's place looked at again when older than this.
  focusFreshMs: 500,
  focusTimeoutMs: 1500,
  // The page's password fields scanned again at most this often.
  secretsScanMs: 5000,
  title: 200,
  url: 2000
})
// Why a page shows no frames ('paused'), or why its watching ended ('ended').
export const PAUSE_REASONS = Object.freeze(['hidden', 'password', 'error-page', 'limit'])
export const END_REASONS = Object.freeze(['gone', 'stopped'])

const HOLDER = 'live-share'
const ID = /^[\w.:-]{1,128}$/
const MASK = '••••'
// A frame over the size limit is known from its base64 length before decoding.
const MAX_B64 = Math.ceil((PAGE_LIMITS.frameBytes * 4) / 3) + 4
// The isolated world the capture fallback looks at the keyboard from.
const FOCUS_WORLD = 1997

// --- Address and title ---------------------------------------------------------
/* eslint-disable no-control-regex */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/* eslint-enable no-control-regex */
// A path segment that reads as a token (a share link's id, a reset code): a
// UUID, a long hex run, an address (an email), or a run of 20 letters and
// digits mixing both. A slug ("2024-05-01-my-post") is not one.
const TOKEN_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|@/i
const tokenLike = (text) => TOKEN_SEGMENT.test(text) || (text.match(/[A-Za-z0-9_]{20,}/g) || []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run))

function maskSegment(segment) {
  if (!segment) return segment
  let text
  try {
    text = decodeURIComponent(segment)
  } catch {
    text = segment
  }
  return maskSecrets(text) !== text || tokenLike(text) ? MASK : segment
}

// A page's address as guests see it: scheme, host and path (secrets masked),
// ?… and #… for a query and a fragment; '' for anything but http(s) and the
// blank page.
export function shownPageUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === BLANK_URL) return BLANK_URL
  let url
  try {
    url = new URL(s)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  // url.host never has the user or the password.
  let out = `${url.protocol}//${url.host}${url.pathname.split('/').map(maskSegment).join('/')}`
  if (out.length > PAGE_LIMITS.url) out = `${out.slice(0, PAGE_LIMITS.url - 1)}…`
  return `${out}${url.search ? '?…' : ''}${url.hash ? '#…' : ''}`
}

export function shownPageTitle(raw) {
  const text = maskSecrets(typeof raw === 'string' ? raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim() : '')
  return text.length > PAGE_LIMITS.title ? `${text.slice(0, PAGE_LIMITS.title - 1)}…` : text
}

// A JPEG's size from its frame header -> { w, h } | null (not a JPEG).
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    const length = buf.readUInt16BE(i + 2)
    if (length < 2) return null
    // Start of frame (not DHT, JPG or DAC, which share the range).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = buf.readUInt16BE(i + 5)
      const w = buf.readUInt16BE(i + 7)
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (marker === 0xda) return null // image data before any frame header
    i += 2 + length
  }
  return null
}

function withTimeout(promise, ms, timers) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(null), ms)
    })
  ]).finally(() => timers.clearTimeout(timer))
}

// The keyboard's place, seen from an isolated world (the capture fallback,
// without the debugger): 'secret', 'opaque' or 'ok'.
const FOCUS_SCRIPT = `(() => {
  let el = document.activeElement;
  for (let i = 0; el && i < 64; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      let d = null;
      try { d = el.contentDocument; } catch (e) { d = null; }
      if (!d) return 'opaque';
      if (d.activeElement && d.activeElement !== d.body) { el = d.activeElement; continue; }
    }
    break;
  }
  if (!el) return 'ok';
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input' && String(el.type || '').toLowerCase() === 'password') return 'secret';
  if (/(^|\\s)(current|new)-password(\\s|$)/i.test(String((el.getAttribute && el.getAttribute('autocomplete')) || ''))) return 'secret';
  try {
    const st = getComputedStyle(el);
    const sec = st.webkitTextSecurity || st.getPropertyValue('-webkit-text-security');
    if (sec && sec !== 'none') return 'secret';
  } catch (e) {}
  return 'ok';
})()`

// guestById(webContentsId) -> webContents | null: browserGuest.js guestById
// (only Tessel's browser pages, in its own sessions).
// -> { setPages, watch, setHidden, meta, target, stop }
export function createSharePages({ guestById, lease = leaseDebugger, clock = Date.now, timers = globalThis, log = null } = {}) {
  const pages = new Map() // page id -> state
  const warn = (msg) => log?.warn?.('live-share', msg)

  function guestOf(page) {
    try {
      const guest = guestById(page.webContentsId)
      return guest && !(typeof guest.isDestroyed === 'function' && guest.isDestroyed()) ? guest : null
    } catch {
      return null
    }
  }

  function newPage(id, webContentsId, hidden) {
    return {
      id,
      webContentsId,
      hidden: !!hidden,
      watchers: new Set(),
      running: false,
      waiting: false,
      mode: null, // 'screencast' | 'capture'
      generation: 0,
      lease: null,
      off: null,
      quality: PAGE_LIMITS.quality,
      qualityAt: -Infinity,
      sizes: [],
      lastSkipAt: -Infinity,
      seq: 0,
      latest: null,
      pending: null,
      offering: null,
      viewport: null,
      lastAckAt: -Infinity,
      acks: [],
      lastFrameAt: -Infinity,
      ackTimer: null,
      idleTimer: null,
      pumpTimer: null,
      captureTimer: null,
      retryTimer: null,
      shooting: false,
      shotPending: null,
      capturing: false,
      shotDpr: 1,
      paused: null,
      focus: { at: -Infinity, reason: 'password' },
      focusing: null,
      cache: { world: null, secretIds: new Set(), scannedAt: -Infinity }
    }
  }

  // --- Watchers ----------------------------------------------------------------
  function tell(watcher, event) {
    try {
      watcher.onFrame(event)
    } catch {
      // that guest's socket; the others go on
    }
  }
  function pageMeta(page) {
    const guest = guestOf(page)
    if (!guest) return null
    let url = ''
    let title = ''
    try {
      url = shownPageUrl(guest.getURL())
      title = shownPageTitle(guest.getTitle())
    } catch {
      // closing
    }
    return { title, url }
  }
  // Every watcher hears the page is paused (once per reason); its last frame
  // is dropped (it may show what is now hidden).
  function pause(page, reason) {
    page.latest = null
    page.paused = reason
    for (const w of page.watchers) {
      if (w.state === reason) continue
      w.state = reason
      tell(w, { type: 'paused', reason })
    }
  }
  function behind(watcher) {
    try {
      return !!watcher.behind()
    } catch {
      return true
    }
  }
  // The latest frame to each watcher that has not had it: at most one per
  // frameMs, never while it says it is behind (it gets the latest later).
  function pump(page) {
    const frame = page.latest
    if (!frame || page.paused) return
    let waiting = false
    const now = clock()
    for (const w of page.watchers) {
      if (w.sentSeq >= frame.seq) continue
      if (now - w.lastSentAt < PAGE_LIMITS.frameMs) {
        waiting = true
        continue
      }
      if (behind(w)) {
        waiting = true
        page.lastSkipAt = now
        continue
      }
      w.sentSeq = frame.seq
      w.lastSentAt = now
      w.state = 'live'
      tell(w, { type: 'frame', seq: frame.seq, jpeg: frame.jpeg, w: frame.w, h: frame.h, viewport: frame.viewport, meta: frame.meta })
    }
    if (page.lastSkipAt === now) lower(page)
    if (waiting && !page.pumpTimer) {
      page.pumpTimer = timers.setTimeout(() => {
        page.pumpTimer = null
        pump(page)
      }, PAGE_LIMITS.frameMs)
    }
  }
  const everyoneBehind = (page) => page.watchers.size > 0 && [...page.watchers].every(behind)

  // --- The gate: what may be seen now --------------------------------------------
  async function checkFocus(page, guest) {
    let reason = 'password' // fail closed
    try {
      const held = page.lease
      if (held && held.active) {
        const send = (method, params) => held.send(method, params)
        const look = async () => {
          if (clock() - page.cache.scannedAt > PAGE_LIMITS.secretsScanMs) {
            page.cache.scannedAt = clock()
            await rememberSecrets(send, page.cache)
          }
          return focusedField(send, page.cache)
        }
        const info = await withTimeout(look(), PAGE_LIMITS.focusTimeoutMs, timers)
        reason = info && !info.secret && !info.opaque ? null : 'password'
      } else if (typeof guest.executeJavaScriptInIsolatedWorld === 'function') {
        const seen = await withTimeout(guest.executeJavaScriptInIsolatedWorld(FOCUS_WORLD, [{ code: FOCUS_SCRIPT }]), PAGE_LIMITS.focusTimeoutMs, timers)
        reason = seen === 'ok' ? null : 'password'
      }
    } catch {
      reason = 'password'
    }
    page.focus = { at: clock(), reason }
  }
  async function gate(page) {
    if (page.hidden) return 'hidden'
    const guest = guestOf(page)
    if (!guest) return 'gone'
    let url
    try {
      url = guest.getURL()
    } catch {
      return 'gone'
    }
    if (!allowedBrowserUrl(url)) return 'error-page'
    if (clock() - page.focus.at > PAGE_LIMITS.focusFreshMs) {
      if (!page.focusing) page.focusing = checkFocus(page, guest).finally(() => (page.focusing = null))
      await page.focusing
    }
    return page.focus.reason
  }

  // A frame from any source -> checked, then the latest for the watchers.
  // One at a time: frames that come while one is checked replace each other.
  function receive(page, frame, generation) {
    if (generation !== page.generation || !page.watchers.size) return
    page.pending = { ...frame, generation }
    if (!page.offering) page.offering = drain(page).finally(() => (page.offering = null))
  }
  async function drain(page) {
    try {
      await drainFrames(page)
    } catch (err) {
      warn(`page frame dropped: ${String(err?.message || err).slice(0, 120)}`) // i18n-ignore
    }
  }
  async function drainFrames(page) {
    while (page.pending && page.watchers.size) {
      const frame = page.pending
      page.pending = null
      if (frame.generation !== page.generation) continue
      const reason = await gate(page)
      if (frame.generation !== page.generation) continue
      if (reason === 'gone') return end(page, 'gone')
      if (reason) {
        pause(page, reason)
        continue
      }
      page.paused = null
      page.latest = { jpeg: frame.jpeg, w: frame.w, h: frame.h, viewport: frame.viewport || null, meta: pageMeta(page) || { title: '', url: '' }, seq: ++page.seq }
      pump(page)
    }
  }

  // --- Quality ------------------------------------------------------------------
  function setQuality(page, quality) {
    if (quality === page.quality) return
    page.quality = quality
    page.qualityAt = clock()
    page.sizes = []
    if (page.mode !== 'screencast' || !page.lease || !page.lease.active) return
    // The screencast again with the new quality.
    const generation = page.generation
    if (page.ackTimer) timers.clearTimeout(page.ackTimer)
    page.ackTimer = null
    page.acks = []
    page.lease
      .send('Page.stopScreencast')
      .catch(() => {})
      .then(() => (generation === page.generation && page.lease && page.lease.active ? page.lease.send('Page.startScreencast', screencastParams(page)) : null))
      .catch(() => {})
  }
  // Big frames or watchers behind: one step lower, at most every 2 s.
  function lower(page) {
    if (page.quality > PAGE_LIMITS.minQuality && clock() - page.qualityAt >= 2000) setQuality(page, Math.max(PAGE_LIMITS.minQuality, page.quality - PAGE_LIMITS.qualityStep))
  }
  // Frame sizes: big ones lower the quality, a run of small ones (and nobody
  // behind for 10 s) raises it again.
  function measured(page, bytes) {
    page.sizes.push(bytes)
    if (page.sizes.length > 10) page.sizes.shift()
    if (bytes > PAGE_LIMITS.frameBytes * 0.75) return lower(page)
    const now = clock()
    if (
      page.quality < PAGE_LIMITS.quality &&
      page.sizes.length >= 10 &&
      page.sizes.every((n) => n < PAGE_LIMITS.frameBytes * 0.3) &&
      now - page.lastSkipAt >= 10000 &&
      now - page.qualityAt >= 10000
    )
      setQuality(page, Math.min(PAGE_LIMITS.quality, page.quality + PAGE_LIMITS.qualityStep))
  }

  // --- Sources ------------------------------------------------------------------
  const screencastParams = (page) => ({ format: 'jpeg', quality: page.quality, maxWidth: PAGE_LIMITS.width, maxHeight: PAGE_LIMITS.height, everyNthFrame: 1 })

  function decodeFrame(data) {
    if (typeof data !== 'string' || data.length > MAX_B64) return null
    const jpeg = Buffer.from(data, 'base64')
    const size = jpegSize(jpeg)
    return size ? { jpeg, ...size } : null
  }
  const tooBig = (bytes) => bytes > PAGE_LIMITS.frameBytes

  // Every frame is acknowledged once (Chromium counts the frames in flight
  // and stops at two: a lost acknowledgement would stall the screencast),
  // no sooner than frameMs after the last one (the page then encodes at most
  // 5 frames a second), and not while every watcher is behind.
  function ack(page, sessionId, generation) {
    page.acks.push(sessionId)
    if (!page.ackTimer) nextAck(page, generation)
  }
  function nextAck(page, generation) {
    const attempt = () => {
      page.ackTimer = null
      if (generation !== page.generation || !page.lease || !page.lease.active || !page.acks.length) return
      if (everyoneBehind(page)) {
        page.lastSkipAt = clock()
        lower(page)
        page.ackTimer = timers.setTimeout(attempt, PAGE_LIMITS.frameMs)
        return
      }
      page.lastAckAt = clock()
      page.lease.send('Page.screencastFrameAck', { sessionId: page.acks.shift() }).catch(() => {})
      if (page.acks.length) nextAck(page, generation)
    }
    page.ackTimer = timers.setTimeout(attempt, Math.max(0, page.lastAckAt + PAGE_LIMITS.frameMs - clock()))
  }

  function onScreencastFrame(page, params, generation) {
    if (generation !== page.generation || !Number.isSafeInteger(params.sessionId)) return
    ack(page, params.sessionId, generation)
    page.lastFrameAt = clock()
    armIdle(page, PAGE_LIMITS.idleMs)
    const meta = params.metadata && typeof params.metadata === 'object' ? params.metadata : {}
    if (typeof params.data === 'string' && params.data.length > MAX_B64) return lower(page)
    const frame = decodeFrame(params.data)
    if (!frame) return
    measured(page, frame.jpeg.length)
    if (tooBig(frame.jpeg.length)) return
    const width = Number(meta.deviceWidth)
    const height = Number(meta.deviceHeight)
    page.viewport = width > 0 && height > 0 && width < 100000 && height < 100000 ? { width, height } : page.viewport
    receive(page, { jpeg: frame.jpeg, w: frame.w, h: frame.h, viewport: page.viewport }, generation)
  }

  // No screencast frame for a while: a screenshot (the page out of sight
  // does not paint), then again every screenshotMs until frames come back.
  function armIdle(page, ms) {
    if (page.idleTimer) timers.clearTimeout(page.idleTimer)
    const generation = page.generation
    page.idleTimer = timers.setTimeout(async () => {
      page.idleTimer = null
      if (generation !== page.generation) return
      try {
        await screenshot(page, generation)
      } catch {
        // the page went away meanwhile
      }
      if (generation === page.generation && !page.idleTimer && page.mode === 'screencast') armIdle(page, PAGE_LIMITS.screenshotMs)
    }, ms)
  }
  async function screenshot(page, generation, retry = true) {
    const held = page.lease
    // One still unanswered (a page that does not paint may never answer): no
    // second one in this capture.
    if (page.shooting || page.shotPending === generation || !held || !held.active) return
    page.shooting = true
    try {
      const send = (method, params) => held.send(method, params)
      let view = page.viewport
      let x = 0
      let y = 0
      const metrics = await withTimeout(send('Page.getLayoutMetrics').catch(() => null), PAGE_LIMITS.captureTimeoutMs, timers)
      const v = metrics && (metrics.cssVisualViewport || metrics.visualViewport)
      if (v && v.clientWidth > 0 && v.clientHeight > 0) {
        view = { width: v.clientWidth, height: v.clientHeight }
        x = Number(v.pageX) || 0
        y = Number(v.pageY) || 0
      }
      if (generation !== page.generation) return
      const params = { format: 'jpeg', quality: page.quality, captureBeyondViewport: false }
      if (view) {
        const scale = Math.min(1, PAGE_LIMITS.width / (view.width * page.shotDpr), PAGE_LIMITS.height / (view.height * page.shotDpr))
        params.clip = { x, y, width: view.width, height: view.height, scale }
      }
      const call = send('Page.captureScreenshot', params)
      page.shotPending = generation
      const settled = () => page.shotPending === generation && (page.shotPending = null)
      call.then(settled, settled)
      const r = await withTimeout(call.catch(() => null), PAGE_LIMITS.captureTimeoutMs, timers)
      if (generation !== page.generation || !r || typeof r.data !== 'string') return
      if (r.data.length > MAX_B64) return lower(page)
      const frame = decodeFrame(r.data)
      if (!frame) return
      // Device pixels per CSS pixel, learnt from the picture: one too big is
      // taken again smaller, once.
      if (view && params.clip) {
        const dpr = frame.w / (view.width * params.clip.scale)
        if (Number.isFinite(dpr) && dpr > 0.5 && dpr < 8) page.shotDpr = dpr
      }
      if (frame.w > PAGE_LIMITS.width || frame.h > PAGE_LIMITS.height) {
        page.shooting = false
        if (retry) await screenshot(page, generation, false)
        return
      }
      measured(page, frame.jpeg.length)
      if (tooBig(frame.jpeg.length)) return
      if (view) page.viewport = view
      receive(page, { jpeg: frame.jpeg, w: frame.w, h: frame.h, viewport: page.viewport }, generation)
    } finally {
      page.shooting = false
    }
  }

  function startScreencast(page) {
    const generation = page.generation
    page.mode = 'screencast'
    page.off = page.lease.on((_event, method, params, sessionId) => {
      if (sessionId || method !== 'Page.screencastFrame' || !params || typeof params !== 'object') return
      onScreencastFrame(page, params, generation)
    })
    page.lease.send('Page.startScreencast', screencastParams(page)).catch(() => {
      // Refused: the screenshots below still show the page.
    })
    armIdle(page, PAGE_LIMITS.idleMs)
  }

  // The debugger busy (devtools open): the page's own capture, once a second.
  function startCapture(page) {
    const generation = page.generation
    page.mode = 'capture'
    const tick = async () => {
      page.captureTimer = null
      if (generation !== page.generation) return
      await captureOnce(page, generation)
      if (generation === page.generation) page.captureTimer = timers.setTimeout(tick, PAGE_LIMITS.captureMs)
    }
    page.captureTimer = timers.setTimeout(tick, 0)
    const retry = () => {
      page.retryTimer = null
      if (generation !== page.generation) return
      const guest = guestOf(page)
      if (!guest) return end(page, 'gone')
      const taken = takeLease(page, guest)
      if (!taken) {
        page.retryTimer = timers.setTimeout(retry, PAGE_LIMITS.retryDebuggerMs)
        return
      }
      // The debugger is free again: back to the screencast.
      clearSource(page)
      page.generation++
      page.lease = taken
      startScreencast(page)
    }
    page.retryTimer = timers.setTimeout(retry, PAGE_LIMITS.retryDebuggerMs)
  }
  async function captureOnce(page, generation) {
    // A capture still unanswered (even past its timeout): no second one.
    if (page.capturing) return
    const guest = guestOf(page)
    if (!guest) return end(page, 'gone')
    let img
    page.capturing = true
    try {
      const pending = Promise.resolve().then(() => guest.capturePage())
      pending.then(
        () => (page.capturing = false),
        () => (page.capturing = false)
      )
      img = await withTimeout(pending.catch(() => null), PAGE_LIMITS.captureTimeoutMs, timers)
    } catch {
      page.capturing = false
      img = null
    }
    if (generation !== page.generation || !img || typeof img.isEmpty !== 'function' || img.isEmpty()) return
    try {
      const size = img.getSize()
      const scale = Math.min(1, PAGE_LIMITS.width / size.width, PAGE_LIMITS.height / size.height)
      const small = scale < 1 ? img.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) }) : img
      const jpeg = small.toJPEG(page.quality)
      const dims = jpegSize(jpeg)
      if (!dims) return
      measured(page, jpeg.length)
      if (tooBig(jpeg.length)) return
      receive(page, { jpeg, w: dims.w, h: dims.h, viewport: null }, generation)
    } catch (err) {
      warn(`page capture failed: ${String(err?.message || err).slice(0, 120)}`) // i18n-ignore
    }
  }

  function takeLease(page, guest) {
    try {
      return lease(guest, HOLDER, { onDetach: () => leaseLost(page) })
    } catch {
      return null
    }
  }
  // The debugger went away on its own (devtools opened): the capture fallback.
  function leaseLost(page) {
    if (!page.running) return
    clearSource(page)
    page.generation++
    startCapture(page)
  }

  // The page's capture stops: its timers, its listener, its lease (the
  // debugger detached only if nobody else holds it).
  function clearSource(page) {
    for (const name of ['ackTimer', 'idleTimer', 'pumpTimer', 'captureTimer', 'retryTimer']) {
      if (page[name]) timers.clearTimeout(page[name])
      page[name] = null
    }
    if (page.off) page.off()
    page.off = null
    page.acks = []
    const held = page.lease
    page.lease = null
    if (held && held.active) {
      // Alone, the detach ends the screencast; else it is stopped here.
      if (page.mode === 'screencast' && !held.alone) held.send('Page.stopScreencast').catch(() => {})
      held.release()
    }
    page.mode = null
  }

  const runningCount = () => [...pages.values()].filter((p) => p.running).length

  function start(page) {
    if (page.running || page.hidden || !page.watchers.size) return
    if (runningCount() >= PAGE_LIMITS.pages) {
      page.waiting = true
      return pause(page, 'limit')
    }
    const guest = guestOf(page)
    if (!guest) return end(page, 'gone')
    page.waiting = false
    page.running = true
    page.paused = null
    page.generation++
    page.focus = { at: -Infinity, reason: 'password' }
    page.lease = takeLease(page, guest)
    if (page.lease) startScreencast(page)
    else startCapture(page)
  }

  function stop(page) {
    if (!page.running && !page.waiting) return
    const wasRunning = page.running
    page.running = false
    page.waiting = false
    page.generation++
    clearSource(page)
    page.latest = null
    page.pending = null
    page.viewport = null
    page.paused = null
    if (wasRunning) startWaiting()
  }
  // A page waiting for a free place, oldest first.
  function startWaiting() {
    for (const page of pages.values()) {
      if (runningCount() >= PAGE_LIMITS.pages) return
      if (page.waiting && page.watchers.size && !page.hidden) {
        page.waiting = false
        start(page)
      }
    }
  }

  function end(page, reason) {
    stop(page)
    pages.delete(page.id)
    const watchers = [...page.watchers]
    page.watchers.clear()
    for (const w of watchers) tell(w, { type: 'ended', reason })
    startWaiting()
  }

  // The host's "Hide this page from guests": nothing captured meanwhile.
  function setHidden(pageId, hidden) {
    const page = pages.get(pageId)
    if (!page || page.hidden === !!hidden) return
    page.hidden = !!hidden
    if (page.hidden) {
      stop(page)
      pause(page, 'hidden')
    } else start(page)
  }

  return {
    // The host window's list of shared pages: [{ id, webContentsId, hidden }].
    // A page gone from it (or now another webContents) ends for its watchers.
    setPages(list) {
      const next = new Map()
      for (const item of Array.isArray(list) ? list.slice(0, PAGE_LIMITS.listed) : []) {
        if (!item || typeof item.id !== 'string' || !ID.test(item.id) || !Number.isSafeInteger(item.webContentsId) || next.has(item.id)) continue
        next.set(item.id, item)
      }
      for (const page of [...pages.values()]) {
        const item = next.get(page.id)
        if (!item || item.webContentsId !== page.webContentsId) end(page, 'gone')
      }
      for (const item of next.values()) {
        let page = pages.get(item.id)
        if (!page) {
          page = newPage(item.id, item.webContentsId, item.hidden)
          // Only a page of Tessel's browser, in its own sessions.
          if (!guestOf(page)) continue
          pages.set(item.id, page)
        } else if (!!item.hidden !== page.hidden) setHidden(item.id, !!item.hidden)
      }
    },
    // onFrame(event): { type: 'frame', seq, jpeg (Buffer), w, h, viewport
    // ({ width, height } CSS pixels, or null), meta: { title, url } },
    // { type: 'paused', reason } or { type: 'ended', reason }.
    // behind() -> true while this watcher's connection is behind (its frames
    // are skipped). -> unwatch
    watch(pageId, onFrame, { behind: isBehind = () => false } = {}) {
      if (typeof onFrame !== 'function') return () => {}
      const page = typeof pageId === 'string' ? pages.get(pageId) : null
      if (!page || !guestOf(page)) {
        if (page) end(page, 'gone')
        tell({ onFrame }, { type: 'ended', reason: 'gone' })
        return () => {}
      }
      const watcher = { onFrame, behind: isBehind, sentSeq: 0, lastSentAt: -Infinity, state: null }
      page.watchers.add(watcher)
      if (page.hidden) {
        watcher.state = 'hidden'
        tell(watcher, { type: 'paused', reason: 'hidden' })
      } else if (page.running) {
        if (page.paused) {
          watcher.state = page.paused
          tell(watcher, { type: 'paused', reason: page.paused })
        } else pump(page)
      } else start(page)
      if (page.waiting && watcher.state !== 'limit') {
        watcher.state = 'limit'
        tell(watcher, { type: 'paused', reason: 'limit' })
      }
      let done = false
      return () => {
        if (done) return
        done = true
        page.watchers.delete(watcher)
        if (!page.watchers.size) stop(page)
      }
    },
    setHidden,
    // The page's title and address as guests see them, read from the page
    // itself (never from the window). -> { title, url } | null
    meta(pageId) {
      const page = pages.get(pageId)
      return page ? pageMeta(page) : null
    },
    // For createPageInput: the page's webContents and its last viewport (CSS
    // pixels). Main process only; never sent to a guest.
    target(pageId) {
      const page = typeof pageId === 'string' ? pages.get(pageId) : null
      const guest = page ? guestOf(page) : null
      return guest ? { guest, viewport: page.viewport, hidden: page.hidden } : null
    },
    // Watched pages and their state, for the host's eye indicator and tests.
    watching() {
      return [...pages.values()].filter((p) => p.watchers.size).map((p) => ({ id: p.id, watchers: p.watchers.size, running: p.running, paused: p.paused, quality: p.quality, mode: p.mode }))
    },
    stop() {
      for (const page of [...pages.values()]) end(page, 'stopped')
    }
  }
}

// --- "Use my browser pages": a guest's input ---------------------------------------
export const INPUT_LIMITS = Object.freeze({
  events: 50,
  text: 1000,
  moves: 30, // a second
  actions: 20, // clicks, keys, wheel, navigation: a second
  actionsPerMinute: 600,
  newPages: 3, // a minute
  noticeMs: 60 * 1000,
  idleMs: 30 * 1000,
  wheel: 2000
})
// Keys no guest presses, beyond the browser's and Tessel's own (reservedKey:
// paste, Ctrl+W/M/Q, Alt+F4, F11, the browser's shortcuts): devtools, view
// source, save, print, open.
export function refusedGuestKey(combo) {
  let parsed
  try {
    parsed = parseKeyCombo(combo)
  } catch {
    return true
  }
  if (reservedKey(combo)) return true
  const k = String(parsed.def.key).toLowerCase()
  const ctrl = (parsed.modifiers & 6) !== 0
  if (k === 'f12') return true
  if (ctrl && (parsed.modifiers & 8) && ['i', 'j', 'c'].includes(k)) return true
  // Copy and cut write to the host's clipboard: what a guest typed could be
  // pasted by the host somewhere else (a terminal). Nothing a guest can use.
  if ((ctrl && ['c', 'x', 'insert'].includes(k)) || ((parsed.modifiers & 8) && k === 'delete')) return true
  return ctrl && ['u', 's', 'p', 'o'].includes(k)
}

const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' }
const finiteIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
function modifierBits(m) {
  if (!m || typeof m !== 'object') return 0
  return (m.alt === true ? 1 : 0) | (m.ctrl === true || m.control === true ? 2 : 0) | (m.meta === true ? 4 : 0) | (m.shift === true ? 8 : 0)
}
function comboOf(event) {
  const m = event.modifiers || {}
  const parts = []
  if (m.ctrl === true || m.control === true) parts.push('Control')
  if (m.alt === true) parts.push('Alt')
  if (m.shift === true) parts.push('Shift')
  if (m.meta === true) parts.push('Meta')
  parts.push(event.key)
  return parts.join('+')
}

// A guest's input in a page it sees: refused buttons and keys, addresses
// only through the browser's rule, rate limits per guest, nothing while an
// agent drives the page. Not wired to the protocol yet.
// target(pageId) -> { guest, viewport, hidden } | null (createSharePages().target)
// -> { handle(guestKey, pageId, events) -> { ok, done, refused: [codes], notice? },
//      newPage(guestKey) -> bool, release(pageId), stop() }
export function createPageInput({ target, lease = leaseDebugger, holders = debuggerHolders, clock = Date.now, timers = globalThis } = {}) {
  // guest key -> its budgets (kept while the share lasts: a reconnect does not reset them)
  const budgets = new Map()
  // page id -> { lease, guest, idle, focus: bool, cache }
  const held = new Map()

  function budgetOf(key) {
    let b = budgets.get(key)
    if (!b) {
      b = { moves: [], actions: [], minute: [], newPages: [], noticeAt: -Infinity }
      if (budgets.size >= 256) budgets.delete(budgets.keys().next().value)
      budgets.set(key, b)
    }
    return b
  }
  // A sliding window: true (and counted) when there is room.
  function take(list, max, windowMs, now) {
    while (list.length && now - list[0] >= windowMs) list.shift()
    if (list.length >= max) return false
    list.push(now)
    return true
  }

  function release(pageId) {
    const h = held.get(pageId)
    if (!h) return
    held.delete(pageId)
    if (h.idle) timers.clearTimeout(h.idle)
    if (h.lease.active && !h.lease.alone && !holders(h.guest).includes('agent')) h.lease.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
    h.lease.release()
  }
  function holdFor(pageId, guest) {
    let h = held.get(pageId)
    if (h && (h.guest !== guest || !h.lease.active)) {
      release(pageId)
      h = null
    }
    if (!h) {
      let taken
      try {
        taken = lease(guest, 'live-share-input', { onDetach: () => held.get(pageId) === h && held.delete(pageId) })
      } catch {
        throw new BrowserInputError('busy', 'The page\'s debugger is in use (its devtools are open).')
      }
      h = { lease: taken, guest, idle: null, cache: { world: null, secretIds: new Set() } }
      held.set(pageId, h)
    }
    if (h.idle) timers.clearTimeout(h.idle)
    h.idle = timers.setTimeout(() => release(pageId), INPUT_LIMITS.idleMs)
    h.idle?.unref?.()
    return h
  }

  async function viewportOf(h, given) {
    if (given && given.width > 0 && given.height > 0) return given
    const m = await h.lease.send('Page.getLayoutMetrics').catch(() => null)
    const v = m && (m.cssLayoutViewport || m.layoutViewport)
    return v && v.clientWidth > 0 && v.clientHeight > 0 ? { width: v.clientWidth, height: v.clientHeight } : null
  }

  async function handle(guestKey, pageId, events) {
    const key = typeof guestKey === 'string' && guestKey ? guestKey : null
    if (!key || !Array.isArray(events) || events.length > INPUT_LIMITS.events) return { ok: false, code: 'invalid', done: 0, refused: [] }
    const t = target(pageId)
    if (!t || !t.guest) return { ok: false, code: 'gone', done: 0, refused: [] }
    if (t.hidden) return { ok: false, code: 'hidden', done: 0, refused: [] }
    // An agent drives the page: its commands and a guest's clicks would mix.
    if (holders(t.guest).includes('agent')) return { ok: false, code: 'agent', done: 0, refused: [] }
    const b = budgetOf(key)
    const refused = new Set()
    let limited = false
    let done = 0
    let h = null
    const send = (method, params) => h.lease.send(method, params)
    for (const event of events) {
      if (!event || typeof event !== 'object') {
        refused.add('invalid')
        continue
      }
      const now = clock()
      const isMove = event.type === 'mouse' && event.action === 'move'
      // Refusals first: they cost no budget.
      let code = null
      if (event.type === 'mouse') {
        if (!Object.hasOwn(MOUSE_TYPES, event.action) || !finiteIn(event.x, 0, 1) || !finiteIn(event.y, 0, 1)) code = 'invalid'
        // The right button would open the menu on the host's screen; the
        // middle one and the side ones are the browser's own.
        else if ((event.action === 'down' || event.action === 'up') && event.button !== 'left') code = 'button'
      } else if (event.type === 'key') {
        if (typeof event.key !== 'string' || !event.key || event.key.length > 20) code = 'invalid'
        else if (refusedGuestKey(comboOf(event))) code = 'key'
      } else if (event.type === 'text') {
        if (typeof event.text !== 'string' || !event.text) code = 'invalid'
        else if (event.text.length > INPUT_LIMITS.text) code = 'too_long'
      } else if (event.type === 'navigate') {
        if (!['back', 'forward', 'reload'].includes(event.action) && !(typeof event.url === 'string' && event.url.length <= 4000 && allowedBrowserUrl(event.url))) code = 'url'
      } else code = 'invalid'
      if (code) {
        refused.add(code)
        continue
      }
      // Budgets: moves are dropped past their rate; the rest refused.
      if (isMove) {
        if (!take(b.moves, INPUT_LIMITS.moves, 1000, now)) continue
      } else {
        while (b.minute.length && now - b.minute[0] >= 60000) b.minute.shift()
        if (b.minute.length >= INPUT_LIMITS.actionsPerMinute || !take(b.actions, INPUT_LIMITS.actions, 1000, now)) {
          limited = true
          continue
        }
        b.minute.push(now)
      }
      try {
        if (!h) {
          h = holdFor(pageId, t.guest)
          await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
        }
        if (event.type === 'mouse') {
          const view = await viewportOf(h, t.viewport)
          if (!view) {
            refused.add('not_ready')
            continue
          }
          const x = event.x * view.width
          const y = event.y * view.height
          const modifiers = modifierBits(event.modifiers)
          if (event.action === 'wheel') {
            const dx = finiteIn(event.dx, -INPUT_LIMITS.wheel, INPUT_LIMITS.wheel) ? event.dx : 0
            const dy = finiteIn(event.dy, -INPUT_LIMITS.wheel, INPUT_LIMITS.wheel) ? event.dy : 0
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers })
          } else {
            const clickCount = Number.isInteger(event.clicks) && event.clicks >= 1 && event.clicks <= 3 ? event.clicks : 1
            const pressed = event.action === 'down'
            await send('Input.dispatchMouseEvent', {
              type: MOUSE_TYPES[event.action],
              x,
              y,
              modifiers,
              button: event.action === 'move' ? (event.buttons === 1 ? 'left' : 'none') : 'left',
              buttons: pressed || (event.action === 'move' && event.buttons === 1) ? 1 : 0,
              ...(event.action === 'move' ? {} : { clickCount })
            })
          }
        } else if (event.type === 'key') {
          await pressKey(send, comboOf(event), typeof t.guest.sendInputEvent === 'function' ? (ev) => t.guest.sendInputEvent(ev) : null, h.cache, [])
        } else if (event.type === 'text') {
          // The page's own pipeline (Electron's insertText), looked at before
          // each piece: never into a password field, nor where Tessel cannot
          // see the keyboard (a frame from another site: CDP's insertText
          // there, as agents do; webContents.insertText would crash it).
          const guest = t.guest
          await insertFocusedText(send, event.text, typeof guest.insertText === 'function' ? (part) => guest.insertText(part) : null, () => focusedField(send, h.cache))
        } else if (event.type === 'navigate') {
          const guest = t.guest
          // Deferred: never inside the page's own events (Electron 42).
          if (event.action === 'back') timers.setTimeout(() => guest.navigationHistory?.canGoBack?.() && guest.navigationHistory.goBack(), 0)
          else if (event.action === 'forward') timers.setTimeout(() => guest.navigationHistory?.canGoForward?.() && guest.navigationHistory.goForward(), 0)
          else if (event.action === 'reload') timers.setTimeout(() => guest.reload(), 0)
          else {
            const url = allowedBrowserUrl(event.url)
            timers.setTimeout(() => Promise.resolve(guest.loadURL(url)).catch(() => {}), 0)
          }
        }
        done++
      } catch (err) {
        if (err instanceof BrowserInputError) refused.add(err.code === 'password_field' ? 'password' : err.code === 'field_not_visible' ? 'field_not_visible' : err.code)
        else refused.add('page_error')
      }
    }
    const out = { ok: true, done, refused: [...refused] }
    // Past a limit: said once a minute.
    if (limited && clock() - b.noticeAt >= INPUT_LIMITS.noticeMs) {
      b.noticeAt = clock()
      out.notice = 'limit'
    }
    return out
  }

  return {
    handle,
    // A page a guest's click opens (browserGuest.js's new window rule): at
    // most INPUT_LIMITS.newPages a minute per guest.
    newPage(guestKey) {
      if (typeof guestKey !== 'string' || !guestKey) return false
      return take(budgetOf(guestKey).newPages, INPUT_LIMITS.newPages, 60000, clock())
    },
    release,
    stop() {
      for (const id of [...held.keys()]) release(id)
      budgets.clear()
    }
  }
}
