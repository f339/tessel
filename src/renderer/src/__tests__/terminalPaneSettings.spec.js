// Settings that act on a terminal pane (Orca's): xterm options at creation
// and live, GPU Acceleration, OSC 52, Trim Gutter on Copy, the bell, Focus
// Follows Mouse and Hide Mouse While Typing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { settings, resetSettings } from '../settings'
import { MAX_WEBGL, claimWebgl, releaseWebgl, _webglHoldersForTests, _resetWebglForTests } from '../terminalWebgl'

const fx = vi.hoisted(() => ({ terminals: [], webgl: [] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = { ...options }
      this.rows = 24
      this.cols = 80
      this.osc = {}
      this.selection = ''
      this.parser = {
        registerOscHandler: (n, fn) => {
          this.osc[n] = fn
        },
        registerCsiHandler() {}
      }
      this.buffer = { active: { baseY: 0, viewportY: 0, cursorY: 0, cursorX: 0, length: 1, getLine: () => null } }
      this.addons = []
      fx.terminals.push(this)
    }
    write(_d, cb) {
      cb && cb()
    }
    open(host) {
      this.element = document.createElement('div')
      this.textarea = document.createElement('textarea')
      this.element.append(this.textarea)
      host.append(this.element)
    }
    loadAddon(a) {
      this.addons.push(a)
    }
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
    onData(fn) {
      this.dataFn = fn
    }
    onResize() {}
    onSelectionChange() {}
    onBell(fn) {
      this.bellFn = fn
    }
    attachCustomKeyEventHandler(fn) {
      this.keyFn = fn
    }
    getSelection() {
      return this.selection
    }
    hasSelection() {
      return !!this.selection
    }
    clearSelection() {}
    focus() {}
    dispose() {}
    scrollToBottom() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
    fit() {}
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      this.disposed = false
      fx.webgl.push(this)
    }
    onContextLoss() {}
    dispose() {
      this.disposed = true
    }
  }
}))
import TerminalPane from '../components/TerminalPane.vue'

