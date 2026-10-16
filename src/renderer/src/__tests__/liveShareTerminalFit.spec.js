// A Live Share pane (the host's terminal, shown on a guest's screen) keeps
// the host's columns and rows (never resized for a guest), drawn at the
// largest text size where all of them fit the guest's pane
// (TerminalPane.vue fitLiveShareFont, liveShareFit.js): larger than the
// guest's own size in a larger pane (a hidden sidebar, a maximized pane), up
// to 1.6 times and never over 22 px, never so large that rows go past the
// bottom, and centred across when the height is what limits it; smaller in a
// smaller pane down to 75% of it (never under 9 px), so a host's terminal a
// bit wider than the pane fits without scrolling; only one still too big
// scrolls here, following the cursor, with Tessel's own thin bar (never the
// native one with arrows). The guest's Text size choice (fit, width, normal)
// is local: nothing goes to the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveShareFit, liveShareFontRange, liveShareOffset } from '../liveShareFit'

// The pane's room in pixels, and the cell size the font gives (6/10 of the
// font size wide, 12/10 high), as xterm's renderer measures it.
const room = { w: 1000, h: 600 }
const made = []
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = { ...options }
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = { active: { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '' }) } }
      const term = this
      this.measured = 0
      this._core = {
        _renderService: { dimensions: { css: { get cell() { return { width: term.options.fontSize * 0.6, height: term.options.fontSize * 1.2 } } } } },
        _charSizeService: { measure: () => term.measured++ }
      }
      made.push(this)
    }
    write(_d, cb) {
      cb?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      this.screenElement = document.createElement('div')
      this.screenElement.className = 'xterm-screen'
      this.element.append(this.screenElement)
      host.append(this.textarea, this.element)
    }
    resize(cols, rows) {
      this.cols = cols
      this.rows = rows
    }
    loadAddon(addon) {
      addon.term = this
    }
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed(cb) {
      this.written = cb
    }
    onData() {}
    onResize() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    getSelection() {
      return ''
    }
    clearSelection() {}
    focus() {}
    dispose() {}
    scrollToBottom() {}
    scrollToLine() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      const size = this.term.options.fontSize
      return { cols: Math.floor(room.w / (size * 0.6)), rows: Math.floor(room.h / (size * 1.2)) }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// TerminalPane's RESIZE_SETTLE_MS (90), and a little more.
const SETTLED = 130

