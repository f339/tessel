// The agents whose model and effort the main process now reads from their own
// files (agentModelSources.js: Kimi, Gemini, Qwen, Pi, OMP, Droid, OpenCode,
// Kilo, OpenClaw, Continue, Cline's and Copilot's efforts...): what it reads
// shows in the pane's header, goes to the team roster (paneModels) and into the
// sender identity recorded with the team messages the pane sends; a change in
// the agent (a watched file, a /model) shows at its next check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { resetModelListsForTests } from '../agentModels'
import { paneModels } from '../paneModels'
import { buildSenderSnapshot, senderSummary, senderTag } from '../senderIdentity'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 6
      this.cols = 140
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      const line = () => ({ isWrapped: false, translateToString: () => '' })
      this.buffer = { active: { baseY: 0, viewportY: 0, get length() { return 6 }, getLine: (y) => (y >= 0 && y < 6 ? line(y) : undefined) } }
    }
    write() {}
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
    getSelection() {
      return ''
    }
    focus() {}
    dispose() {}
    scrollToBottom() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return { cols: 140, rows: 6 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

describe('the other agents: detected model and effort, everywhere a pane is named', () => {
  let wrapper, host, previousApi, modelChanged
  const node = (agentId, more = {}) => ({ id: `${agentId}1`, num: 4, kind: 'agent', type: 'leaf', title: 'Hopper', paneName: 'Hopper', agentId, agentCommand: agentId, team: 't1', ...more })
  const ctx = () => ({
    activeId: ref('x'),
    broadcast: ref(false),
    maximizedId: ref(null),
    highlightId: ref(null),
    voiceName: ref(''),
    voiceLabel: ref(''),
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
    closeLeaf: vi.fn()
  })
  const mountPane = (agentModel, n) => {
    window.shellApi = {
      resizePty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      agentModel: vi.fn(agentModel),
      onAgentModelChanged: (cb) => {
        modelChanged = cb
        return () => {}
      }
    }
    host = document.createElement('div')
    document.body.append(host)
    wrapper = mount(TerminalPane, { props: { node: n }, attachTo: host, global: { provide: { panelCtx: ctx() } } })
    return n
  }
  const header = () => wrapper.get('[data-test="pane-header"]').text()

  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    resetModelListsForTests()
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    if (host) host.remove()
    wrapper = null
    resetModelListsForTests()
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  // [agent, what main reads, the header's text]
  const CASES = [
    // Kimi's alias, as its model list names it.
    ['kimi', { model: 'kimi-code/kimi-for-coding', effort: 'high', source: 'session' }, 'Kimi K2.6 · High'],
    // Kimi's own display name (its config.toml) beats the list's.
    ['kimi', { model: 'kimi-code/kimi-k2-turbo', name: 'Kimi K2 Turbo', effort: 'none', source: 'session' }, 'Kimi K2 Turbo · None'],
    ['gemini', { model: 'gemini-3-pro-preview', effort: null, source: 'session' }, 'Gemini 3 Pro Preview'],
    ['qwen', { model: 'qwen3-coder-plus', effort: null, source: 'session' }, 'qwen3-coder-plus'],
    ['pi', { model: 'openai-codex/gpt-5.4', effort: 'low', source: 'session' }, 'GPT-5.4 · Low'],
    ['omp', { model: 'anthropic/claude-opus-5-5', effort: 'xhigh', source: 'session' }, 'Opus 5.5 · Extra high'],
    ['droid', { model: 'gpt-5.1-codex', effort: 'high', source: 'session' }, 'GPT-5.1 Codex · High'],
    ['opencode', { model: 'opencode/big-pickle', effort: 'max', source: 'session' }, 'big-pickle · Max'],
    ['kilo', { model: 'kilo/moonshotai/kimi-k3', effort: 'max', source: 'session' }, 'kimi-k3 · Max'],
    ['openclaw', { model: 'openai-codex/gpt-5.4', effort: 'low', source: 'session' }, 'GPT-5.4 · Low'],
    ['continue', { model: 'claude-opus-4-6', name: 'Claude Opus 4.6', effort: null, source: 'settings' }, 'Claude Opus 4.6'],
    ['cline', { model: 'cline-free/deepseek-v4.1-flash', effort: 'medium', source: 'session' }, 'deepseek-v4.1-flash · Medium'],
    ['copilot', { model: 'gpt-6-luna', effort: 'medium', source: 'session' }, 'GPT-6 Luna · Medium']
  ]

  for (const [agentId, read, shown] of CASES) {
    it(`${agentId}: "${shown}" in the header, the team roster and its team messages' sender identity`, async () => {
      const n = mountPane(async () => read, node(agentId, { sessionId: 'sess_0a1b2c3d4e' }))
      await flushPromises()
      expect(window.shellApi.agentModel).toHaveBeenCalledWith(expect.objectContaining({ agentId, sessionId: 'sess_0a1b2c3d4e' }))
      expect(header()).toContain(shown)
      expect(paneModels[n.id]).toBe(shown)
      // App.vue's senderSnapshotOf: the header's text, from paneModels.
      const sender = buildSenderSnapshot(n, { agentName: agentId, model: paneModels[n.id] || '', teamId: 't1' })
      expect(sender).toMatchObject({ agentId, model: shown })
      // What the receiving agent reads: "[Hopper (kimi · Kimi K2.6 High) → you]".
      expect(senderTag(sender)).toBe(`Hopper · ${agentId} · ${shown.replace(' · ', ' ')}`)
      expect(senderSummary(sender)).toContain(shown.replace(' · ', ' '))
    })
  }

  it('a change in the agent (a watched file, a /model, an /effort) shows at its next check', async () => {
    let answer = { model: 'kimi-code/kimi-for-coding', effort: 'high', source: 'session' }
    const n = mountPane(async () => answer, node('kimi', { sessionId: 'sess_0a1b2c3d4e' }))
    await flushPromises()
    expect(header()).toContain('Kimi K2.6 · High')
    answer = { model: 'kimi-code/kimi-for-coding', effort: 'max', source: 'session' }
    modelChanged('kimi')
    await flushPromises()
    expect(header()).toContain('Kimi K2.6 · Max')
    expect(buildSenderSnapshot(n, { agentName: 'Kimi Code', model: paneModels[n.id] || '' }).model).toBe('Kimi K2.6 · Max')
    // Another agent's change is not this pane's.
    answer = { model: 'other', effort: null, source: 'session' }
    modelChanged('gemini')
    await flushPromises()
    expect(header()).toContain('Kimi K2.6 · Max')
  })
})
