// Settings reaches every feature: the "Windows and tools" rows open each
// window, panel or tool (an `open-tool` event that App.vue turns into the
// same action as the palette or the toolbar), the options that lived only
// in the sidebar's and Source Control's menus are real settings, and the
// search box finds them all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings, settings } from '../settings'
import { setUiLanguage } from '../i18n'
import { SETTINGS_TOOLS, SETTINGS_TOOL_IDS, runSettingsTool } from '../settingsTools'

const visiblePages = (wrapper) =>
  wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))

// App.vue, with either line ending.
const appSource = readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')

// What each row must do in App.vue (the palette's or toolbar's own call).
const EXPECTED_ACTION = {
  mcp: 'mcpOpen.value = true',
  skills: 'skillsOpen.value = true',
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
    const actions = { mcp: vi.fn(), skills: vi.fn() }
    expect(runSettingsTool('skills', actions)).toBe(true)
    expect(actions.skills).toHaveBeenCalledTimes(1)
    expect(actions.mcp).not.toHaveBeenCalled()
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
    await search.setValue('mcp')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toContain('agents')
    expect(wrapper.get('[data-open-tool="mcp"]').element.closest('[hidden]')).toBeNull()
    await search.setValue('clean up worktrees')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toEqual(['git'])
    expect(wrapper.get('[data-open-tool="cleanupWorktrees"]').element.closest('[hidden]')).toBeNull()
    await search.setValue('skills')
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-open-tool="skills"]').element.closest('[hidden]')).toBeNull()
  })

  it('shows the group in French', async () => {
    await setUiLanguage('fr')
    await nextTick()
    expect(wrapper.get('[data-tools="agents"]').text()).toContain('Fenêtres et outils')
    expect(wrapper.get('[data-open-tool="mcp"]').text()).toBe('Ouvrir…')
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