describe('a Live Share pane on a guest screen', () => {
  let wrapper, host, previousApi, observers, ctx, node, boxes
  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    settings.fontSize = 14
    previousApi = window.shellApi
    // The pane's box: what the ResizeObserver watches and fitLiveShareFont
    // measures (jsdom lays nothing out).
    observers = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb) {
          this.cb = cb
          this.els = []
          observers.push(this)
        }
        observe(el) {
          this.els.push(el)
        }
        disconnect() {}
      }
    )
    boxes = ['offsetWidth', 'offsetHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)])
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('term-host') ? room.w : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('term-host') ? room.h : 0 } })
    window.shellApi = {
      resizePty: vi.fn(),
      writePty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      attachPty: vi.fn(async () => ({ ok: true, buffer: '', backend: 'liveshare', shell: { id: 'liveshare', name: 'Ada' } })),
      agentModel: vi.fn(async () => null)
    }
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    wrapper?.unmount()
    host.remove()
    resetSettings()
    window.shellApi = previousApi
    for (const [k, d] of boxes) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d)
      else delete HTMLElement.prototype[k]
    }
    vi.unstubAllGlobals()
    made.length = 0
  })

  async function show(w, h, { cols = 120, rows = 30, textSize } = {}) {
    room.w = w
    room.h = h
    ctx = {
      activeId: ref('ls'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref('EN'),
      voiceLanguages: ref([]),
      voiceTyping: vi.fn(),
      voiceTypingIn: vi.fn(),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      teamById: () => null,
      trackOf: () => null,
      unsent: {},
      resolveUnsent: vi.fn(),
      otherPanes: () => [],
      openLauncherAt: vi.fn(),
      setActive: vi.fn(),
      toggleMaximize: vi.fn(),
      closeLeaf: vi.fn(),
      routeInput: vi.fn(),
      // liveShareWindow.js setGuestTextSize: the leaf's own field, nothing else.
      liveShareTextSize: vi.fn((id, size) => {
        node.liveShare.textSize = size
        return true
      })
    }
    node = reactive({ id: 'pane-ls1-a', type: 'leaf', kind: 'shell', title: 'PowerShell', backend: 'liveshare', attached: true, liveShare: { session: 1, cols, rows, canType: true, host: 'Ada', ...(textSize ? { textSize } : {}) } })
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await flushPromises()
    return made.at(-1)
  }
  // The guest's pane takes a new size (the sidebar hidden or shown, a
  // splitter dragged, the pane maximized): only its ResizeObserver says so.
  async function resizePane(w, h) {
    room.w = w
    room.h = h
    for (const o of observers) o.cb([])
    await wait(SETTLED)
  }
  const hostEl = () => wrapper.find('.term-host').element
  const leftOf = (term) => parseInt(term.element.style.paddingLeft || '0', 10)
  // Every size sent anywhere is the host's own (a guest never resizes it).
  const onlyHostSizes = (cols, rows) => window.shellApi.resizePty.mock.calls.every(([, c, r]) => c === cols && r === rows)

  it('a smaller pane than the host’s: smaller text, every column and row shown', async () => {
    const term = await show(1000, 600)
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(30)
    const size = term.options.fontSize
    expect(size).toBeLessThan(14)
    // It fits, and a half point more would not.
    expect(Math.floor(1000 / (size * 0.6))).toBeGreaterThanOrEqual(120)
    expect(Math.floor(1000 / ((size + 0.5) * 0.6))).toBeLessThan(120)
  })

  it('a host’s terminal a bit wider than the pane: smaller text, and it fits (no scrolling)', async () => {
    // 120 columns at 14 px need 1008 px: at 11 px they fit in 800.
    const term = await show(800, 600)
    expect(term.options.fontSize).toBe(11)
    expect(term.cols).toBe(120)
    expect(hostEl().classList.contains('ls-scroll')).toBe(false)
    expect(term.element.style.width).toBe('')
  })

  it('a pane much smaller than the host’s terminal: readable text, and it scrolls here', async () => {
    const term = await show(360, 240)
    // 75% of the usual 14 px at most, never shrunk further to fit.
    expect(term.options.fontSize).toBe(10.5)
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(30)
    expect(hostEl().classList.contains('ls-scroll')).toBe(true)
    // Drawn at its full size (120 x 30 cells of 6.3 x 12.6 px), never scaled.
    expect(term.element.style.width).toBe(`${Math.ceil(10.5 * 0.6 * 120)}px`)
    expect(term.element.style.height).toBe(`${Math.ceil(10.5 * 1.2 * 30)}px`)
    expect(term.element.style.transform).toBe('')
    expect(term.element.style.pointerEvents).toBe('')
    expect(leftOf(term)).toBe(0)
  })

  it('it follows the cursor, unless scrolled by hand a moment ago', async () => {
    const term = await show(360, 240)
    const el = hostEl()
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 360 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 240 })
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      fn()
      return 1
    })
    try {
      // The cursor near the right and the bottom (Claude Code's input line).
      term.buffer.active.cursorX = 100
      term.buffer.active.cursorY = 28
      term.written()
      expect(el.scrollLeft).toBeGreaterThan(0)
      expect(el.scrollTop).toBeGreaterThan(0)
      const cellW = 10.5 * 0.6
      expect(100 * cellW).toBeGreaterThanOrEqual(el.scrollLeft)
      expect(100 * cellW).toBeLessThanOrEqual(el.scrollLeft + 360)
      // Scrolled by hand: left there while the cursor moves.
      await wait(200)
      el.scrollLeft = 0
      el.dispatchEvent(new Event('scroll'))
      term.buffer.active.cursorX = 110
      term.written()
      expect(el.scrollLeft).toBe(0)
    } finally {
      raf.mockRestore()
    }
  })

  it('a host’s terminal that fits: no scrolling here', async () => {
    const term = await show(2000, 1200)
    expect(hostEl().classList.contains('ls-scroll')).toBe(false)
    expect(term.element.style.width).toBe('')
  })

  it('a larger pane, width the limit: larger text that fills the width (all rows still shown)', async () => {
    // 80 x 24 in 1000 x 600 px: 20.5 px gives 984 px of columns and 590 of rows.
    const term = await show(1000, 600, { cols: 80, rows: 24 })
    expect(term.options.fontSize).toBe(20.5)
    expect(80 * 20.5 * 0.6).toBeLessThanOrEqual(1000)
    expect(80 * 21 * 0.6).toBeGreaterThan(1000)
    expect(24 * 20.5 * 1.2).toBeLessThanOrEqual(600)
    expect(hostEl().classList.contains('ls-scroll')).toBe(false)
    // Nearly as wide as the pane: the few px left are split.
    expect(leftOf(term)).toBe(Math.floor((1000 - Math.ceil(80 * 20.5 * 0.6)) / 2))
    expect(term.cols).toBe(80)
    expect(term.rows).toBe(24)
  })

  it('a larger pane, height the limit: as large as its rows allow, never past the bottom, centred across', async () => {
    // 57 x 40 (a narrow, tall pane on the host) in 1000 x 600: the rows
    // allow 12.5 px (600 px exactly), the columns would allow 29.
    const term = await show(1000, 600, { cols: 57, rows: 40 })
    const size = term.options.fontSize
    expect(size).toBe(12.5)
    expect(40 * size * 1.2).toBeLessThanOrEqual(600)
    expect(40 * (size + 0.5) * 1.2).toBeGreaterThan(600)
    expect(hostEl().classList.contains('ls-scroll')).toBe(false)
    // The room left is split on both sides (whole px), not left on the right.
    const width = Math.ceil(57 * size * 0.6)
    expect(leftOf(term)).toBe(Math.floor((1000 - width) / 2))
    expect(leftOf(term)).toBeGreaterThan(250)
    // A padding on xterm's element: its screen moves with it, nothing scaled.
    expect(term.element.style.transform).toBe('')
    expect(term.screenElement.style.paddingLeft).toBe('')
    expect(term.element.style.width).toBe('')
  })

  it('the caps: at most 1.6 times the guest’s size, never over 22 px (a guest’s own larger size is kept)', async () => {
    let term = await show(2000, 1200)
    expect(term.options.fontSize).toBe(22)
    wrapper.unmount()
    wrapper = null
    settings.fontSize = 12
    term = await show(2000, 1200)
    expect(term.options.fontSize).toBe(19)
    wrapper.unmount()
    wrapper = null
    settings.fontSize = 24
    term = await show(3000, 1500)
    expect(term.options.fontSize).toBe(24)
  })

  it('a tiny host terminal: the cap, not poster text, centred', async () => {
    const term = await show(1000, 600, { cols: 20, rows: 5 })
    expect(term.options.fontSize).toBe(22)
    expect(leftOf(term)).toBe(Math.floor((1000 - Math.ceil(20 * 22 * 0.6)) / 2))
    expect(term.cols).toBe(20)
    expect(term.rows).toBe(5)
  })

  it('the guest hides the sidebar or drags a splitter: the pane’s ResizeObserver refits it, and back', async () => {
    const term = await show(700, 600, { cols: 80, rows: 24 })
    // Watched: the pane's box and the pane (not only the window's size).
    const watched = observers.flatMap((o) => o.els)
    expect(watched).toContain(hostEl())
    expect(watched).toContain(hostEl().parentElement)
    expect(term.options.fontSize).toBe(14.5)
    // The sidebar hidden: the pane 300 px wider, the text fills the new width.
    await resizePane(1000, 600)
    expect(term.options.fontSize).toBe(20.5)
    expect(80 * 20.5 * 0.6).toBeGreaterThan(0.95 * 1000)
    // Shown again: the same size as before (whatever the size drawn now).
    await resizePane(700, 600)
    expect(term.options.fontSize).toBe(14.5)
    // Not on every frame of a drag: once it settles.
    const before = term.options.fontSize
    room.w = 1000
    for (const o of observers) o.cb([])
    await wait(20)
    room.w = 900
    for (const o of observers) o.cb([])
    await wait(20)
    expect(term.options.fontSize).toBe(before)
    await wait(SETTLED)
    expect(term.options.fontSize).toBe(18.5)
    expect(term.cols).toBe(80)
    expect(term.rows).toBe(24)
    expect(onlyHostSizes(80, 24)).toBe(true)
  })

  it('a pane maximized on the guest: refitted to the larger pane', async () => {
    const term = await show(700, 600, { cols: 80, rows: 24 })
    expect(term.options.fontSize).toBe(14.5)
    room.w = 1400
    room.h = 800
    ctx.maximizedId.value = node.id
    await wait(SETTLED)
    expect(term.options.fontSize).toBe(22)
  })

  it('the host resizes its terminal: this one takes its size, and a new text size, at once', async () => {
    const term = await show(1000, 600, { cols: 120, rows: 30 })
    expect(term.options.fontSize).toBe(13.5)
    node.liveShare.cols = 80
    node.liveShare.rows = 24
    await flushPromises()
    expect(term.cols).toBe(80)
    expect(term.rows).toBe(24)
    expect(term.options.fontSize).toBe(20.5)
    // Back to a terminal too big: smaller again, scrolling.
    node.liveShare.cols = 200
    node.liveShare.rows = 60
    await flushPromises()
    expect(term.options.fontSize).toBe(10.5)
    expect(hostEl().classList.contains('ls-scroll')).toBe(true)
    expect(leftOf(term)).toBe(0)
    // Its size is the host's: never one this guest picks.
    expect(window.shellApi.resizePty.mock.calls.every(([, c, r]) => (c === 120 && r === 30) || (c === 80 && r === 24) || (c === 200 && r === 60))).toBe(true)
  })

  it('the mouse at the new size: xterm’s cell and the centred screen map a click to its cell', async () => {
    // xterm (Mouse.ts getCoords) maps a click from its screen's box and the
    // renderer's cell size: the offset is outside the screen (a padding on
    // its parent), and the cell is the one the size was chosen with.
    const term = await show(1000, 600, { cols: 57, rows: 40 })
    const cell = term._core._renderService.dimensions.css.cell
    expect(cell.width).toBe(term.options.fontSize * 0.6)
    const screenLeft = leftOf(term) // the screen starts after the padding
    const getCoords = (clientX, clientY) => [Math.min(Math.max(Math.ceil((clientX - screenLeft) / cell.width), 1), term.cols), Math.min(Math.max(Math.ceil(clientY / cell.height), 1), term.rows)]
    for (const [c, r] of [[1, 1], [10, 5], [57, 40], [30, 20]]) {
      const x = screenLeft + (c - 0.5) * cell.width
      const y = (r - 0.5) * cell.height
      expect(getCoords(x, y)).toEqual([c, r])
    }
    expect(term.element.style.transform).toBe('')
    expect(term.element.style.pointerEvents).toBe('')
  })

  it('a font that loads late: measured again and refitted', async () => {
    // jsdom has no FontFaceSet: one that only sends its events.
    const had = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
    try {
      const term = await show(1000, 600, { cols: 80, rows: 24 })
      const measured = term.measured
      // The font's cells came out larger than measured at first.
      term.options.fontSize = 30
      document.fonts.dispatchEvent(new Event('loadingdone'))
      expect(term.measured).toBe(measured + 1)
      await wait(SETTLED)
      expect(term.options.fontSize).toBe(20.5)
      wrapper.unmount()
      wrapper = null
      // Gone with the pane.
      document.fonts.dispatchEvent(new Event('loadingdone'))
      expect(term.measured).toBe(measured + 1)
    } finally {
      if (had) Object.defineProperty(document, 'fonts', had)
      else delete document.fonts
    }
  })

  describe('Text size (pane menu, on this screen only)', () => {
    const openMenu = async () => {
      await wrapper.get('[data-test="pane-menu-btn"]').trigger('click')
      await flushPromises()
      return document.body.querySelector('[data-test="pane-ls-text-size"]')
    }

    it('the menu offers fit, width and normal; fit is chosen at first', async () => {
      await show(1000, 600, { cols: 57, rows: 40 })
      const row = await openMenu()
      expect(row).toBeTruthy()
      expect(row.querySelector('[data-test="ls-text-fit"]').classList.contains('selected')).toBe(true)
      expect(row.querySelector('[data-test="ls-text-width"]').classList.contains('selected')).toBe(false)
      expect(row.querySelector('[data-test="ls-text-normal"]').classList.contains('selected')).toBe(false)
    })

    it('normal: the guest’s own size, never made larger; a larger terminal scrolls', async () => {
      const term = await show(1000, 600, { cols: 57, rows: 40 })
      expect(term.options.fontSize).toBe(12.5)
      ;(await openMenu()).querySelector('[data-test="ls-text-normal"]').click()
      await flushPromises()
      expect(ctx.liveShareTextSize).toHaveBeenCalledWith('pane-ls1-a', 'normal')
      expect(term.options.fontSize).toBe(14)
      // 40 rows of 16.8 px do not fit 600: it scrolls (no smaller text).
      expect(hostEl().classList.contains('ls-scroll')).toBe(true)
      // A smaller host terminal: still 14, centred, no scrolling.
      node.liveShare.cols = 57
      node.liveShare.rows = 20
      await flushPromises()
      expect(term.options.fontSize).toBe(14)
      expect(hostEl().classList.contains('ls-scroll')).toBe(false)
      expect(leftOf(term)).toBe(Math.floor((1000 - Math.ceil(57 * 14 * 0.6)) / 2))
    })

    it('width: as large as the columns allow (the cap), rows past the bottom scroll; back to fit', async () => {
      const term = await show(700, 600, { cols: 57, rows: 40 })
      ;(await openMenu()).querySelector('[data-test="ls-text-width"]').click()
      await flushPromises()
      // 57 columns in 700 px allow 20 px (20.5 needs 701).
      expect(term.options.fontSize).toBe(20)
      expect(hostEl().classList.contains('ls-scroll')).toBe(true)
      expect(term.element.style.height).toBe(`${Math.ceil(20 * 1.2 * 40)}px`)
      ;(await openMenu()).querySelector('[data-test="ls-text-fit"]').click()
      await flushPromises()
      expect(term.options.fontSize).toBe(12.5)
      expect(hostEl().classList.contains('ls-scroll')).toBe(false)
      expect(term.element.style.height).toBe('')
    })

    it('the choice the pane already has (kept for the session) is used when it opens', async () => {
      const term = await show(1000, 600, { cols: 57, rows: 40, textSize: 'normal' })
      expect(term.options.fontSize).toBe(14)
      const row = await openMenu()
      expect(row.querySelector('[data-test="ls-text-normal"]').classList.contains('selected')).toBe(true)
    })

    it('nothing reaches the host: no write, and only the host’s own size anywhere', async () => {
      const term = await show(1000, 600, { cols: 57, rows: 40 })
      for (const size of ['normal', 'width', 'fit']) {
        ;(await openMenu()).querySelector(`[data-test="ls-text-${size}"]`).click()
        await flushPromises()
      }
      expect(window.shellApi.writePty).not.toHaveBeenCalled()
      expect(onlyHostSizes(57, 40)).toBe(true)
      expect(term.cols).toBe(57)
      expect(term.rows).toBe(40)
    })

    it('not in the menu of a pane of this computer', async () => {
      await show(1000, 600)
      node.backend = 'local'
      await flushPromises()
      expect(await openMenu()).toBe(null)
    })
  })
})

