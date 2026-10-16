// Settings reaches every feature: the "Windows and tools" rows open each
// window, panel or tool (an `open-tool` event that App.vue turns into the
// same action as the palette or the toolbar), Skills and MCP servers are
// pages of their own, the options that lived only in the sidebar's and
// Source Control's menus are real settings, and the search box finds them all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import SettingsDialog from '../components/SettingsDialog.vue'
import McpDialog from '../components/McpDialog.vue'
import SkillsDialog from '../components/SkillsDialog.vue'
import { resetSettings, settings } from '../settings'
import { setUiLanguage } from '../i18n'
import { SETTINGS_TOOLS, SETTINGS_TOOL_IDS, runSettingsTool } from '../settingsTools'

const visiblePages = (wrapper) =>
  wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))

// App.vue, with either line ending.
const appSource = readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')

// What each row must do in App.vue (the palette's or toolbar's own call).
const EXPECTED_ACTION = {
  tools: 'openTools()',
  sessions: 'openSessions()',
  dashboard: "showSideTab('dashboard')",
  history: "showSideTab('history')",
  tasks: "showSideTab('tasks')",
  taskHistory: "showSideTab('taskHistory')",
  changes: "showSideTab('changes')",
  newTask: 'openNewTask()',
  activity: "openActivity('workspace')",
  notes: 'openNotesView(currentWs.value.id)',
  conversations: "showSideTab('conversations')",
  liveShare: 'openLiveShare()',
  files: "showSideTab('files')",
  ports: 'bar.openPorts()',
  resources: 'bar.openResources()',
  cleanupWorktrees: 'openWorktreeCleanup(ws.id)',
  github: 'openGitHub()',
  linear: 'openLinear()',
  floating: 'toggleFloating()',
  browser: 'openInBrowser({ newPane: true, focusAddress: true })',
  help: 'helpOpen.value = true',
  logs: 'openLogs()'
}

describe('settingsTools', () => {
  it('lists each tool once, each with an expected App action', () => {
    expect(new Set(SETTINGS_TOOL_IDS).size).toBe(SETTINGS_TOOL_IDS.length)
    expect([...SETTINGS_TOOL_IDS].sort()).toEqual(Object.keys(EXPECTED_ACTION).sort())
    for (const rows of Object.values(SETTINGS_TOOLS))
      for (const r of rows) {
        expect(r.title).toBeTruthy()
        expect(r.hint).toBeTruthy()
        expect(r.button).toBeTruthy()
      }
  })

  it('runSettingsTool runs the matching action only', () => {
    const actions = { tools: vi.fn(), sessions: vi.fn() }
    expect(runSettingsTool('sessions', actions)).toBe(true)
    expect(actions.sessions).toHaveBeenCalledTimes(1)
    expect(actions.tools).not.toHaveBeenCalled()
    expect(runSettingsTool('nope', actions)).toBe(false)
    expect(runSettingsTool('toString', actions)).toBe(false)
  })

  it('App.vue closes Settings and opens the right window for every row', () => {
    expect(appSource).toContain('@open-tool="openFromSettings"')
    const fn = appSource.match(/function openFromSettings\(id\) \{\n([\s\S]*?)\n\}/)
    expect(fn).not.toBeNull()
    expect(fn[1]).toContain('closeSettings()')
    expect(fn[1]).toContain('runSettingsTool(id, settingsToolActions)')
    const block = appSource.match(/const settingsToolActions = \{\n([\s\S]*?)\n\}\n/)
    expect(block).not.toBeNull()
    // Split the object into its top-level entries ("  id: ...").
    const entries = {}
    for (const part of block[1].split(/\n(?= {2}\w+: )/)) {
      const m = part.match(/^ {2}(\w+): ([\s\S]*)$/)
      if (m) entries[m[1]] = m[2]
    }
    for (const id of SETTINGS_TOOL_IDS) {
      expect(entries[id], id).toBeDefined()
      expect(entries[id], id).toContain(EXPECTED_ACTION[id])
    }
    // Skills and MCP servers are pages now: no rows for them.
    expect(entries.mcp).toBeUndefined()
    expect(entries.skills).toBeUndefined()
  })

  it("App.vue opens the status bar's popovers through its ref, showing the bar first", () => {
    expect(appSource).toMatch(/<StatusBar\n\s+v-if="settings.statusBarVisible"\n\s+ref="statusBarRef"/)
    const fn = appSource.match(/function withStatusBar\(fn\) \{\n([\s\S]*?)\n\}/)
    expect(fn).not.toBeNull()
    expect(fn[1]).toContain('settings.statusBarVisible = true')
    expect(fn[1]).toContain('fn(statusBarRef.value)')
    const bar = readFileSync(join(__dirname, '..', 'components', 'StatusBar.vue'), 'utf8')
    expect(bar).toContain('defineExpose({ openResources, openPorts })')
  })

  it("App.vue gives Settings the project folder and runs its pages' commands in a pane", () => {
    expect(appSource).toContain(':project-cwd="currentWs ? currentWs.cwd : null"')
    expect(appSource).toContain('@run-job="runFromSettings"')
    expect(appSource).not.toContain('@open-connections')
    const fn = appSource.match(/function runFromSettings\(job\) \{\n([\s\S]*?)\n\}/)
    expect(fn).not.toBeNull()
    expect(fn[1]).toContain('closeSettings()')
    expect(fn[1]).toContain('runInPane(job)')
    // The palette still opens their windows.
    expect(appSource).toContain("t('app.cmd.mcp', 'MCP servers'), () => (mcpOpen.value = true)")
    expect(appSource).toContain("t('app.cmd.skills', 'Skills'), () => (skillsOpen.value = true)")
    expect(appSource).toMatch(/<McpDialog\n\s+v-if="mcpOpen"/)
    expect(appSource).toMatch(/<SkillsDialog\n\s+v-if="skillsOpen"/)
  })
})

