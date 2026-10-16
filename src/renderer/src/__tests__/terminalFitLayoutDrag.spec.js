// A terminal while the projects sidebar's or the right panel's edge is
// dragged (layoutDrag.js): its box follows with CSS alone, its grid and its
// PTY keep their size however long the hand pauses, and it fits once, at
// the size the edge was let go at, when the drag ends. A fit reflows the
// whole scrollback: every terminal of every project refitting at each pause
// stalled the window ("resizing the sidebar lags").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { beginLayoutDrag, layoutDragging, _resetLayoutDragForTests } from '../layoutDrag'

// The pane's room in pixels; a cell is 9 x 18 px.
const room = { w: 900, h: 540 }
const made = []
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = { ...options }
      this.rows = 24
      this.cols = 80
      this.resizes = []
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = { active: { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '' }) } }
      this._core = { _renderService: { dimensions: { css: { cell: { width: 9, height: 18 } } } }, _charSizeService: { measure() {} } }
      made.push(this)
    }
    write(_d, cb) {
      cb?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      host.append(this.textarea, this.element)
    }
    resize(cols, rows) {
      this.cols = cols
      this.rows = rows
      this.resizes.push(`${cols}x${rows}`)
    }
    loadAddon() {}
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
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
      return { cols: Math.floor(room.w / 9), rows: Math.floor(room.h / 18) }
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

describe('a terminal while a sidebar edge is dragged', () => {
  let wrapper, host, previousApi, observers, screens, idle
  beforeEach(() => {
    // On screen or not (a hidden project is moved off screen): its
    // IntersectionObserver says so. Idle callbacks run by hand.
    screens = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb) {
          screens.push(cb)
        }
        observe() {}
        disconnect() {}
      }
    )
    idle = []
    vi.stubGlobal('requestIdleCallback', (cb) => idle.push(cb))
    vi.stubGlobal('cancelIdleCallback', (n) => (idle[n - 1] = null))
    resetSettings()
    _resetLayoutDragForTests()
    settings.gpuRendering = false
    previousApi = window.shellApi
    observers = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb) {
          this.cb = cb
          observers.push(this)
        }
        observe() {}
        disconnect() {}
      }
    )
    window.shellApi = {
      resizePty: vi.fn(),
      writePty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      attachPty: vi.fn(async () => ({ ok: true, buffer: '' })),
      agentModel: vi.fn(async () => null)
    }
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    wrapper?.unmount()
    host.remove()
    resetSettings()
    _resetLayoutDragForTests()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
    made.length = 0
  })

  async function show() {
    room.w = 900
    room.h = 540
    const ctx = {
      activeId: ref('p1'),
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
    const node = reactive({ id: 'pane-p1', type: 'leaf', kind: 'shell', title: 'PowerShell', attached: true })
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await flushPromises()
    await wait(SETTLED)
    window.shellApi.resizePty.mockClear()
    return made.at(-1)
  }
  // The pane's box takes a new size: its ResizeObserver and the layout
  // event say so (what a sidebar's edge moving does).
  function boxBecomes(w) {
    room.w = w
    for (const o of observers) o.cb([])
    window.dispatchEvent(new Event('terminal-layout-change'))
  }

  it('keeps its grid and its PTY size during the drag, pauses included, and fits once when it ends', async () => {
    const term = await show()
    expect(`${term.cols}x${term.rows}`).toBe('100x30')
    term.resizes.length = 0
    const end = beginLayoutDrag()
    expect(layoutDragging()).toBe(true)
    // The hand moves, stops longer than the settle delay, moves on.
    boxBecomes(810)
    await wait(SETTLED)
    boxBecomes(720)
    await wait(SETTLED * 2)
    boxBecomes(765)
    await wait(SETTLED)
    expect(term.resizes).toEqual([])
    expect(window.shellApi.resizePty).not.toHaveBeenCalled()
    // Let go: one fit, at the size it ended at, and the PTY told once.
    end()
    expect(layoutDragging()).toBe(false)
    await wait(SETTLED)
    expect(term.resizes).toEqual(['85x30'])
    expect(window.shellApi.resizePty).toHaveBeenCalledTimes(1)
    expect(window.shellApi.resizePty).toHaveBeenCalledWith('pane-p1', 85, 30)
  })

  it('out of sight (a hidden project), it fits when the window has a moment', async () => {
    const term = await show()
    term.resizes.length = 0
    for (const cb of screens) cb([{ isIntersecting: false }])
    const end = beginLayoutDrag()
    boxBecomes(720)
    end()
    await wait(SETTLED)
    expect(term.resizes).toEqual([])
    expect(idle.filter(Boolean)).toHaveLength(1)
    idle.filter(Boolean)[0]()
    expect(term.resizes).toEqual(['80x30'])
    expect(window.shellApi.resizePty).toHaveBeenCalledWith('pane-p1', 80, 30)
  })

  it('any other resize (a divider, the window) still fits once it settles', async () => {
    const term = await show()
    term.resizes.length = 0
    boxBecomes(720)
    await wait(SETTLED)
    expect(term.resizes).toEqual(['80x30'])
    expect(window.shellApi.resizePty).toHaveBeenCalledWith('pane-p1', 80, 30)
  })
})