describe('liveShareFit: fit the host’s terminal, or scroll', () => {
  it('the text goes from 75% of the guest’s size (never under 9 px) to 1.6 times it, never over 22 px', () => {
    expect(liveShareFontRange(14)).toEqual({ min: 10.5, max: 22 })
    expect(liveShareFontRange(13)).toEqual({ min: 9.5, max: 20.5 })
    expect(liveShareFontRange(12)).toEqual({ min: 9, max: 19 })
    expect(liveShareFontRange(10)).toEqual({ min: 9, max: 16 })
    expect(liveShareFontRange(8)).toEqual({ min: 8, max: 12.5 })
    // A guest's own size over 22 px: kept (the cap only limits growing).
    expect(liveShareFontRange(24)).toEqual({ min: 18, max: 24 })
    // Normal: the guest's own size only.
    expect(liveShareFontRange(14, 'normal')).toEqual({ min: 14, max: 14 })
  })

  // The pane is `w` px wide; the host's terminal 120 columns of 0.6 x the text size.
  const widthRoom = (w) => (size) => Math.floor(w / (size * 0.6)) / 120
  // The pane w x h px; the host's terminal cols x rows of 0.6 x 1.2 the text size.
  const paneRoom = (w, h, cols, rows) => (size) => ({ w: w / (size * 0.6 * cols), h: h / (size * 1.2 * rows) })

  it('somewhat wider than the pane: smaller text that fits, no scrolling', () => {
    expect(liveShareFit(14, 14, widthRoom(900))).toEqual({ size: 12.5, scroll: false })
    expect(liveShareFit(14, 14, widthRoom(760))).toEqual({ size: 10.5, scroll: false })
  })

  it('too wide even at the smallest size: that size, and it scrolls', () => {
    expect(liveShareFit(14, 14, widthRoom(600))).toEqual({ size: 10.5, scroll: true })
    expect(liveShareFit(12, 12, widthRoom(300))).toEqual({ size: 9, scroll: true })
  })

  it('a larger pane: larger text, up to the cap; not measurable now: left as it is', () => {
    expect(liveShareFit(14, 14, widthRoom(2000))).toEqual({ size: 22, scroll: false })
    expect(liveShareFit(14, 14, widthRoom(5000))).toEqual({ size: 22, scroll: false })
    expect(liveShareFit(14, 12, () => null)).toEqual({ size: 12, scroll: false })
  })

  it('both ways: the smaller of the width’s and the height’s room, never past the bottom', () => {
    // Width-limited: 80 x 24 in 1000 x 600.
    expect(liveShareFit(14, 14, paneRoom(1000, 600, 80, 24))).toEqual({ size: 20.5, scroll: false })
    // Height-limited: 57 x 40 in 1000 x 600 (the columns would allow 29 px).
    expect(liveShareFit(14, 14, paneRoom(1000, 600, 57, 40))).toEqual({ size: 12.5, scroll: false })
    // Too tall even at the smallest size: it scrolls.
    expect(liveShareFit(14, 14, paneRoom(1000, 300, 57, 40))).toEqual({ size: 10.5, scroll: true })
  })

  it('the same size whatever the size drawn now (a pane resized back and forth)', () => {
    for (const current of [8, 9, 10.5, 12.5, 13, 17, 22, 28]) {
      expect(liveShareFit(14, current, paneRoom(1000, 600, 57, 40))).toEqual({ size: 12.5, scroll: false })
      expect(liveShareFit(14, current, paneRoom(1000, 600, 80, 24))).toEqual({ size: 20.5, scroll: false })
      expect(liveShareFit(14, current, widthRoom(900))).toEqual({ size: 12.5, scroll: false })
    }
  })

  it('a tiny host terminal: the cap', () => {
    expect(liveShareFit(14, 14, paneRoom(1000, 600, 40, 12))).toEqual({ size: 22, scroll: false })
    expect(liveShareFit(13, 13, paneRoom(1000, 600, 20, 5))).toEqual({ size: 20.5, scroll: false })
  })

  it('width: the columns only, within the same limits; rows past the bottom scroll', () => {
    expect(liveShareFit(14, 14, paneRoom(700, 600, 57, 40), 'width')).toEqual({ size: 20, scroll: true })
    expect(liveShareFit(14, 14, paneRoom(1000, 600, 57, 40), 'width')).toEqual({ size: 22, scroll: true })
    // Rows that fit anyway: no scrolling.
    expect(liveShareFit(14, 14, paneRoom(1000, 600, 80, 24), 'width')).toEqual({ size: 20.5, scroll: false })
  })

  it('normal: the guest’s size; scrolls only when the terminal is larger than the pane', () => {
    expect(liveShareFit(14, 22, paneRoom(1000, 600, 57, 40), 'normal')).toEqual({ size: 14, scroll: true })
    expect(liveShareFit(14, 20.5, paneRoom(1000, 600, 80, 24), 'normal')).toEqual({ size: 14, scroll: false })
  })

  it('the room left is split on both sides, in whole px; none when as wide or wider', () => {
    expect(liveShareOffset(1000, 428)).toEqual({ left: 286 })
    expect(liveShareOffset(1000, 427)).toEqual({ left: 286 })
    expect(liveShareOffset(800, 792)).toEqual({ left: 4 })
    expect(liveShareOffset(700, 700)).toEqual({ left: 0 })
    expect(liveShareOffset(700, 900)).toEqual({ left: 0 })
    expect(liveShareOffset(0, 400)).toEqual({ left: 0 })
  })

  it('Tessel’s own thin scrollbar, never the native one with arrows', () => {
    const css = readFileSync(join(__dirname, '..', 'style.css'), 'utf8')
    const block = (sel) => {
      const at = css.indexOf(`${sel} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    // scrollbar-width would make Chromium drop the ::-webkit-scrollbar styles.
    expect(block('.term-host.ls-scroll')).not.toMatch(/scrollbar-(width|color)/)
    expect(block('.term-host.ls-scroll::-webkit-scrollbar')).toMatch(/width:\s*0/)
    expect(block('.term-host.ls-scroll::-webkit-scrollbar')).toMatch(/height:\s*8px/)
  })
})