// Mounting the whole settings dialog is CPU work; a loaded machine can pass 5 s.
describe('Settings > Windows and tools', { timeout: 30_000 }, () => {
  let wrapper, previousApi

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
    wrapper = mount(SettingsDialog, { attachTo: document.body })
  }, 30_000)

  afterEach(async () => {
    wrapper?.unmount()
    window.shellApi = previousApi
    resetSettings()
    await setUiLanguage('en')
  })

  it('each row sits in its page and emits open-tool with its id', async () => {
    for (const [page, rows] of Object.entries(SETTINGS_TOOLS)) {
      const group = wrapper.get(`.set-page[data-page="${page}"] [data-tools="${page}"]`)
      expect(group.findAll('[data-open-tool]').map((b) => b.attributes('data-open-tool'))).toEqual(rows.map((r) => r.id))
    }
    for (const id of SETTINGS_TOOL_IDS) await wrapper.get(`[data-open-tool="${id}"]`).trigger('click')
    expect(wrapper.emitted('open-tool').map((e) => e[0])).toEqual(SETTINGS_TOOL_IDS)
  })

  it('search finds the tools by name', async () => {
    const search = wrapper.get('.set-search input')
    const find = async (text) => {
      await search.setValue(text)
      await nextTick()
      await nextTick()
    }
    await find('install tools')
    expect(visiblePages(wrapper)).toContain('agents')
    expect(wrapper.get('[data-open-tool="tools"]').element.closest('[hidden]')).toBeNull()
    await find('clean up worktrees')
    expect(visiblePages(wrapper)).toEqual(['git'])
    expect(wrapper.get('[data-open-tool="cleanupWorktrees"]').element.closest('[hidden]')).toBeNull()
    await find('live share')
    expect(visiblePages(wrapper)).toContain('orchestration')
    expect(wrapper.get('[data-open-tool="liveShare"]').element.closest('[hidden]')).toBeNull()
    await find('resource manager')
    expect(visiblePages(wrapper)).toContain('general')
    expect(wrapper.get('[data-open-tool="resources"]').element.closest('[hidden]')).toBeNull()
    await find('file explorer')
    expect(visiblePages(wrapper)).toContain('editor')
    expect(wrapper.get('[data-open-tool="files"]').element.closest('[hidden]')).toBeNull()
  })

  it('shows the group in French', async () => {
    await setUiLanguage('fr')
    await nextTick()
    expect(wrapper.get('[data-tools="agents"]').text()).toContain('Fenêtres et outils')
    expect(wrapper.get('[data-open-tool="tools"]').text()).toBe('Ouvrir…')
    expect(wrapper.get('[data-open-tool="files"]').text()).toBe('Afficher')
    expect(wrapper.get('[data-tools="editor"]').text()).toContain('Explorateur de fichiers')
  })
})

