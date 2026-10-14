// A Live Share pane (the host's terminal, shown on a guest's screen) keeps
// the host's columns and rows, and its text is sized so they fill the pane
// here (TerminalPane.vue fitLiveShareFont): never cut, no empty band.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'

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
      this.buffer = { active: { baseY: 0, viewportY: 0, length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '' }) } }
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
    onWriteParsed() {}
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

  it('a pane too small even at 6 px: drawn smaller still, never cut', async () => {
    const term = await show(360, 240)
    expect(term.options.fontSize).toBe(6)
    const scale = Number(/scale\(([\d.]+)\)/.exec(term.element.style.transform)[1])
    expect(scale).toBeLessThan(1)
    // 120 columns of 3.6 px, scaled, fit in 360 px.
    expect(120 * 3.6 * scale).toBeLessThanOrEqual(360)
    expect(term.element.style.transformOrigin).toBe('0 0')
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
