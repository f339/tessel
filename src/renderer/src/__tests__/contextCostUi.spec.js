import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SkillTokenTag from '../components/context/SkillTokenTag.vue'
import McpTokenTag from '../components/context/McpTokenTag.vue'
import SettingsContext from '../components/settings/SettingsContext.vue'
import { tokensText, sourceLabel, reasonText, sourceTitle, compactTokens, contextCounts } from '../contextCost'
import { settings } from '../settings'

let previousApi
beforeEach(() => {
  previousApi = window.shellApi
  contextCounts.skills = {}
  contextCounts.skillsCwd = undefined
  contextCounts.mcp = {}
  contextCounts.mcpCwd = undefined
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
  it('starts nothing on its own: Measure starts the server on the click only', async () => {
    const mcpMeasure = vi.fn(async () => ({ ok: true, tools: 14, at: 1, counter: {}, result: { tokens: 8600, exact: true, source: 'api', api: 'anthropic', model: 'claude-opus-5-5' } }))
    window.shellApi = { mcpMeasure, context: { mcpMeasures: async () => ({}) } }
    const w = mount(McpTokenTag, { props: { server: { name: 'fs', scope: 'user' }, agent: 'claude', cwd: '/p' } })
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
    const w = mount(McpTokenTag, { props: { server: { name: 'fs' }, agent: 'codex' } })
    await flushPromises()
    expect(w.text()).toContain('900 tokens · 3 tools')
    expect(mcpMeasure).not.toHaveBeenCalled()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Command not found: npx')
    w.unmount()
  })
})

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
    const w = mount(SettingsContext, { props: { cwd: '/p', agents: [{ id: 'claude', name: 'Claude Code', available: true }, { id: 'zsh', available: true }] } })
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
    expect(w.emitted('go')[0]).toEqual(['skills'])
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
    const w = mount(SettingsContext, { props: { agents: [{ id: 'claude', available: true }] } })
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
})
