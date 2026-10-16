// A pane whose terminal ended before the pane was there: at startup its
// re-attach is asked ahead (restoreAttach.js), so its end can come before its
// pane is rebuilt or mounted. The end is kept from the start by process id
// (ptyStore.js) and the pane shows it as ended when it mounts; another
// process of the same pane (restarted in place) is not taken for it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { dropBuffer, exitOf, startCapture } from '../ptyStore'

const fixture = vi.hoisted(() => ({ terminals: [] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorY: 0,
          cursorX: 0,
          length: 24,
          getLine: () => ({ isWrapped: false, translateToString: () => '', getCell: () => ({ getChars: () => '', isDim: () => false }) })
        }
      }
      this.written = []
      fixture.terminals.push(this)
    }
    write(data, callback) {
      this.written.push(data)
      callback?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      host.append(this.textarea)
    }
    loadAddon() {}
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
    onData() {}
    onResize() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
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
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

// The window's own capture (main.js startCapture), heard from the start.
const heard = { exit: null }
beforeAll(() => {
  window.shellApi = { onData: () => () => {}, onExit: (fn) => ((heard.exit = fn), () => {}) }
  startCapture()
})

describe('the end of a terminal kept from the start (ptyStore.js)', () => {
  it('is that process’s only, and goes with the pane', () => {
    heard.exit({ id: 'pane-k1', exitCode: 2, signal: 0, pid: 11 })
    expect(exitOf('pane-k1', 11)).toEqual({ exitCode: 2 })
    // Restarted in place (another process): not its end.
    expect(exitOf('pane-k1', 12)).toBeNull()
    expect(exitOf('pane-k1', null)).toBeNull()
    expect(exitOf('pane-other', 11)).toBeNull()
    dropBuffer('pane-k1')
    expect(exitOf('pane-k1', 11)).toBeNull()
  })

  it('a terminal with no process id (on an SSH host): an end heard after its answer came', () => {
    const before = performance.now()
    heard.exit({ id: 'pane-ssh', exitCode: 255, signal: 0, pid: null })
    const after = performance.now() + 1
    expect(exitOf('pane-ssh', null, before)).toEqual({ exitCode: 255 })
    // Heard before its answer: an older terminal's.
    expect(exitOf('pane-ssh', null, after)).toBeNull()
    // No answer time: never taken.
    expect(exitOf('pane-ssh', null)).toBeNull()
    // A pane with a process id is never matched by an end without one.
    expect(exitOf('pane-ssh', 9, before)).toBeNull()
  })
})

describe('a pane mounted after its terminal ended', () => {
  let wrapper, ctx, saved
  const mountPane = (node) => {
    wrapper = mount(TerminalPane, {
      props: { node: { type: 'leaf', kind: 'shell', title: 'PowerShell', ...node } },
      global: { provide: { panelCtx: ctx } }
    })
    return fixture.terminals[fixture.terminals.length - 1]
  }
  beforeEach(() => {
    saved = window.shellApi
    fixture.terminals.length = 0
    resetSettings()
    settings.gpuAcceleration = 'off'
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    window.shellApi = { resizePty: vi.fn(), onData: () => () => {}, onExit: () => () => {} }
    ctx = {
      activeId: ref('elsewhere'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref(''),
      voiceLanguages: ref([]),
      teamById: () => null,
      trackOf: () => null,
      setActive: vi.fn(),
      routeInput: vi.fn(),
      closeLeaf: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    window.shellApi = saved
    vi.unstubAllGlobals()
  })

  it('shows it ended, with its code', () => {
    heard.exit({ id: 'pane-e1', exitCode: 3, signal: 0, pid: 42 })
    const term = mountPane({ id: 'pane-e1', pid: 42 })
    expect(term.written.join('')).toContain('process exited with code 3')
  })

  it('a pane over ssh2 (no process id) whose terminal ended since its answer', () => {
    const answeredAt = performance.now()
    heard.exit({ id: 'pane-e4', exitCode: 255, signal: 0, pid: null })
    const term = mountPane({ id: 'pane-e4', pid: null, answeredAt })
    expect(term.written.join('')).toContain('process exited with code 255')
  })

  it('a pane restarted in place (another process) is not taken for ended', () => {
    heard.exit({ id: 'pane-e2', exitCode: 1, signal: 0, pid: 50 })
    const term = mountPane({ id: 'pane-e2', pid: 51 })
    expect(term.written.join('')).not.toContain('process exited')
  })

  it('a pane put to sleep is not shown as ended', () => {
    heard.exit({ id: 'pane-e3', exitCode: 0, signal: 0, pid: 60 })
    const term = mountPane({ id: 'pane-e3', pid: 60, sleeping: { at: 1 } })
    expect(term ? term.written.join('') : '').not.toContain('process exited')
  })
})
