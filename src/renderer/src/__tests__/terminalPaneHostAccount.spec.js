// An agent pane on an SSH host shows the account the agent there is signed
// in with (header chip, pane menu), and its menu offers the host's other
// accounts and a sign-in to another one (TerminalPane, PaneActionsMenu).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
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

  it('its menu: Check account again, Copy account details, Make this the default; the default marked, and shown in its title', async () => {
    ctx.checkHostAccount = vi.fn()
    ctx.copyAccountDetails = vi.fn()
    ctx.setHostAccountDefault = vi.fn()
    settings.hostAccountDefaults = { 'ssh-dflt': { claude: 'abc123' } }
    remoteHostsState.targets.push({ id: 'ssh-dflt', label: 'dflt-box', host: 'd.example' })
    await mountPane({ id: 'pane-a5', remoteHostId: 'ssh-dflt' })
    const open = async () => {
      await wrapper.get('[data-pane-id="pane-a5"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
      await flushPromises()
    }
    await open()
    // On the host's own sign-in while the default is the folder: Restart on it is marked.
    expect([...document.body.querySelectorAll('[data-test="menu-restart-on-account"]')].map((b) => b.textContent.trim())).toEqual(['Restart on work · Max (default)'])
    document.body.querySelector('[data-test="menu-check-host-account"]').click()
    expect(ctx.checkHostAccount).toHaveBeenCalledWith('pane-a5')
    await open()
    document.body.querySelector('[data-test="menu-copy-account-details"]').click()
    expect(ctx.copyAccountDetails).toHaveBeenCalledWith('pane-a5')
    await open()
    document.body.querySelector('[data-test="menu-host-default"]').click()
    expect(ctx.setHostAccountDefault).toHaveBeenCalledWith('pane-a5')
    wrapper.unmount()
    // A pane on the default folder: "Default on this host" in its title, no Make default.
    await mountPane({ id: 'pane-a6', remoteHostId: 'ssh-dflt', hostAccount: 'abc123' })
    expect(wrapper.get('[data-test="pane-account-chip"]').attributes('title')).toContain('Default on this host')
    await wrapper.get('[data-pane-id="pane-a6"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await flushPromises()
    expect(document.body.querySelector('[data-test="menu-host-default"]')).toBeNull()
    settings.hostAccountDefaults = {}
  })

  it('its hover card: Check again only (restarting on another account is the menu’s: never one click that stops a busy agent)', async () => {
    ctx.checkHostAccount = vi.fn()
    ctx.restartOnAccount = vi.fn()
    settings.hostAccountDefaults = { 'ssh-acct': { claude: 'abc123' } }
    await mountPane({ id: 'pane-h1' })
    await wrapper.get('[data-test="pane-hover-trigger"]').trigger('pointerover')
    await new Promise((r) => setTimeout(r, 500))
    await flushPromises()
    const card = document.body.querySelector('.pane-hover-card')
    expect(card.querySelector('[data-hover-account]').textContent).toContain('coreine13@gmail.com')
    card.querySelector('[data-test="hover-check-account"]').click()
    expect(ctx.checkHostAccount).toHaveBeenCalledWith('pane-h1')
    expect(card.querySelectorAll('.hc-account-actions button')).toHaveLength(1)
    expect(ctx.restartOnAccount).not.toHaveBeenCalled()
    wrapper.unmount()
    // On the default already: "Default on this host" said.
    await mountPane({ id: 'pane-h2', hostAccount: 'abc123' })
    await wrapper.get('[data-test="pane-hover-trigger"]').trigger('pointerover')
    await new Promise((r) => setTimeout(r, 500))
    await flushPromises()
    const again = [...document.body.querySelectorAll('.pane-hover-card')].at(-1)
    expect(again.querySelector('[data-hover-account-note]').textContent).toBe('Default on this host')
    settings.hostAccountDefaults = {}
  })

  it('its agent runs on another account than the pane’s: the pane asks, Update or Keep (nothing changed until then); a new launch ends the notice', async () => {
    ctx.resolveHostAccountMismatch = vi.fn()
    const node = reactive({ id: 'pane-m1', type: 'leaf', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Archimedes', remoteHostId: 'ssh-acct', sessionId: 's-1', hostAccount: 'abc123', hostAccountMismatch: { runs: null }, launchedAt: 1 })
    wrapper = mount(TerminalPane, { props: { node }, global: { provide: { panelCtx: ctx } }, attachTo: document.body })
    await flushPromises()
    const note = wrapper.get('[data-test="host-account-mismatch"]')
    expect(note.text()).toContain('This pane is running on coreine13 · Pro, not work · Max.')
    expect(node.hostAccount).toBe('abc123')
    await wrapper.get('[data-test="host-account-update"]').trigger('click')
    expect(ctx.resolveHostAccountMismatch).toHaveBeenLastCalledWith('pane-m1', true)
    await wrapper.get('[data-test="host-account-keep"]').trigger('click')
    expect(ctx.resolveHostAccountMismatch).toHaveBeenLastCalledWith('pane-m1', false)
    // A folder the host no longer lists: named as one.
    node.hostAccountMismatch = { runs: 'zzz999' }
    await flushPromises()
    expect(wrapper.get('[data-test="host-account-mismatch"]').text()).toContain('running on another account folder, not work · Max')
    node.launchedAt = 2
    await flushPromises()
    expect(wrapper.find('[data-test="host-account-mismatch"]').exists()).toBe(false)
  })

  it('signed in, its email not known yet: its plan in the header, Check again in its title', async () => {
    detect.mockResolvedValue({ ok: true, entries: [{ agent: 'claude', scope: 'tessel', id: 'bd93c7f5566d', dir: '/home/u/.tessel-server/accounts/claude/bd93c7f5566d', plan: 'max', cred: 'file', state: 'signed-in' }] })
    remoteHostsState.targets.push({ id: 'ssh-unk', label: '192.99.0.20', host: '192.99.0.20' })
    await mountPane({ id: 'pane-a7', remoteHostId: 'ssh-unk', hostAccount: 'bd93c7f5566d' })
    const chip = wrapper.get('[data-test="pane-account-chip"]')
    expect(chip.text()).toBe('Max')
    expect(chip.attributes('title')).toContain('not known yet')
    expect(chip.attributes('title')).toContain('Check account again')
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
