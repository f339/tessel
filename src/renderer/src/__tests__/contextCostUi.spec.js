import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SkillTokenTag from '../components/context/SkillTokenTag.vue'
import { ref } from 'vue'
import McpTokenTag from '../components/mcp/McpTokenTag.vue'
import { SETTINGS_SHELL } from '../components/settings/settingsShell'
import SettingsContext from '../components/settings/SettingsContext.vue'
import { tokensText, sourceLabel, reasonText, sourceTitle, compactTokens, contextCounts, forgetMcpCounts } from '../contextCost'
import { settings } from '../settings'

let previousApi
beforeEach(() => {
  previousApi = window.shellApi
  contextCounts.skillsByCwd = {}
  contextCounts.skillsLoading = {}
  contextCounts.mcp = {}
  forgetMcpCounts()
})
afterEach(() => {
  window.shellApi = previousApi
})

const estimate = (tokens, reason, extra = {}) => ({ tokens, exact: false, source: 'estimate', base: 'o200k_base', factor: 1.35, reason, api: 'anthropic', model: 'claude-opus-5-5', ...extra })

describe('how a count reads', () => {
  it('marks estimates with ≈, says where an exact count comes from', () => {
    expect(compactTokens(3214)).toBe('3.2k')
    expect(tokensText({ tokens: 3214, exact: true })).toBe('3.2k tokens')
    expect(tokensText(estimate(3214, 'offline'))).toBe('≈ 3.2k tokens')
    expect(sourceLabel({ tokens: 1, exact: true, source: 'api', api: 'anthropic' })).toBe('exact · Anthropic count_tokens')
    expect(sourceLabel({ tokens: 1, exact: true, source: 'local', tokenizer: 'qwen3' })).toBe('exact · Qwen 3')
    expect(sourceLabel(estimate(1, 'offline'))).toBe('estimate')
  })

  it('says why a count is an estimate', () => {
    expect(reasonText(estimate(1, 'offline'))).toBe("couldn't reach Anthropic count_tokens")
    expect(reasonText(estimate(1, 'noKey'))).toContain('Count with my Claude sign-in')
    expect(reasonText(estimate(1, 'noTokenizer', { tokenizer: 'glm5', api: null }))).toBe('download the GLM 5 tokenizer for an exact count')
    expect(reasonText({ tokens: 1, exact: true, source: 'api' })).toBe('')
    expect(sourceTitle(estimate(1000, 'rateLimited'))).toMatch(/^≈ 1,000 tokens, estimate \(o200k_base × 1.35\): Anthropic count_tokens is limiting requests/)
    expect(sourceTitle({ tokens: 1200, exact: true, source: 'local', tokenizer: 'qwen3', template: true, model: 'qwen3-coder' })).toContain("with the model's chat template")
    expect(sourceTitle(estimate(10, 'notCounted', { calibrated: true, factor: 1.42 }))).toContain('calibrated from your own exact counts')
  })
})

describe('SkillTokenTag', () => {
  it('shows the up-front cost of a skill from one read for the whole page', async () => {
    const skills = vi.fn(async () => ({ '/s/pdf/SKILL.md': { agent: 'claude', result: estimate(3214, 'notCounted') } }))
    window.shellApi = { context: { skills } }
    const a = mount(SkillTokenTag, { props: { skill: { skillFile: '/s/pdf/SKILL.md' }, cwd: '/p' } })
    const b = mount(SkillTokenTag, { props: { skill: { copies: [{ skillFile: '/s/pdf/SKILL.md' }] }, cwd: '/p' } })
    await flushPromises()
    expect(a.text()).toBe('≈ 3.2k tokens')
    expect(b.text()).toBe('≈ 3.2k tokens')
    expect(skills).toHaveBeenCalledTimes(1)
    expect(skills.mock.calls[0][0]).toMatchObject({ cwd: '/p', remote: true, claudeSignIn: false })
    a.unmount()
    b.unmount()
  })

  it('shows, per agent, the cost up front and when used', async () => {
    const skillDetail = vi.fn(async () => ({
      rows: [{ agent: 'codex', upfront: { tokens: 40, exact: true, source: 'local', tokenizer: 'o200k_base' }, full: { tokens: 1800, exact: true, source: 'local', tokenizer: 'o200k_base' } }]
    }))
    window.shellApi = { context: { skillDetail } }
    const w = mount(SkillTokenTag, { props: { skill: { skillFile: '/s/lint/SKILL.md' }, detailed: true } })
    await flushPromises()
    expect(w.text()).toContain('Codex')
    expect(w.text()).toContain('Up front 40 tokens')
    expect(w.text()).toContain('When used 1.8k tokens')
    expect(w.text()).toContain('exact · o200k_base')
    w.unmount()
  })
})