// Skills and MCP servers: their whole window inside the page, without its
// backdrop, title bar or Escape; a command they run goes to App (run-job).
describe('Settings > Skills and MCP servers pages', { timeout: 30_000 }, () => {
  let wrapper, previousApi, calls

  const skill = (dir) => ({
    id: dir + '/SKILL.md',
    name: 'pdf',
    description: 'Fill PDF forms.',
    folder: 'pdf',
    scope: 'user',
    seenBy: ['claude'],
    managed: null,
    link: false,
    removable: true,
    source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' },
    dir
  })
  const pkg = {
    id: 'p1',
    name: 'pdf',
    description: 'Fill PDF forms.',
    skillMd: 'Use pdftk.',
    files: [{ path: 'SKILL.md', size: 10 }],
    totalBytes: 10,
    scripts: [],
    setup: ['npx pdf-helper setup'],
    source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf', commit: 'abcdef1234' }
  }
  const agents = ['claude', 'codex'].map((id) => ({ id, name: id, available: true }))

  beforeEach(() => {
    resetSettings()
    try {
      localStorage.clear()
    } catch {
      // no storage
    }
    previousApi = window.shellApi
    calls = { skillsList: [], mcpList: 0 }
    window.shellApi = {
      skillsList: async (cwd) => {
        calls.skillsList.push(cwd)
        return { roots: [], skills: [skill('/h/.claude/skills/pdf')] }
      },
      skillsForUpdate: async () => pkg,
      skillsOpen: async () => ({ ok: true }),
      mcpList: async () => {
        calls.mcpList++
        return { claude: [{ name: 'context7', scope: 'user', type: 'http', target: 'https://mcp.context7.com/mcp' }], codex: [], others: {} }
      },
      checkTools: async () => ({})
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    window.shellApi = previousApi
    resetSettings()
  })

  const mountAt = (section) =>
    mount(SettingsDialog, {
      props: { section, agents, projectCwd: '/p' },
      global: { provide: { askConfirm: () => Promise.resolve(true) } },
      attachTo: document.body
    })
  const embeddedIn = (page) => {
    const el = wrapper.get(`.set-page[data-page="${page}"]`)
    expect(el.find('.mcp-embedded').exists()).toBe(true)
    expect(el.find('.help-backdrop').exists()).toBe(false)
    expect(el.find('.help-card').exists()).toBe(false)
    expect(el.find('.help-head').exists()).toBe(false)
    expect(el.find('[role="dialog"]').exists()).toBe(false)
    return el
  }

  it('are pages of AI capabilities, after the accounts', () => {
    wrapper = mountAt(null)
    const ai = wrapper.findAll('.set-nav-group')[0]
    expect(ai.findAll('.set-nav-item').map((b) => b.attributes('data-page'))).toEqual(['agents', 'accounts', 'skills', 'mcp', 'orchestration', 'voice'])
    expect(wrapper.get('.set-nav-item[data-page="skills"]').text()).toBe('Skills')
    expect(wrapper.get('.set-nav-item[data-page="mcp"]').text()).toBe('MCP servers')
    expect(wrapper.get('.set-nav-item[data-page="mcp"] svg path').attributes('d')).toBeTruthy()
  })

  it('Skills shows its window in the page, for the project; a setup it runs goes to App', async () => {
    wrapper = mountAt('skills')
    await flushPromises()
    expect(visiblePages(wrapper)).toEqual(['skills'])
    const page = embeddedIn('skills')
    expect(calls.skillsList).toEqual(['/p'])
    expect(page.text()).toContain('Fill PDF forms.')
    expect(page.findAll('.launch-seg-btn').map((b) => b.text())).toContain('Add')

    // A skill's copies are in its details, opened from its row; Escape in
    // there closes the details, not Settings.
    await page.get('.skills-row').trigger('click')
    await flushPromises()
    await page.get('.skills-details .skills-btn').trigger('keydown', { key: 'Escape' })
    expect(page.find('.skills-details').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    await page.get('.skills-row').trigger('click')
    await flushPromises()
    await page.findAll('.skills-copy .exit-btn').find((b) => b.text() === 'Update').trigger('click')
    await flushPromises()
    await page.get('.skills-setup .exit-btn').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('run-job')).toHaveLength(1)
    expect(wrapper.emitted('run-job')[0][0]).toMatchObject({ command: 'npx pdf-helper setup' })
    expect(wrapper.emitted('close')).toBeUndefined()

    // Escape is Settings' (it closes Settings), not the embedded window's.
    await page.get('.skills-setup .exit-btn').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.findComponent(SkillsDialog).emitted('close')).toBeUndefined()
  })

  it('MCP servers shows its window in the page; run, Install tools and Skills reach Settings', async () => {
    wrapper = mountAt('mcp')
    await flushPromises()
    expect(visiblePages(wrapper)).toEqual(['mcp'])
    const page = embeddedIn('mcp')
    expect(calls.mcpList).toBeGreaterThan(0)
    expect(page.text()).toContain('context7')
    expect(page.findAll('.launch-seg-btn').map((b) => b.text())).toEqual(expect.arrayContaining(['Catalog', 'Custom', 'Team connections']))
    const mcp = wrapper.findComponent(McpDialog)
    expect(mcp.props('cwd')).toBe('/p')

    mcp.vm.$emit('run', { label: 'Sign in: x', command: 'codex mcp login x' })
    expect(wrapper.emitted('run-job')[0][0]).toEqual({ label: 'Sign in: x', command: 'codex mcp login x' })
    mcp.vm.$emit('tools')
    expect(wrapper.emitted('open-tool')).toEqual([['tools']])

    await page.get('.mcp-skills-link').trigger('click')
    await flushPromises()
    expect(visiblePages(wrapper)).toEqual(['skills'])
    expect(wrapper.findComponent(McpDialog).exists()).toBe(false)
    embeddedIn('skills')
  })

  it("Orchestration's Details opens the MCP servers page on Team connections", async () => {
    wrapper = mountAt('orchestration')
    await flushPromises()
    const details = wrapper.get('.set-page[data-page="orchestration"]').findAll('button').find((b) => b.text() === 'Details')
    await details.trigger('click')
    await flushPromises()
    expect(visiblePages(wrapper)).toEqual(['mcp'])
    expect(wrapper.get('.set-page[data-page="mcp"] .launch-seg-btn.on').text()).toBe('Team connections')
    // Another page, then back: on Installed again.
    await wrapper.get('.set-nav-item[data-page="agents"]').trigger('click')
    await wrapper.get('.set-nav-item[data-page="mcp"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.set-page[data-page="mcp"] .launch-seg-btn.on').text()).toContain('Installed')
  })

  it('search finds both pages by name, without loading their windows', async () => {
    wrapper = mountAt('general')
    await flushPromises()
    const search = wrapper.get('.set-search input')
    await search.setValue('mcp')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toContain('mcp')
    expect(wrapper.findComponent(McpDialog).exists()).toBe(false)
    expect(calls.mcpList).toBe(0)
    await search.setValue('skills')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toContain('skills')
    const open = wrapper.get('.set-page[data-page="skills"]').findAll('button').find((b) => b.text() === 'Open Skills')
    await open.trigger('click')
    await flushPromises()
    expect(visiblePages(wrapper)).toEqual(['skills'])
    embeddedIn('skills')
  })
})