describe('TerminalPane and the terminal settings', () => {
  let wrapper, ctx, previousApi
  const term = () => fx.terminals[fx.terminals.length - 1]

  function mountPane() {
    wrapper = mount(TerminalPane, {
      props: { node: { id: 'p1', kind: 'shell', type: 'leaf', title: 'PowerShell', shellId: 'pwsh' } },
      global: { provide: { panelCtx: ctx } },
      attachTo: document.body
    })
  }

  beforeEach(() => {
    fx.terminals.length = 0
    fx.webgl.length = 0
    _resetWebglForTests()
    resetSettings()
    previousApi = window.shellApi
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    window.shellApi = {
      resizePty: vi.fn(),
      writePty: vi.fn(),
      writeClipboard: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {}
    }
    ctx = {
      activeId: ref('elsewhere'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref(''),
      voiceLanguages: ref([]),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      terminalBell: vi.fn(),
      teamById: () => null,
      trackOf: () => null,
      setActive: vi.fn(),
      routeInput: vi.fn(),
      toast: vi.fn()
    }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    _resetWebglForTests()
    resetSettings()
    window.shellApi = previousApi
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("creates xterm with Orca's typography, scroll speed and automatic contrast", () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    expect(term().options).toMatchObject({
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1,
      scrollSensitivity: 1.15,
      fastScrollSensitivity: 5,
      minimumContrastRatio: 3
    })
  })

  it('applies changes to an open pane', async () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    settings.fontWeight = 300
    settings.lineHeight = 1.5
    settings.minimumContrastRatio = 1
    settings.wordSeparator = ' '
    settings.scrollSensitivity = 2
    settings.cursorOpacity = 0.5
    await nextTick()
    expect(term().options).toMatchObject({
      fontWeight: 300,
      lineHeight: 1.5,
      minimumContrastRatio: 1,
      wordSeparator: ' ',
      scrollSensitivity: 2
    })
    expect(String(term().options.theme.cursor)).toMatch(/^rgba\(.*0\.5\)$/)
  })

  it('GPU Acceleration On loads WebGL, Off removes it live', async () => {
    settings.gpuAcceleration = 'on'
    mountPane()
    expect(fx.webgl).toHaveLength(1)
    expect(term().addons).toContain(fx.webgl[0])
    settings.gpuAcceleration = 'off'
    await nextTick()
    expect(fx.webgl[0].disposed).toBe(true)
    settings.gpuAcceleration = 'on'
    await nextTick()
    expect(fx.webgl).toHaveLength(2)
  })

  it('an off-screen pane gives its WebGL context back after 30 s, and gets one again when shown', async () => {
    const observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb) {
          this.cb = cb
          observers.push(this)
        }
        observe() {}
        disconnect() {}
      }
    )
    vi.useFakeTimers()
    try {
      settings.gpuAcceleration = 'on'
      mountPane()
      const see = (isIntersecting) => observers[observers.length - 1].cb([{ isIntersecting }])
      // None before the observer's first answer: on screen.
      expect(fx.webgl).toHaveLength(0)
      see(true)
      expect(fx.webgl).toHaveLength(1)
      see(false) // its workspace hidden
      vi.advanceTimersByTime(29000)
      expect(fx.webgl[0].disposed).toBe(false)
      see(true) // shown again before: kept
      see(false)
      vi.advanceTimersByTime(29000)
      expect(fx.webgl[0].disposed).toBe(false)
      vi.advanceTimersByTime(1000)
      expect(fx.webgl[0].disposed).toBe(true)
      see(true)
      expect(fx.webgl).toHaveLength(2)
      expect(fx.webgl[1].disposed).toBe(false)

      // Off screen only because the window is minimized: kept.
      document.documentElement.classList.add('window-hidden')
      see(false)
      vi.advanceTimersByTime(60000)
      expect(fx.webgl[1].disposed).toBe(false)
    } finally {
      document.documentElement.classList.remove('window-hidden')
      vi.useRealTimers()
    }
  })

  describe("WebGL at start and within the window's places", () => {
    let observers
    const see = (isIntersecting) => observers[observers.length - 1].cb([{ isIntersecting }])
    beforeEach(() => {
      observers = []
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb) {
            this.cb = cb
            observers.push(this)
          }
          observe() {}
          disconnect() {}
        }
      )
      settings.gpuAcceleration = 'on'
    })

    it('a pane opened out of sight (a hidden project, a layout being restored) takes no WebGL context until shown', () => {
      mountPane()
      see(false)
      expect(fx.webgl).toHaveLength(0)
      expect(_webglHoldersForTests().holders).toBe(0)
      see(true)
      expect(fx.webgl).toHaveLength(1)
      expect(term().addons).toContain(fx.webgl[0])
      expect(_webglHoldersForTests().holders).toBe(1)
    })

    it('every place taken by panes on screen: the normal renderer, then WebGL once a place frees', async () => {
      const others = Array.from({ length: MAX_WEBGL }, () => ({ onScreen: () => true, release() {}, retry() {} }))
      for (const o of others) claimWebgl(o)
      mountPane()
      see(true)
      expect(fx.webgl).toHaveLength(0)
      releaseWebgl(others[0])
      await Promise.resolve()
      expect(fx.webgl).toHaveLength(1)
      expect(_webglHoldersForTests()).toEqual({ holders: MAX_WEBGL, waiting: 0 })
    })

    it('a pane coming on screen takes the place of one out of sight at once', () => {
      const others = Array.from({ length: MAX_WEBGL - 1 }, () => ({ onScreen: () => true, release() {}, retry() {} }))
      for (const o of others) claimWebgl(o)
      mountPane()
      see(true)
      expect(fx.webgl).toHaveLength(1)
      see(false) // its project hidden: its context is kept for 30 s...
      const newcomer = { onScreen: () => true, release: vi.fn(), retry() {} }
      expect(claimWebgl(newcomer)).toBe(true) // ...unless a pane on screen needs it
      expect(fx.webgl[0].disposed).toBe(true)
      see(true)
      expect(fx.webgl).toHaveLength(1) // every place taken by panes on screen now
      expect(_webglHoldersForTests().waiting).toBe(1)
    })

    it('a lost context: the normal renderer at once (never the white canvas while xterm waits 3 s), WebGL again when shown next', () => {
      vi.useFakeTimers()
      try {
        mountPane()
        see(true)
        expect(fx.webgl).toHaveLength(1)
        term().textarea.dispatchEvent(new Event('webglcontextlost'))
        expect(_webglHoldersForTests().holders).toBe(0)
        vi.advanceTimersByTime(0)
        expect(fx.webgl[0].disposed).toBe(true)
        see(false)
        see(true)
        expect(fx.webgl).toHaveLength(2)
        expect(fx.webgl[1].disposed).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a closed pane gives its place back', () => {
      mountPane()
      see(true)
      expect(_webglHoldersForTests().holders).toBe(1)
      wrapper.unmount()
      wrapper = null
      expect(_webglHoldersForTests().holders).toBe(0)
    })
  })

  it('OSC 52 copies only while allowed', () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    const payload = `c;${btoa('hello')}`
    term().osc[52](payload)
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('hello')
    window.shellApi.writeClipboard.mockClear()
    settings.allowOsc52Clipboard = false
    expect(term().osc[52](payload)).toBe(true)
    expect(window.shellApi.writeClipboard).not.toHaveBeenCalled()
  })

  it('Trim Gutter on Copy: Ctrl+Shift+C copies without the shared indent', () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    term().selection = '  one\n    two'
    const key = { type: 'keydown', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'C' }
    term().keyFn(key)
    expect(window.shellApi.writeClipboard).toHaveBeenLastCalledWith('one\n  two')
    settings.copyTrimsGutter = false
    term().keyFn(key)
    expect(window.shellApi.writeClipboard).toHaveBeenLastCalledWith('  one\n    two')
  })

  it('a bell is reported to the app', () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    term().bellFn()
    expect(ctx.terminalBell).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), { visible: false })
  })

  it('Focus Follows Mouse: hovering the pane activates it only when on', async () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    await wrapper.get('.pane').trigger('mouseenter')
    expect(ctx.setActive).not.toHaveBeenCalled()
    settings.focusFollowsMouse = true
    await wrapper.get('.pane').trigger('mouseenter', { buttons: 1 })
    expect(ctx.setActive).not.toHaveBeenCalled()
    await wrapper.get('.pane').trigger('mouseenter')
    expect(ctx.setActive).toHaveBeenCalledWith('p1')
  })

  it('Hide Mouse While Typing hides the pointer until the mouse moves', async () => {
    settings.gpuAcceleration = 'off'
    mountPane()
    const host = wrapper.get('.term-host').element
    term().dataFn('a')
    expect(host.classList.contains('mouse-hidden')).toBe(false)
    settings.hideMouseWhileTyping = true
    term().dataFn('a')
    expect(host.classList.contains('mouse-hidden')).toBe(true)
    host.dispatchEvent(new MouseEvent('mousemove'))
    expect(host.classList.contains('mouse-hidden')).toBe(false)
  })
})
