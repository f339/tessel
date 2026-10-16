// A Muse Code pane: the model and effort the main process reads (its session
// log, its flags, its settings) show in the pane's header, go to the team
// roster (paneModels) and into the sender identity recorded with the team
// messages it sends; a /models or /effort (a new record in its log, which
// Tessel watches) shows at the pane's next check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { resetModelListsForTests } from '../agentModels'
import { paneModels } from '../paneModels'
import { buildSenderSnapshot, senderSummary, senderDetails } from '../senderIdentity'

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

describe('a Muse Code pane: detected model and effort', () => {
  let wrapper, host, previousApi, modelChanged
  const node = () => ({ id: 'muse1', num: 3, kind: 'agent', type: 'leaf', title: 'Meitner', paneName: 'Meitner', agentId: 'muse', agentCommand: 'muse --trust-workspace', sessionId: '019a1b2c-3d4e-7f80-9123-456789abcdef', team: 't1' })
  const ctx = () => ({
    activeId: ref('muse1'),
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

  it('its session’s model and effort: the header, the team roster and the sender identity of its team messages', async () => {
    const n = mountPane(async () => ({ model: 'muse-spark-1.3', effort: 'high', source: 'session' }))
    await flushPromises()
    expect(window.shellApi.agentModel).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'muse', sessionId: n.sessionId }))
    expect(wrapper.get('[data-test="pane-header"]').text()).toContain('Muse Spark 1.3 · High')
    expect(paneModels.muse1).toBe('Muse Spark 1.3 · High')
    // App.vue's senderSnapshotOf: the header's text, from paneModels.
    const sender = buildSenderSnapshot(n, { agentName: 'Muse', model: paneModels[n.id] || '', teamId: 't1' })
    expect(sender).toMatchObject({ agentId: 'muse', agentName: 'Muse', model: 'Muse Spark 1.3 · High', sessionId: n.sessionId })
    expect(senderSummary(sender)).toContain('Meitner · Muse · Muse Spark 1.3 High')
    expect(senderDetails(sender)).toContain('Muse Spark 1.3 · High')
  })

  it('a /models and an /effort in the session show at its next check', async () => {
    let answer = { model: 'muse-spark-1.3', effort: 'high', source: 'session' }
    const n = mountPane(async () => answer)
    await flushPromises()
    answer = { model: 'muse-spark-1.3-contributor', effort: 'ultra', source: 'session' }
    modelChanged('muse')
    await flushPromises()
    expect(wrapper.get('[data-test="pane-header"]').text()).toContain('Muse Spark 1.3 Contributor · Ultra')
    const sender = buildSenderSnapshot(n, { agentName: 'Muse', model: paneModels[n.id] || '' })
    expect(sender.model).toBe('Muse Spark 1.3 Contributor · Ultra')
  })
})