describe('McpTokenTag', () => {
  it('in a row: a read-only tag from one request for every row, nothing clickable', async () => {
    const mcpMeasures = vi.fn(async () => ({ 'claude:user:fs': { tools: 14, result: { tokens: 8600, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' } } }))
    const mcpMeasure = vi.fn()
    window.shellApi = { mcpMeasure, context: { mcpMeasures } }
    const a = mount(McpTokenTag, { props: { server: 'fs', agent: 'claude', scope: 'user', cwd: '/p', variant: 'row' } })
    const b = mount(McpTokenTag, { props: { server: 'linear', agent: 'claude', scope: 'user', cwd: '/p', variant: 'row' } })
    await flushPromises()
    expect(mcpMeasures).toHaveBeenCalledTimes(1)
    expect(mcpMeasures.mock.calls[0][0]).toMatchObject({ cwd: '/p', servers: [{ agent: 'claude', scope: 'user', name: 'fs' }, { agent: 'claude', scope: 'user', name: 'linear' }] })
    expect(mcpMeasures.mock.calls[0][0].remote).toBeUndefined()
    expect(a.text()).toBe('8.6k tokens')
    expect(a.find('button').exists()).toBe(false)
    expect(b.text()).toBe('')
    expect(mcpMeasure).not.toHaveBeenCalled()
    a.unmount()
    b.unmount()
  })

  it('in the details: Measure starts the server on the click only', async () => {
    const mcpMeasure = vi.fn(async () => ({ ok: true, tools: 14, at: 1, counter: {}, result: { tokens: 8600, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' } }))
    window.shellApi = { mcpMeasure, context: { mcpMeasures: async () => ({}) } }
    const w = mount(McpTokenTag, { props: { server: 'fs', agent: 'claude', scope: 'user', cwd: '/p', variant: 'details' } })
    await flushPromises()
    expect(mcpMeasure).not.toHaveBeenCalled()
    expect(w.find('button').text()).toBe('Measure')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(mcpMeasure).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude', name: 'fs', scope: 'user', cwd: '/p' }))
    expect(w.text()).toContain('8.6k tokens · 14 tools')
    expect(w.text()).toContain('exact · Anthropic count_tokens')
    expect(w.find('button').text()).toBe('Measure again')
    expect(w.emitted('measured')).toHaveLength(1)
    w.unmount()
  })

  it('shows a kept measurement without starting the server, and a failure', async () => {
    const mcpMeasure = vi.fn(async () => ({ ok: false, error: 'Command not found: npx' }))
    window.shellApi = { mcpMeasure, context: { mcpMeasures: async () => ({ 'codex:user:fs': { tools: 3, result: { tokens: 900, exact: true, source: 'local', tokenizer: 'o200k_base' } } }) } }
    const w = mount(McpTokenTag, { props: { server: 'fs', agent: 'codex', variant: 'details' } })
    await flushPromises()
    expect(w.text()).toContain('900 tokens · 3 tools')
    expect(mcpMeasure).not.toHaveBeenCalled()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Command not found: npx')
    w.unmount()
  })
})

describe('switching projects while a count is on its way', () => {
  const deferred = () => {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
  }

  it('skills: B is asked for and shows B’s counts, whatever A answers later', async () => {
    const a = deferred()
    const skills = vi.fn((q) => (q.cwd === '/A' ? a.promise : Promise.resolve({ '/B/.claude/skills/s/SKILL.md': { agent: 'claude', result: { tokens: 222, exact: true, source: 'local', tokenizer: 'o200k_base' } } })))
    window.shellApi = { context: { skills } }
    const w = mount(SkillTokenTag, { props: { skill: { skillFile: '/A/.claude/skills/s/SKILL.md' }, cwd: '/A' } })
    await flushPromises()
    await w.setProps({ skill: { skillFile: '/B/.claude/skills/s/SKILL.md' }, cwd: '/B' })
    await flushPromises()
    expect(skills.mock.calls.map((c) => c[0].cwd)).toEqual(['/A', '/B'])
    expect(w.text()).toBe('222 tokens')
    a.resolve({ '/B/.claude/skills/s/SKILL.md': { agent: 'claude', result: { tokens: 999, exact: true, source: 'local', tokenizer: 'o200k_base' } } })
    await flushPromises()
    expect(w.text()).toBe('222 tokens') // A's answer stays A's
    w.unmount()
  })

  it('MCP: B’s project server is asked for and shows B’s count, never A’s', async () => {
    const a = deferred()
    const result = (tokens) => ({ 'claude:project:fs': { tools: 1, result: { tokens, exact: true, source: 'local', tokenizer: 'o200k_base' } } })
    const mcpMeasures = vi.fn((q) => (q.cwd === '/A' ? a.promise : Promise.resolve(result(333))))
    window.shellApi = { context: { mcpMeasures } }
    const w = mount(McpTokenTag, { props: { server: 'fs', agent: 'claude', scope: 'project', cwd: '/A', variant: 'row' } })
    await flushPromises()
    await w.setProps({ cwd: '/B' })
    await flushPromises()
    expect(mcpMeasures.mock.calls.map((c) => c[0].cwd)).toEqual(['/A', '/B'])
    expect(w.text()).toBe('333 tokens')
    a.resolve(result(111))
    await flushPromises()
    expect(w.text()).toBe('333 tokens')
    await w.setProps({ cwd: '/A' })
    await flushPromises()
    expect(w.text()).toBe('111 tokens') // A's own, under A
    w.unmount()
  })
})

describe('McpTokenTag: a project server Claude Code was not allowed to start', () => {
  it('asks first, showing its command, and measures only on yes', async () => {
    const mcpMeasure = vi.fn(async (q) => (q.confirmed ? { ok: true, tools: 2, at: 1, result: { tokens: 300, exact: true, source: 'local', tokenizer: 'o200k_base' } } : { ok: false, code: 'needsConfirm', target: 'npx evil-mcp' }))
    window.shellApi = { mcpMeasure, context: { mcpMeasures: async () => ({}) } }
    const answers = [false, true]
    const asked = []
    const askConfirm = (o) => (asked.push(o), Promise.resolve(answers.shift()))
    const w = mount(McpTokenTag, { props: { server: 'evil', scope: 'project', agent: 'claude', variant: 'details' }, global: { provide: { askConfirm } } })
    await flushPromises()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(asked[0].message).toContain('npx evil-mcp')
    expect(mcpMeasure).toHaveBeenCalledTimes(1) // no
    await w.find('button').trigger('click')
    await flushPromises()
    expect(mcpMeasure).toHaveBeenCalledTimes(3)
    expect(mcpMeasure.mock.calls[2][0]).toMatchObject({ name: 'evil', confirmed: true })
    expect(w.text()).toContain('300 tokens · 2 tools')
    w.unmount()
  })
})

// The Settings shell around a page (settingsShell.js), opened on Context.
function shellFor(extra = {}) {
  return { page: ref('context'), searching: ref(false), shown: () => true, go: vi.fn(), emit: vi.fn(), openMcpTab: vi.fn(), mcpTab: ref('installed'), refreshSearch: () => {}, ...extra }
}
const mountPage = (props, shell = shellFor(), provide = {}) => mount(SettingsContext, { props, global: { provide: { [SETTINGS_SHELL]: shell, ...provide } } })

describe('Settings > Context', () => {
  const agentRow = (over = {}) => ({
    id: 'claude',
    model: 'claude-opus-5-5',
    defaulted: false,
    counter: { kind: 'api', api: 'anthropic', model: 'claude-opus-5-5' },
    items: [
      { key: 'r', group: 'rules', type: 'file', label: 'CLAUDE.md', path: 'C:\\Users\\me\\.claude\\CLAUDE.md', scope: 'user', loaded: true, result: { tokens: 3100, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' } },
      { key: 's', group: 'skills', type: 'skill', label: 'pdf', loaded: true, result: { tokens: 45, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' } },
      { key: 'm', group: 'mcp', type: 'mcp', label: 'fs', scope: 'user', loaded: true, note: 'notMeasured', ref: { agent: 'claude', name: 'fs', scope: 'user' }, result: null }
    ],
    summary: { total: 3145, groups: { rules: 3100, skills: 45, mcp: 0, tessel: 0 }, optional: 3145, pending: 1, exact: 'all' },
    ...over
  })

  it('reads the kept counts first, then counts (remote), and shows per agent totals and groups', async () => {
    settings.contextClaudeSignIn = false
    const summary = vi.fn(async (q) => ({ agents: [q.remote ? agentRow() : agentRow({ summary: { ...agentRow().summary, exact: 'none' } })] }))
    window.shellApi = {
      openFile: vi.fn(),
      mcpMeasure: vi.fn(),
      context: { summary, tokenizers: async () => ({ qwen3: { name: 'Qwen 3', bytes: 7 * 1048576, licence: 'Apache-2.0', ready: false } }), downloadTokenizer: vi.fn(async () => ({ ok: true })), mcpMeasures: async () => ({}), retry: vi.fn() }
    }
    const shell = shellFor()
    const w = mountPage({ projectCwd: '/p', agents: [{ id: 'claude', name: 'Claude Code', available: true }, { id: 'zsh', available: true }] }, shell)
    await flushPromises()
    expect(summary).toHaveBeenCalledTimes(2)
    expect(summary.mock.calls[0][0]).toMatchObject({ cwd: '/p', remote: false, agents: [{ id: 'claude' }] })
    expect(summary.mock.calls[1][0]).toMatchObject({ remote: true })
    expect(w.find('[data-test="agent-total"]').text()).toBe('3.1k tokens')
    expect(w.text()).toContain('Claude Code')
    expect(w.text()).toContain('claude-opus-5-5')
    // Opened on the first agent: its groups, items and links.
    expect(w.text()).toContain('Rules and memory files')
    expect(w.text()).toContain('CLAUDE.md')
    expect(w.text()).toContain('Manage skills')
    expect(w.find('[data-test="mcp-token-tag"]').exists()).toBe(true)
    expect(window.shellApi.mcpMeasure).not.toHaveBeenCalled()
    await w.findAll('button').find((b) => b.text() === 'Manage skills').trigger('click')
    expect(shell.go).toHaveBeenCalledWith('skills')
    // The tokenizers: a download is a click.
    expect(w.text()).toContain('Qwen 3')
    expect(w.text()).toContain('7 MB')
    await w.find('[data-tokenizer="qwen3"] button').trigger('click')
    await flushPromises()
    expect(window.shellApi.context.downloadTokenizer).toHaveBeenCalledWith('qwen3')
    w.unmount()
  })

  it('says when counts are estimates and offers Retry and the sign-in switch', async () => {
    const row = agentRow({
      items: [{ key: 'r', group: 'rules', type: 'file', label: 'CLAUDE.md', path: '/x/CLAUDE.md', loaded: true, result: estimate(3100, 'offline') }, { key: 's', group: 'skills', type: 'skill', label: 'pdf', loaded: true, result: estimate(45, 'noKey') }],
      summary: { total: 3145, groups: { rules: 3100, skills: 45, mcp: 0, tessel: 0 }, optional: 3145, pending: 0, exact: 'none' }
    })
    const retry = vi.fn(async () => ({ ok: true }))
    window.shellApi = { openFile: vi.fn(), context: { summary: async () => ({ agents: [row] }), tokenizers: async () => ({}), retry } }
    settings.contextGeminiSignIn = false
    const w = mountPage({ agents: [{ id: 'claude', available: true }] })
    await flushPromises()
    expect(w.find('[data-test="agent-total"]').text()).toBe('≈ 3.1k tokens')
    expect(w.text()).toContain('estimate')
    expect(w.text()).toContain("Some counts are estimates: couldn't reach Anthropic count_tokens.")
    expect(w.text()).toContain('Count with my Claude sign-in')
    await w.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(retry).toHaveBeenCalled()
    w.unmount()
  })

  it('reads nothing until the page is open, and shows a row the search finds', async () => {
    const summary = vi.fn(async () => ({ agents: [] }))
    window.shellApi = { context: { summary, tokenizers: async () => ({}) } }
    const shell = shellFor({ page: ref('general') })
    const w = mountPage({ agents: [{ id: 'claude', available: true }] }, shell)
    await flushPromises()
    expect(summary).not.toHaveBeenCalled()
    expect(w.text()).toContain('Context cost')
    expect(w.text()).toContain('Count with my Claude sign-in') // the switches stay searchable
    shell.page.value = 'context'
    await flushPromises()
    expect(summary).toHaveBeenCalled()
    w.unmount()
  })

  it('opens a rules file in Tessel’s editor, never a not-followed import; sends both sign-in switches', async () => {
    const row = agentRow({
      items: [
        { key: 'r', group: 'rules', type: 'file', label: 'CLAUDE.md', path: String.raw`C:\p\CLAUDE.md`, loaded: true, result: { tokens: 10, exact: true, source: 'local', tokenizer: 'o200k_base' } },
        { key: 'o', group: 'rules', type: 'file', label: 'rules.md', path: String.raw`\\evil\share\rules.md`, loaded: false, note: 'outside' }
      ],
      summary: { total: 10, groups: { rules: 10, skills: 0, mcp: 0, tessel: 0 }, optional: 10, pending: 0, exact: 'all' }
    })
    settings.contextGeminiSignIn = true
    const summary = vi.fn(async () => ({ agents: [row] }))
    const openFile = vi.fn()
    window.shellApi = { openFile, context: { summary, tokenizers: async () => ({}) } }
    const shell = shellFor()
    const openInEditor = vi.fn()
    const w = mountPage({ agents: [{ id: 'claude', available: true }] }, shell, { panelCtx: { openInEditor } })
    await flushPromises()
    expect(summary.mock.calls[0][0]).toMatchObject({ claudeSignIn: false, geminiSignIn: true })
    expect(w.text()).toContain('not followed (outside the project)')
    const opens = w.findAll('button').filter((b) => b.text() === 'Open')
    expect(opens).toHaveLength(1)
    await opens[0].trigger('click')
    expect(openInEditor).toHaveBeenCalledWith({ file: String.raw`C:\p\CLAUDE.md`, preview: false })
    expect(shell.emit).toHaveBeenCalledWith('close')
    expect(openFile).not.toHaveBeenCalled()
    expect(w.text()).toContain('Count with my Gemini CLI sign-in')
    expect(w.text()).toContain('Uses your Claude Code sign-in')
    settings.contextGeminiSignIn = false
    w.unmount()
  })

  it('shows a flood of imports as one line, and caps every list', async () => {
    const refused = Array.from({ length: 350 }, (_, i) => ({ key: `o${i}`, group: 'rules', type: 'file', label: `far${i}.md`, path: `C:\\far${i}.md`, loaded: false, note: 'outside' }))
    const row = agentRow({
      items: [...refused, { key: 'claude:more', group: 'rules', type: 'more', label: '', count: 121970, loaded: false, note: 'more' }],
      summary: { total: 0, groups: { rules: 0, skills: 0, mcp: 0, tessel: 0 }, optional: 0, pending: 0, exact: 'none' }
    })
    window.shellApi = { openFile: vi.fn(), context: { summary: async () => ({ agents: [row] }), tokenizers: async () => ({}) } }
    const w = mountPage({ agents: [{ id: 'claude', available: true }] })
    await flushPromises()
    const lines = w.findAll('[data-group="rules"] .ctx-line')
    expect(lines).toHaveLength(302) // 300, "N more not shown", then the imports not looked at
    expect(lines[300].text()).toBe('50 more not shown')
    expect(lines[301].text()).toBe('121,970 more imports not followed')
    expect(lines[301].classes()).toContain('tally')
    expect(lines[301].classes()).not.toContain('off')
    w.unmount()
    const few = agentRow({ items: [{ key: 'claude:more', group: 'rules', type: 'more', label: '', count: 1, loaded: false, note: 'more' }] })
    window.shellApi = { openFile: vi.fn(), context: { summary: async () => ({ agents: [few] }), tokenizers: async () => ({}) } }
    const v = mountPage({ agents: [{ id: 'claude', available: true }] })
    await flushPromises()
    expect(v.find('[data-group="rules"] .ctx-line').text()).toBe('1 more import not followed')
    v.unmount()
    const many = agentRow({ items: [{ key: 'claude:more', group: 'rules', type: 'more', label: '', count: 121970, loaded: false, note: 'more' }] })
    window.shellApi = { openFile: vi.fn(), context: { summary: async () => ({ agents: [many] }), tokenizers: async () => ({}) } }
    const m = mountPage({ agents: [{ id: 'claude', available: true }] })
    await flushPromises()
    expect(m.find('[data-group="rules"] .ctx-line').text()).toBe('121,970 more imports not followed')
    m.unmount()
  })
})
