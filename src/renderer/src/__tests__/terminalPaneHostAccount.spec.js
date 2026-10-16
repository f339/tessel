// An agent pane on an SSH host shows the account the agent there is signed
// in with (header chip, pane menu), and its menu offers the host's other
// accounts and a sign-in to another one (TerminalPane, PaneActionsMenu).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { remoteHostsState } from '../remoteHosts'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = { active: { baseY: 0, viewportY: 0, cursorY: 0, cursorX: 0, length: 24, getLine: () => ({ isWrapped: false, translateToString: () => '', getCell: () => ({ getChars: () => '', isDim: () => false }) }) } }
    }
    write(_d, cb) {
      cb?.()
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
    getSelection() {
      return ''
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

const entries = [
  { agent: 'claude', scope: 'default', dir: '/home/u/.claude', email: 'coreine13@gmail.com', org: "coreine13@gmail.com's Organization", plan: 'pro', cred: 'file', state: 'signed-in' },
  { agent: 'claude', scope: 'tessel', id: 'abc123', dir: '/home/u/.tessel-server/accounts/claude/abc123', email: 'work@corp.example', plan: 'max', cred: 'file', state: 'signed-in' }
]

describe('an agent pane on an SSH host: its account', () => {
  let wrapper, ctx, previousApi, detect
  async function mountPane(extra = {}) {
    wrapper = mount(TerminalPane, {
      props: { node: { id: 'pane-a1', type: 'leaf', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Archimedes', remoteHostId: 'ssh-acct', sessionId: 's-1', ...extra } },
      global: { provide: { panelCtx: ctx } },
      attachTo: document.body
    })
    await flushPromises()
    return wrapper
  }
  beforeEach(() => {
    previousApi = window.shellApi
    resetSettings()
    settings.gpuAcceleration = 'off'
    settings.rightClickPaste = false
    remoteHostsState.targets = [{ id: 'ssh-acct', label: 'linux-box', host: 'box.example' }, { id: 'ssh-cx', label: 'codex-box', host: 'cx.example' }]
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    detect = vi.fn(async () => ({ ok: true, entries }))
    window.shellApi = { resizePty: vi.fn(), onData: () => () => {}, onExit: () => () => {}, remoteAccounts: { detect } }
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
      otherPanes: () => [],
      restartOnAccount: vi.fn(),
      signInOnHost: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    remoteHostsState.targets = []
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('reads the host’s accounts and shows the one the agent runs on in its header', async () => {
    await mountPane()
    expect(detect).toHaveBeenCalledWith('ssh-acct', { fresh: false })
    const chip = wrapper.get('[data-test="pane-account-chip"]')
    expect(chip.text()).toBe('coreine13 · Pro')
    expect(chip.attributes('title')).toContain('coreine13@gmail.com · Pro')
    expect(chip.attributes('title')).toContain('linux-box')
  })

  it('on an account folder: that account', async () => {
    await mountPane({ id: 'pane-a2', hostAccount: 'abc123' })
    expect(wrapper.get('[data-test="pane-account-chip"]').text()).toBe('work · Max')
  })

  it('its menu: the account, Restart on the host’s other account, Sign in to another account', async () => {
    await mountPane({ id: 'pane-a3' })
    await wrapper.get('[data-pane-id="pane-a3"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    expect(document.body.querySelector('[data-test="pane-account"]').textContent).toContain('coreine13 · Pro')
    const restart = [...document.body.querySelectorAll('[data-test="menu-restart-on-account"]')]
    expect(restart.map((b) => b.textContent.trim())).toEqual(['Restart on work · Max'])
    restart[0].click()
    expect(ctx.restartOnAccount).toHaveBeenCalledWith('pane-a3', 'abc123')
    await wrapper.get('[data-pane-id="pane-a3"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    const signIn = document.body.querySelector('[data-test="menu-sign-in-on-host"]')
    expect(signIn.textContent.trim()).toBe('Sign in to another account on linux-box…')
    signIn.click()
    expect(ctx.signInOnHost).toHaveBeenCalledWith('pane-a3')
  })

  it('a Codex pane restarts on another account with a new conversation (said in its hint)', async () => {
    detect.mockResolvedValue({ ok: true, entries: [{ agent: 'codex', scope: 'default', dir: '/home/u/.codex', email: 'dev@example.com', plan: 'plus', cred: 'file', state: 'signed-in' }, { agent: 'codex', scope: 'tessel', id: 'def456', dir: '/home/u/.tessel-server/accounts/codex/def456', email: 'two@example.com', cred: 'file', state: 'signed-in' }] })
    // Another host (each host's accounts are read once for all its panes).
    await mountPane({ id: 'pane-a4', agentId: 'codex', agentCommand: 'codex', title: 'Codex', remoteHostId: 'ssh-cx' })
    await wrapper.get('[data-pane-id="pane-a4"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    const restart = document.body.querySelector('[data-test="menu-restart-on-account"]')
    expect(restart.getAttribute('title')).toContain('a new conversation')
  })
})
