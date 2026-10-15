// A Live Share pane (the host's terminal, shown on a guest's screen) keeps
// the host's columns and rows (never resized for a guest), drawn at the
// guest's own text size (TerminalPane.vue fitLiveShareFont, liveShareFit.js):
// larger text in a larger pane, smaller in a smaller one down to 75% of it
// (never under 9 px), so a host's terminal a bit wider than the pane fits
// without scrolling; only one still too big scrolls here, following the
// cursor, with Tessel's own thin bar (never the native one with arrows).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveShareFit, liveShareFontRange } from '../liveShareFit'

// The pane's room in pixels, and the cell size the font gives (6/10 of the
// font size wide, 12/10 high), as xterm's fit addon measures them.
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
      this._core = { _renderService: { dimensions: { css: { get cell() { return { width: term.options.fontSize * 0.6, height: term.options.fontSize * 1.2 } } } } } }
      made.push(this)
    }
    write(_d, cb) {
      cb?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      this.element = document.createElement('div')
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

describe('a Live Share pane on a guest screen', () => {
  let wrapper, host, previousApi
  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    settings.fontSize = 14
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    window.shellApi = {
      resizePty: vi.fn(),
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
    vi.unstubAllGlobals()
    made.length = 0
  })

  async function show(w, h) {
    room.w = w
    room.h = h
    const ctx = {
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
      routeInput: vi.fn()
    }
    const node = { id: 'pane-ls1-a', type: 'leaf', kind: 'shell', title: 'PowerShell', backend: 'liveshare', attached: true, liveShare: { session: 1, cols: 120, rows: 30, canType: true, host: 'Ada' } }
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await flushPromises()
    return made.at(-1)
  }

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
    expect(wrapper.find('.term-host').element.classList.contains('ls-scroll')).toBe(false)
    expect(term.element.style.width).toBe('')
  })

  it('a pane much smaller than the host’s terminal: readable text, and it scrolls here', async () => {
    const term = await show(360, 240)
    // 75% of the usual 14 px at most, never shrunk further to fit.
    expect(term.options.fontSize).toBe(10.5)
    expect(term.cols).toBe(120)
    expect(term.rows).toBe(30)
    const hostEl = wrapper.find('.term-host').element
    expect(hostEl.classList.contains('ls-scroll')).toBe(true)
    // Drawn at its full size (120 x 30 cells of 6.3 x 12.6 px), never scaled.
    expect(term.element.style.width).toBe(`${Math.ceil(10.5 * 0.6 * 120)}px`)
    expect(term.element.style.height).toBe(`${Math.ceil(10.5 * 1.2 * 30)}px`)
    expect(term.element.style.transform).toBe('')
    expect(term.element.style.pointerEvents).toBe('')
  })

  it('it follows the cursor, unless scrolled by hand a moment ago', async () => {
    const term = await show(360, 240)
    const hostEl = wrapper.find('.term-host').element
    Object.defineProperty(hostEl, 'clientWidth', { configurable: true, value: 360 })
    Object.defineProperty(hostEl, 'clientHeight', { configurable: true, value: 240 })
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      fn()
      return 1
    })
    try {
      // The cursor near the right and the bottom (Claude Code's input line).
      term.buffer.active.cursorX = 100
      term.buffer.active.cursorY = 28
      term.written()
      expect(hostEl.scrollLeft).toBeGreaterThan(0)
      expect(hostEl.scrollTop).toBeGreaterThan(0)
      const cellW = 10.5 * 0.6
      expect(100 * cellW).toBeGreaterThanOrEqual(hostEl.scrollLeft)
      expect(100 * cellW).toBeLessThanOrEqual(hostEl.scrollLeft + 360)
      // Scrolled by hand: left there while the cursor moves.
      await new Promise((r) => setTimeout(r, 200))
      hostEl.scrollLeft = 0
      hostEl.dispatchEvent(new Event('scroll'))
      term.buffer.active.cursorX = 110
      term.written()
      expect(hostEl.scrollLeft).toBe(0)
    } finally {
      raf.mockRestore()
    }
  })

  it('a host’s terminal that fits: no scrolling here', async () => {
    const term = await show(2000, 1200)
    expect(wrapper.find('.term-host').element.classList.contains('ls-scroll')).toBe(false)
    expect(term.element.style.width).toBe('')
  })

  it('a larger pane: larger text, no empty band (up to twice the usual size)', async () => {
    const term = await show(2000, 1200)
    expect(term.cols).toBe(120)
    const size = term.options.fontSize
    expect(size).toBeGreaterThan(14)
    expect(size).toBeLessThanOrEqual(28)
    expect(Math.floor(2000 / (size * 0.6))).toBeGreaterThanOrEqual(120)
  })
})

describe('liveShareFit: fit the host’s terminal, or scroll', () => {
  it('the text goes from 75% of the guest’s size (never under 9 px) to twice it', () => {
    expect(liveShareFontRange(14)).toEqual({ min: 10.5, max: 28 })
    expect(liveShareFontRange(13)).toEqual({ min: 9.5, max: 26 })
    expect(liveShareFontRange(12)).toEqual({ min: 9, max: 24 })
    expect(liveShareFontRange(10)).toEqual({ min: 9, max: 20 })
    expect(liveShareFontRange(8)).toEqual({ min: 8, max: 16 })
  })

  // The pane is `w` px wide; the host's terminal 120 columns of 0.6 x the text size.
  const widthRoom = (w) => (size) => Math.floor(w / (size * 0.6)) / 120

  it('somewhat wider than the pane: smaller text that fits, no scrolling', () => {
    expect(liveShareFit(14, 14, widthRoom(900))).toEqual({ size: 12, scroll: false })
    expect(liveShareFit(14, 14, widthRoom(760))).toEqual({ size: 10.5, scroll: false })
  })

  it('too wide even at the smallest size: that size, and it scrolls', () => {
    expect(liveShareFit(14, 14, widthRoom(600))).toEqual({ size: 10.5, scroll: true })
    expect(liveShareFit(12, 12, widthRoom(300))).toEqual({ size: 9, scroll: true })
  })

  it('a larger pane: larger text, up to twice; not measurable now: left as it is', () => {
    expect(liveShareFit(14, 14, widthRoom(2000))).toEqual({ size: 27.5, scroll: false })
    expect(liveShareFit(14, 14, widthRoom(5000))).toEqual({ size: 28, scroll: false })
    expect(liveShareFit(14, 12, () => null)).toEqual({ size: 12, scroll: false })
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
