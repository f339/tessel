// An Antigravity CLI (agy) pane: the model and effort Tessel detects (its
// footer, else what the main process reads) show in the pane's header, go to
// the team roster (paneModels) and into the sender identity recorded with the
// team messages it sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { modelLists, resetModelListsForTests } from '../agentModels'
import { parseAntigravityModelList } from '../../../shared/agentModelProbe'
import { paneModels } from '../paneModels'
import { buildSenderSnapshot, senderSummary } from '../senderIdentity'

// What the pane's terminal shows, bottom line last.
let screen = []
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 6
      this.cols = 140
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      const line = (y) => ({ isWrapped: false, translateToString: () => screen[y] || '' })
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

const AGY_MODELS = parseAntigravityModelList(
  [
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-argon-low\tGemini 4 Argon (Low)',
    'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)'
  ].join('\n')
)
const footer = (right) => ['', '────────', '>', '────────', `? for shortcuts${' '.repeat(80)}${right}`, '']

describe('an Antigravity CLI pane: detected model and effort', () => {
  let wrapper, host, previousApi
  const node = () => ({ id: 'agy1', num: 2, kind: 'agent', type: 'leaf', title: 'Dalton', paneName: 'Dalton', agentId: 'antigravity', sessionId: '89cec4e6-00f8-47a4-b013-796a12edd5e4', team: 't1' })
  const ctx = () => ({
    activeId: ref('agy1'),
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
  let modelChanged = null
  const mountPane = (agentModel, n = node()) => {
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
  // agy saved the change in its settings.json: Tessel's watcher tells the
  // Antigravity panes, which check their model again.
  const refresh = async () => {
    modelChanged('antigravity')
    await flushPromises()
  }

  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    resetModelListsForTests()
    modelLists.antigravity = { models: AGY_MODELS, fetchedAt: Date.now() }
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    screen = []
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

  it('what the main process reads (a variant id) shows as the list names it, and reaches the sender identity', async () => {
    const n = mountPane(async () => ({ model: 'gemini-4-argon-low', effort: 'low', source: 'command' }))
    await flushPromises()
    expect(window.shellApi.agentModel).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'antigravity', sessionId: n.sessionId }))
    expect(wrapper.get('[data-test="pane-header"]').text()).toContain('Gemini 4 Argon · Low')
    expect(paneModels.agy1).toBe('Gemini 4 Argon · Low')
    // App.vue's senderSnapshotOf: the header's text, from paneModels.
    const sender = buildSenderSnapshot(n, { agentName: 'Antigravity', model: paneModels[n.id] || n.headerModel || '', teamId: 't1' })
    expect(sender).toMatchObject({ agentId: 'antigravity', model: 'Gemini 4 Argon · Low', sessionId: n.sessionId })
    // The one-line summary of team messages ("Dalton · Antigravity · Gemini 4 Argon Low · local").
    expect(senderSummary(sender)).toContain('Gemini 4 Argon Low')
  })

  it("agy's footer wins: a /model or /effort in the pane shows at its next check, in the header and the sender identity", async () => {
    const n = mountPane(async () => ({ model: 'Gemini 4 Argon (High)', name: 'Gemini 4 Argon', effort: 'high', source: 'settings' }))
    await flushPromises()
    expect(paneModels.agy1).toBe('Gemini 4 Argon · High')
    // The user ran /model claude-opus-5-5 then /effort low in agy.
    screen = footer('Claude Opus 5.5 · low')
    await refresh()
    expect(wrapper.get('[data-test="pane-header"]').text()).toContain('Claude Opus 5.5 · Low')
    expect(paneModels.agy1).toBe('Claude Opus 5.5 · Low')
    const sender = buildSenderSnapshot(n, { agentName: 'Antigravity', model: paneModels[n.id] || '', teamId: 't1' })
    expect(sender.model).toBe('Claude Opus 5.5 · Low')
  })
})
