import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SkillsDialog from '../components/SkillsDialog.vue'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/skills.json'

const skill = (over) => ({
  id: over.dir + '/SKILL.md',
  name: 'pdf',
  description: 'Fill PDF forms.',
  folder: 'pdf',
  scope: 'user',
  seenBy: ['claude', 'opencode', 'copilot'],
  managed: null,
  link: false,
  removable: true,
  source: null,
  ...over
})

const pkg = {
  id: 'p1',
  name: 'pdf',
  description: 'Fill PDF forms.',
  skillMd: '---\nname: pdf\n---\nUse pdftk.',
  files: [{ path: 'SKILL.md', size: 30 }, { path: 'fill.py', size: 2048 }],
  totalBytes: 2078,
  scripts: ['fill.py'],
  setup: ['npx pdf-helper setup'],
  source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf', commit: 'abcdef1234' }
}

describe('Skills dialog', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
    setMessages('en', {})
  })

  function api(over = {}) {
    previousApi = window.shellApi
    const calls = { install: [], remove: [], github: [] }
    window.shellApi = {
      skillsList: async () => ({
        roots: [],
        skills: [
          skill({ dir: '/h/.claude/skills/pdf', source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' } }),
          skill({ dir: '/p/.agents/skills/pdf', scope: 'project', seenBy: ['codex', 'opencode', 'copilot', 'gemini'] }),
          skill({ dir: '/h/.claude/skills/synced/a/docx', name: 'docx', description: null, managed: 'synced', removable: false })
        ]
      }),
      skillsFromGithub: async (q) => {
        calls.github.push(q)
        return q.pick ? pkg : { repo: 'o/r', candidates: [{ path: 'skills/pdf', name: 'pdf' }, { path: 'skills/docx', name: 'docx' }] }
      },
      skillsInstall: async (q) => {
        calls.install.push(q)
        return { ok: true, name: 'pdf', results: [{ dir: '/h/.claude/skills/pdf', ok: true, seenBy: ['claude'] }, { dir: '/h/.agents/skills/pdf', ok: false, exists: true, seenBy: ['codex'] }] }
      },
      skillsRemove: async (q) => {
        calls.remove.push(q)
        return { ok: true }
      },
      skillsForUpdate: async () => pkg,
      skillsOpen: async () => ({ ok: true }),
      ...over
    }
    return calls
  }

  it('lists each skill once with its copies: agents, scope, path; only the user\'s own can be removed', async () => {
    api()
    const agents = ['claude', 'codex'].map((id) => ({ id, available: true }))
    const wrapper = mount(SkillsDialog, { props: { agents, cwd: '/p' }, attachTo: document.body })
    await flushPromises()
    const rows = wrapper.findAll('.mcp-server')
    expect(rows.map((r) => r.find('.mcp-name').text())).toEqual(['docx', 'pdf'])
    const pdf = rows[1]
    const copies = pdf.findAll('.skills-copy')
    expect(copies).toHaveLength(2)
    expect(copies[0].text()).toContain('Seen by Claude Code')
    expect(copies[0].text()).toContain('All projects')
    expect(copies[0].text()).toContain('/h/.claude/skills/pdf')
    expect(copies[0].text()).toContain('Update') // added from GitHub
    expect(copies[1].text()).toContain('This project')
    expect(copies[1].text()).toContain('Codex')
    expect(copies[1].text()).not.toContain('Update')
    const docx = rows[0]
    expect(docx.text()).toContain('Synced from your Claude account')
    expect(docx.find('.danger').exists()).toBe(false)
    wrapper.unmount()
  })

  it('removes to the Recycle Bin, or deletes after a second confirmation', async () => {
    const calls = api()
    const answers = [true, 'alt', true]
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }] },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(answers.shift())) } },
      attachTo: document.body
    })
    await flushPromises()
    const removeBtn = () => wrapper.findAll('.skills-copy')[1].find('.danger')
    await removeBtn().trigger('click')
    await flushPromises()
    expect(calls.remove[0]).toMatchObject({ dir: '/h/.claude/skills/pdf', mode: 'trash' })
    expect(asked[0]).toMatchObject({ confirmLabel: 'Move to the Recycle Bin', altLabel: 'Delete permanently', code: '/h/.claude/skills/pdf' })
    await removeBtn().trigger('click')
    await flushPromises()
    expect(calls.remove[1]).toMatchObject({ mode: 'delete' })
    expect(asked[2].title).toContain('permanently')
    wrapper.unmount()
  })

  it('adds from GitHub: picks a skill, shows SKILL.md and files, installs for the chosen agents and scope', async () => {
    const calls = api()
    const agents = ['claude', 'codex'].map((id) => ({ id, available: true }))
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents, cwd: '/p' },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(true)) } },
      attachTo: document.body
    })
    await flushPromises()
    await wrapper.findAll('.launch-seg-btn').find((b) => b.text() === 'Add').trigger('click')
    await wrapper.find('input.mcp-input').setValue('o/r')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('several skills')
    await wrapper.findAll('.skills-candidates .exit-btn')[0].trigger('click')
    await flushPromises()
    expect(calls.github[1]).toEqual({ input: 'o/r', pick: 'skills/pdf' })
    expect(wrapper.find('.skills-md').text()).toContain('Use pdftk.')
    expect(wrapper.text()).toContain('2 files')
    expect(wrapper.text()).toContain('fill.py')
    expect(wrapper.text()).toContain('Tessel never runs them')

    // The setup command is offered, never run on its own.
    await wrapper.findAll('.skills-setup .exit-btn')[0].trigger('click')
    await flushPromises()
    expect(asked[0].code).toBe('npx pdf-helper setup')
    expect(wrapper.emitted('run')[0][0]).toMatchObject({ command: 'npx pdf-helper setup' })

    await wrapper.findAll('.set-seg .launch-seg-btn').find((b) => b.text() === 'This project').trigger('click')
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'p1', agents: ['claude', 'codex'], scope: 'project', cwd: '/p', replace: null })
    const results = wrapper.findAll('.mcp-add-results .mcp-agent')
    expect(results.map((r) => r.find('.mcp-status').text())).toEqual(['Installed', 'Already there'])
    await results[1].find('button').trigger('click')
    await flushPromises()
    expect(calls.install[1]).toMatchObject({ replace: '/h/.agents/skills/pdf' })
    wrapper.unmount()
  })

  it('Update shows the new version, then replaces that copy only', async () => {
    const calls = api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('.skills-copy')[1].findAll('.exit-btn').find((b) => b.text() === 'Update').trigger('click')
    await flushPromises()
    expect(wrapper.find('.skills-md').exists()).toBe(true)
    expect(wrapper.find('.mcp-targets').exists()).toBe(false)
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'p1', replace: '/h/.claude/skills/pdf' })
    wrapper.unmount()
  })

  it('speaks French', async () => {
    api()
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Les compétences sont des dossiers')
    expect(wrapper.text()).toContain('Tous les projets')
    expect(wrapper.text()).toContain('Synchronisée depuis votre compte Claude')
    wrapper.unmount()
  })

  it('as a window: Escape and a click on the backdrop close it', async () => {
    api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.find('.help-head').exists()).toBe(true)
    await wrapper.get('input.skills-search').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })

  it('embedded (a Settings page): the same content, without backdrop, card, title bar or a way to close it', async () => {
    api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }], embedded: true }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.help-backdrop').exists()).toBe(false)
    expect(wrapper.find('.help-card').exists()).toBe(false)
    expect(wrapper.find('.help-head').exists()).toBe(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.mcp-intro').exists()).toBe(true)
    expect(wrapper.findAll('.mcp-server').map((r) => r.find('.mcp-name').text())).toEqual(['docx', 'pdf'])
    expect(document.activeElement).toBe(document.body)
    await wrapper.get('input.skills-search').trigger('keydown', { key: 'Escape' })
    await wrapper.trigger('pointerdown')
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('Antigravity plugins: only with the Antigravity CLI installed; listed, turned off, uninstalled, installed in a pane', async () => {
    const calls = api()
    calls.set = []
    calls.rm = []
    let list = [
      { name: 'figma', enabled: true, version: '1.2.0', source: 'antigravity-plugins-official', counts: { skills: 2, mcpServers: 1 } },
      { name: 'old-kit', enabled: false, version: '', source: 'antigravity', counts: {} }
    ]
    Object.assign(window.shellApi, {
      agyPluginsList: async () => ({ plugins: list }),
      agyPluginsSet: async (q) => {
        calls.set.push(q)
        list = list.map((p) => (p.name === q.name ? { ...p, enabled: q.enabled } : p))
        return { ok: true }
      },
      agyPluginsRemove: async (q) => {
        calls.rm.push(q)
        list = list.filter((p) => p.name !== q.name)
        return { ok: true }
      }
    })
    const without = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(without.find('[data-test="skills-tab-plugins"]').exists()).toBe(false)
    without.unmount()

    const agents = [{ id: 'claude', available: true }, { id: 'antigravity', available: true }]
    const wrapper = mount(SkillsDialog, { props: { agents }, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
    await flushPromises()
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    const figma = wrapper.get('[data-test="agy-plugin-figma"]')
    expect(figma.text()).toContain('1.2.0')
    expect(figma.text()).toContain('2 skills · 1 MCP server')
    expect(wrapper.get('[data-test="agy-plugin-old-kit"]').text()).toContain('Turned off')
    await figma.findAll('button')[0].trigger('click')
    await flushPromises()
    expect(calls.set).toEqual([{ name: 'figma', enabled: false }])
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('Turned off')
    await wrapper.get('[data-test="agy-plugin-old-kit"]').find('button.danger').trigger('click')
    await flushPromises()
    expect(calls.rm).toEqual([{ name: 'old-kit' }])
    expect(wrapper.find('[data-test="agy-plugin-old-kit"]').exists()).toBe(false)
    // Installing runs in a pane the user sees; nothing a shell would read as more.
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('figma@antigravity-plugins-official')
    await wrapper.get('form.mcp-toolbar').trigger('submit')
    expect(wrapper.emitted('run').at(-1)[0].command).toBe('agy plugin install "figma@antigravity-plugins-official"')
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('x; rm -rf /')
    await wrapper.get('form.mcp-toolbar').trigger('submit')
    expect(wrapper.emitted('run')).toHaveLength(1)
    expect(wrapper.text()).toContain('Enter a plugin name')
    wrapper.unmount()
  })

  it('Antigravity plugins: French', async () => {
    api({ agyPluginsList: async () => ({ plugins: [{ name: 'figma', enabled: false, version: '1.0.0', source: 'x', counts: { skills: 1 } }] }), agyPluginsSet: async () => ({ ok: true }), agyPluginsRemove: async () => ({ ok: true }) })
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'antigravity', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[data-test="skills-tab-plugins"]').text()).toBe('Plugins Antigravity')
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('Désactivé')
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('1 skill')
    wrapper.unmount()
  })
})
