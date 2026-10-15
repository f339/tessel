import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import McpDialog from '../components/McpDialog.vue'

describe('MCP servers dialog', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
  })

  it('opens with every agent installed before its server lists arrive, then shows them', async () => {
    previousApi = window.shellApi
    let answer
    window.shellApi = {
      mcpList: () => new Promise((r) => (answer = r)),
      checkTools: async () => ({})
    }
    const agents = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline'].map((id) => ({ id, available: true }))
    // Drawn while the lists are still being read: must not throw.
    const wrapper = mount(McpDialog, { props: { agents }, attachTo: document.body })
    expect(wrapper.text()).toContain('Loading')
    answer({
      claude: [],
      codex: [],
      others: { cline: { servers: [{ name: 'tessel-team', type: 'stdio', target: 'node s.cjs' }] } }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('tessel-team')
    wrapper.unmount()
  })

  it('lists the Antigravity CLI servers (its own mcp_config.json), one it turned off marked so, and adds to it', async () => {
    previousApi = window.shellApi
    const added = []
    window.shellApi = {
      mcpList: async () => ({
        claude: [],
        codex: [],
        others: {
          antigravity: {
            servers: [
              { name: 'tessel-team', scope: 'user', type: 'stdio', target: 'node s.cjs' },
              { name: 'figma', scope: 'user', type: 'http', target: 'https://x/mcp', enabled: false }
            ]
          }
        }
      }),
      checkTools: async () => ({}),
      mcpAdd: async (spec) => {
        added.push(spec.agent)
        return { ok: true }
      },
      mcpTest: async () => ({ ok: true, status: 'connected', tools: [] })
    }
    const agents = ['claude', 'antigravity'].map((id) => ({ id, available: true }))
    const wrapper = mount(McpDialog, { props: { agents }, attachTo: document.body })
    await flushPromises()
    const row = (name) => wrapper.findAll('.mcp-server').find((r) => r.find('.mcp-name').text() === name)
    expect(row('tessel-team').text()).toContain('Antigravity CLI')
    expect(row('figma').text()).toContain('Turned off')
    expect(row('tessel-team').text()).not.toContain('Turned off')
    await wrapper.findAll('.launch-seg-btn').find((b) => b.text() === 'Catalog').trigger('click')
    const card = () => wrapper.findAll('.mcp-entry').find((e) => e.text().includes('Context7'))
    await card().find('.mcp-entry-head .exit-btn').trigger('click')
    await card().find('form').trigger('submit')
    await flushPromises()
    expect(added).toEqual(['claude', 'antigravity'])
    wrapper.unmount()
  })

  it('adds to every chosen agent even when one fails, and shows Needs sign-in with Sign in instead of Added', async () => {
    previousApi = window.shellApi
    const have = { claude: [], codex: [], gemini: [] }
    const added = []
    window.shellApi = {
      mcpList: async () => ({ claude: have.claude, codex: have.codex, others: { gemini: { servers: have.gemini } } }),
      checkTools: async () => ({}),
      mcpAdd: async (spec) => {
        added.push(spec.agent)
        if (spec.agent === 'claude') return { ok: false, error: 'boom' }
        have[spec.agent].push({ name: spec.name, scope: 'user', type: 'http', target: spec.url })
        return { ok: true }
      },
      mcpTest: async ({ agent }) =>
        agent === 'codex' ? { ok: false, status: 'auth', error: 'needs you to sign in' } : { ok: true, status: 'connected', tools: ['a'] }
    }
    const agents = ['claude', 'codex', 'gemini'].map((id) => ({ id, available: true }))
    const wrapper = mount(McpDialog, { props: { agents, initialTab: 'installed' }, attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('.launch-seg-btn').find((b) => b.text() === 'Catalog').trigger('click')
    const card = () => wrapper.findAll('.mcp-entry').find((e) => e.text().includes('Context7'))
    await card().find('.mcp-entry-head .exit-btn').trigger('click')
    await card().find('form').trigger('submit')
    await flushPromises()
    await flushPromises()
    expect(added).toEqual(['claude', 'codex', 'gemini'])
    const text = card().text()
    expect(text).toContain('Claude Code: boom')
    expect(text).toContain('Needs sign-in')
    // Not "Added" while Claude Code lacks it.
    expect(card().find('.tool-status.ok').exists()).toBe(false)
    const rows = card().findAll('.mcp-add-results .mcp-agent')
    expect(rows.map((r) => r.find('.mcp-status').text())).toEqual(['Failed', 'Needs sign-in', 'Added'])
    await rows[1].find('button').trigger('click')
    expect(wrapper.emitted('run')[0][0].command).toBe('codex mcp login context7')
    wrapper.unmount()
  })

  it('as a window, Escape and the backdrop close it; embedded (a Settings page), nothing does', async () => {
    previousApi = window.shellApi
    window.shellApi = {
      mcpList: async () => ({ claude: [{ name: 'context7', scope: 'user', type: 'http', target: 'https://x' }], codex: [], others: {} }),
      checkTools: async () => ({})
    }
    const agents = [{ id: 'claude', available: true }]
    const modal = mount(McpDialog, { props: { agents }, attachTo: document.body })
    await flushPromises()
    expect(modal.find('.help-head').exists()).toBe(true)
    await modal.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await modal.trigger('pointerdown')
    expect(modal.emitted('close')).toHaveLength(2)
    modal.unmount()

    const page = mount(McpDialog, { props: { agents, embedded: true, initialTab: 'connections' }, attachTo: document.body })
    await flushPromises()
    for (const sel of ['.help-backdrop', '.help-card', '.help-head', '[role="dialog"]']) expect(page.find(sel).exists(), sel).toBe(false)
    expect(page.find('.mcp-intro').exists()).toBe(true)
    expect(page.get('.launch-seg-btn.on').text()).toBe('Team connections')
    await page.findAll('.launch-seg-btn').find((b) => b.text().startsWith('Installed')).trigger('click')
    expect(page.text()).toContain('context7')
    await page.get('.mcp-embedded-body').trigger('keydown', { key: 'Escape' })
    await page.trigger('pointerdown')
    expect(page.emitted('close')).toBeUndefined()
    await page.get('.mcp-skills-link').trigger('click')
    expect(page.emitted('skills')).toHaveLength(1)
    page.unmount()
  })
})