describe('Settings: the sidebar and Source Control menu options', { timeout: 30_000 }, () => {
  let wrapper, previousApi

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
    wrapper = mount(SettingsDialog, { attachTo: document.body, props: { section: 'appearance' } })
  }, 30_000)

  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    resetSettings()
  })

  it('sets grouping, card properties, activity layout and filters', async () => {
    const group = wrapper.findAll('[data-setting="sidebarGroupBy"] button')
    await group[0].trigger('click')
    expect(settings.sidebarGroupBy).toBe('none')
    expect(wrapper.find('#settings-project-order').exists()).toBe(false)
    await group[1].trigger('click')
    expect(settings.sidebarGroupBy).toBe('repo')
    expect(wrapper.find('#settings-project-order').exists()).toBe(true)

    await wrapper.get('[data-card-property="ports"]').setValue(false)
    expect(settings.worktreeCardProperties).not.toContain('ports')
    await wrapper.get('[data-card-property="ports"]').setValue(true)
    expect(settings.worktreeCardProperties).toContain('ports')

    await wrapper.findAll('[data-setting="agentActivityDisplayMode"] button')[1].trigger('click')
    expect(settings.agentActivityDisplayMode).toBe('full')

    await wrapper.get('[data-setting="hideSleeping"]').setValue(true)
    expect(settings.showSleepingWorkspaces).toBe(false)
    await wrapper.get('[data-setting="alwaysShowDefaultBranchWorkspace"]').setValue(false)
    expect(settings.alwaysShowDefaultBranchWorkspace).toBe(false)
    await wrapper.get('[data-setting="hideDefaultBranchWorkspace"]').setValue(true)
    expect(settings.hideDefaultBranchWorkspace).toBe(true)
  })

  it('sets the Source Control view', async () => {
    const views = wrapper.findAll('[data-setting="sourceControlViewMode"] button')
    expect(views.map((b) => b.attributes('aria-pressed'))).toEqual(['true', 'false'])
    await views[1].trigger('click')
    expect(settings.sourceControlViewMode).toBe('list')
    expect(views.map((b) => b.attributes('aria-pressed'))).toEqual(['false', 'true'])
  })
})
