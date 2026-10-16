// The Settings pages for the settings taken from Orca: each row is there with
// Orca's label, and its control changes the shared settings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'
import { setSelectValue } from './selectTestUtils'

describe('Settings: the Orca settings', () => {
  let wrapper, previousApi
  function open(section) {
    wrapper = mount(SettingsDialog, { props: { section }, attachTo: document.body })
  }
  function row(label) {
    const r = wrapper.findAll('.set-row').find((el) => el.text().includes(label))
    if (!r) throw new Error(`no row "${label}"`)
    return r
  }
  async function clickSeg(label, choice) {
    const b = row(label)
      .findAll('button')
      .find((el) => el.text() === choice)
    await b.trigger('click')
  }
  async function type(id, value) {
    const input = wrapper.get(`#${id}`)
    input.element.value = String(value)
    await input.trigger('change')
    return input
  }

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetSettings()
    window.shellApi = previousApi
    try {
      localStorage.clear()
    } catch {
      /* none */
    }
  })

  it('Editor: font family and the three diff options', async () => {
    open('editor')
    await type('settings-editor-font', '  Fira Code ')
    expect(settings.editorFontFamily).toBe('Fira Code')
    for (const [label, key] of [
      ['Show whitespace in diffs', 'diffShowWhitespace'],
      ['Collapse unchanged regions', 'diffCollapseUnchanged'],
      ['Wrap lines in diffs', 'diffWordWrap']
    ]) {
      expect(settings[key]).toBe(false)
      await clickSeg(label, 'On')
      expect(settings[key]).toBe(true)
    }
  })

  it('Text: weights, line height and cursor opacity, kept in range', async () => {
    open('text')
    await type('settings-font-weight', 350)
    expect(settings.fontWeight).toBe(350)
    const bold = await type('settings-font-weight-bold', 2000)
    expect(settings.fontWeightBold).toBe(900)
    expect(bold.element.value).toBe('900')
    await type('settings-line-height', 1.25)
    expect(settings.lineHeight).toBe(1.25)
    await type('settings-cursor-opacity', 0.4)
    expect(settings.cursorOpacity).toBe(0.4)
  })

  it('Appearance: UI Zoom, panes, padding, mouse, usage percentages, git-ignored files', async () => {
    open('appearance')
    const zoom = row('UI zoom')
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('100%')
    await zoom.get('button[aria-label="Zoom in"]').trigger('click')
    expect(settings.uiZoomLevel).toBe(0.5)
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('110%')
    await zoom.findAll('button').find((b) => b.text() === 'Reset').trigger('click')
    expect(settings.uiZoomLevel).toBe(0)
    await type('settings-inactive-opacity', 0.5)
    expect(settings.inactivePaneOpacity).toBe(0.5)
    await type('settings-divider', 6)
    expect(settings.dividerThickness).toBe(6)
    await type('settings-pad-x', 12)
    await type('settings-pad-y', 2)
    expect([settings.terminalPaddingX, settings.terminalPaddingY]).toEqual([12, 2])
    await row('Hide mouse while typing').get('input').setValue(true)
    expect(settings.hideMouseWhileTyping).toBe(true)
    await clickSeg('Usage percentages', 'Remaining')
    expect(settings.usagePercentageDisplay).toBe('remaining')
    await row('Show Git-ignored files').get('input').setValue(false)
    expect(settings.showGitIgnoredFiles).toBe(false)
  })

  it('Terminal: GPU Acceleration, Color Contrast, scroll speed, interaction and word separators', async () => {
    open('terminal')
    expect(row('GPU acceleration').text()).toContain('Auto tries WebGL')
    await clickSeg('GPU acceleration', 'Off')
    expect(settings.gpuAcceleration).toBe('off')
    expect(row('GPU acceleration').text()).toContain('DOM renderer')

    expect(row('Color contrast').text()).toContain('Recommended')
    await clickSeg('Color contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(4.5)
    await type('settings-contrast-ratio', 7)
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color contrast', 'Off')
    expect(settings.minimumContrastRatio).toBe(1)
    await clickSeg('Color contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color contrast', 'Automatic')
    expect(settings.minimumContrastRatio).toBe(null)

    await type('settings-scroll-normal', 2.5)
    await type('settings-scroll-fast', 50)
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([2.5, 10])
    await row('Scroll speed').get('button').trigger('click')
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([1.15, 5])

    await row('Focus follows mouse').get('input').setValue(true)
    await row('Trim gutter on copy').get('input').setValue(false)
    await row('Allow TUI clipboard writes (OSC 52)').get('input').setValue(false)
    expect([settings.focusFollowsMouse, settings.copyTrimsGutter, settings.allowOsc52Clipboard]).toEqual([true, false, false])
    await wrapper.get('#settings-word-separators').setValue(' ()')
    expect(settings.wordSeparator).toBe(' ()')
  })

  it('Notifications: master switch, bell, volume, suppress, test button', async () => {
    open('alerts')
    expect(wrapper.get('#set-alerts-title').text()).toBe('Notifications')
    // The rows the master switch turns on are indented under it.
    for (const label of ['Windows notifications', 'Terminal bell', 'Suppress while focused', 'Sound'])
      expect(row(label).classes()).toContain('set-row-nested')
    expect(row('In-app alerts').classes()).not.toContain('set-row-nested')
    await row('Terminal bell').get('input').setValue(true)
    expect(settings.notifyTerminalBell).toBe(true)
    expect(wrapper.find('#settings-volume').exists()).toBe(false) // no sound chosen
    expect(wrapper.find('[data-test="alerts-preview"]').exists()).toBe(false)
    settings.alertSound = 'chime'
    await nextTick()
    // Sound, volume and its preview on one row.
    expect(row('Sound').find('#settings-volume').exists()).toBe(true)
    expect(row('Sound').find('[data-test="alerts-preview"]').exists()).toBe(true)
    const vol = wrapper.get('#settings-volume')
    vol.element.value = '35'
    await vol.trigger('input')
    expect(settings.notificationVolume).toBe(35)
    await row('Suppress while focused').get('input').setValue(false)
    expect(settings.notifySuppressWhenFocused).toBe(false)
    await wrapper.get('[data-test="test-notification"]').trigger('click')
    expect(wrapper.emitted('test-notification')).toHaveLength(1)
    await row('Enable notifications').get('input').setValue(false)
    expect(settings.notificationsEnabled).toBe(false)
    expect(wrapper.get('[data-test="test-notification"]').attributes('disabled')).toBeDefined()
    expect(row('Terminal bell').get('input').attributes('disabled')).toBeDefined()
    expect(row('Terminal bell').classes()).toContain('set-disabled')
    expect(wrapper.get('[data-test="alerts-preview"]').attributes('disabled')).toBeDefined()
    // In-app alerts do not depend on it.
    expect(row('In-app alerts').get('input').attributes('disabled')).toBeUndefined()
  })

  it('General: running terminals, workspace directory, deleting workspaces', async () => {
    open('general')
    expect(row('Confirm before closing running terminals').text()).toContain(
      'Ask before stopping a running agent or command when closing a terminal.'
    )
    await type('settings-workspace-dir', ' D:\\copies ')
    expect(settings.workspaceDir).toBe('D:\\copies')
    await row('Workspace directory')
      .findAll('button')
      .find((b) => b.text() === 'Reset')
      .trigger('click')
    expect(settings.workspaceDir).toBe('')
    await row('Ask before deleting workspaces').get('input').setValue(false)
    expect(settings.confirmDeleteWorkspace).toBe(false)
  })

  it('Git & Source Control: branch prefix with feedback, group order', async () => {
    open('git')
    const feedback = () => wrapper.get('[data-test="branch-prefix-feedback"]')
    expect(feedback().text()).toBe('Branches will be named agent/feature')
    // The custom prefix on its own row, under the choice.
    const input = wrapper.get('input[aria-label="Custom branch prefix"]')
    expect(row('Branch prefix').find('input').exists()).toBe(false)
    expect(input.element.closest('.set-row').classList.contains('set-row-nested')).toBe(true)
    await input.setValue('bad name')
    expect(feedback().text()).toMatch(/cannot contain spaces/)
    expect(feedback().classes()).toContain('set-error')
    await input.setValue('team/')
    expect(feedback().text()).toBe('Branches will be named team/feature')
    await clickSeg('Branch prefix', 'None')
    expect(settings.branchPrefix).toBe('none')
    expect(wrapper.find('input[aria-label="Custom branch prefix"]').exists()).toBe(false)
    expect(feedback().text()).toBe('New branches get no prefix.')
    await clickSeg('Branch prefix', 'Git username')
    expect(settings.branchPrefix).toBe('git-username')
    expect(feedback().text()).toMatch(/github\.user/)
    // The group order is a select (three long choices).
    await setSelectValue(wrapper.get('#settings-group-order'), 'staged-first')
    expect(settings.sourceControlGroupOrder).toBe('staged-first')
    await clickSeg('Show changed files as', 'List')
    expect(settings.sourceControlViewMode).toBe('list')
  })

  it('About & updates: version, last checked, Check now, release notes, troubleshooting, licenses', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }))
    window.shellApi = { openExternal }
    wrapper = mount(SettingsDialog, {
      props: { section: 'updates', updateStatus: { state: 'none', current: '1.16.0', checkedAt: Date.now() - 5 * 60e3 } },
      attachTo: document.body
    })
    expect(wrapper.get('#set-updates-title').text()).toBe('About & updates')
    expect(wrapper.get('.set-nav-item[data-page="updates"]').text()).toBe('About & updates')
    expect(wrapper.get('[data-test="about-version"]').text()).toBe('1.16.0')
    expect(wrapper.get('[data-test="update-status"]').text()).toMatch(/^You have the latest version · Last checked 5 min\.? ago$/)
    await wrapper.get('[data-test="update-check"]').trigger('click')
    expect(wrapper.emitted('check-updates')).toHaveLength(1)
    await wrapper.get('[data-test="update-notes"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/releases/tag/v1.16.0')
    // Logs and diagnostics: General's Troubleshooting group, opened from here.
    await wrapper.get('[data-test="about-troubleshooting"]').trigger('click')
    expect(wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))).toEqual(['general'])
    await wrapper.get('.set-nav-item[data-page="updates"]').trigger('click')
    await wrapper.get('[data-test="about-notices"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/blob/v1.16.0/THIRD_PARTY_NOTICES.md')
    // A failed check: one sentence, what went wrong behind Details.
    await wrapper.setProps({ updateStatus: { state: 'error', current: '1.16.0', message: 'net::ERR_NAME_NOT_RESOLVED' } })
    expect(wrapper.get('[data-test="update-status"]').text()).toBe('Could not check for updates. Try again later.')
    expect(wrapper.get('#set-updates details').text()).toContain('ERR_NAME_NOT_RESOLVED')
    // Ready: Restart and update, and the new version's notes.
    await wrapper.setProps({ updateStatus: { state: 'ready', current: '1.16.0', version: '1.17.0' } })
    await wrapper.get('[data-test="update-restart"]').trigger('click')
    expect(wrapper.emitted('open-update')).toHaveLength(1)
    await wrapper.get('[data-test="update-notes"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/releases/tag/v1.17.0')
  })

  it('search still finds the settings of the reworked pages', async () => {
    open('general')
    const shown = async (text) => {
      await wrapper.get('input[type="search"]').setValue(text)
      await nextTick()
      await nextTick()
      return wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))
    }
    expect(await shown('volume')).toEqual(['alerts'])
    expect(await shown('group order')).toEqual(['git'])
    expect(await shown('custom prefix')).toEqual(['git'])
    expect(await shown('release notes')).toEqual(['updates'])
    expect(await shown('third-party')).toEqual(['updates'])
    expect(await shown('press enter')).toEqual(['quick-commands'])
    expect(await shown('about')).toContain('updates')
  })

  it('search finds the new settings by their Orca names', async () => {
    open('general')
    await wrapper.get('input[type="search"]').setValue('trim gutter')
    await nextTick()
    await nextTick()
    const shownPages = wrapper.findAll('.set-page').filter((p) => !p.element.hidden)
    expect(shownPages.map((p) => p.attributes('data-page'))).toEqual(['terminal'])
  })
})
