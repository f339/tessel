// The update dialog (UpdateDialog.vue, releaseNotes.js): the release notes
// as formatted, sanitized text (GitHub's HTML, or the plain text read as
// markdown), a link to the release's page, and a close button.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateDialog from '../components/UpdateDialog.vue'
import { releaseNotesHtml } from '../releaseNotes'

const URL = 'https://github.com/mindkind1337/tessel/releases/tag/v1.17.0'
const status = (extra = {}) => ({ state: 'ready', version: '1.17.0', current: '1.16.0', ...extra })

afterEach(() => {
  delete window.shellApi
  document.body.innerHTML = ''
})

describe('release notes', () => {
  it("GitHub's HTML, sanitized: no script, no image loaded, no style", () => {
    const html = releaseNotesHtml(status({ notesHtml: '<h2>Fixes</h2><ul><li style="color:red">One</li></ul><img src="https://x.test/p.png"><script>alert(1)</script><a href="https://x.test">x</a>' }))
    expect(html).toContain('<h2>Fixes</h2>')
    expect(html).toContain('<li>One</li>')
    expect(html).not.toMatch(/script|style=|src=/)
    expect(html).toContain('rel="noreferrer"')
  })

  it('the plain text as markdown: its bullets a list; none at all, nothing', () => {
    const html = releaseNotesHtml(status({ notes: "What's new\n• Skills: one row per skill\n• Live Share: invitations" }))
    expect(html).toMatch(/<ul>\s*<li>Skills: one row per skill<\/li>\s*<li>Live Share: invitations<\/li>\s*<\/ul>/)
    expect(releaseNotesHtml(status())).toBe('')
  })
})

describe('UpdateDialog', () => {
  it('shows the notes formatted, opens the release page and links in the browser, and closes from its X', async () => {
    const openExternal = vi.fn()
    window.shellApi = { openExternal }
    const w = mount(UpdateDialog, { props: { status: status({ notesHtml: '<ul><li>One <a href="https://x.test/pr/1">#1</a></li></ul>' }), panes: 2, releaseUrl: URL }, attachTo: document.body })
    expect(w.find('[data-test="update-notes"] li').text()).toBe('One #1')
    expect(w.find('pre').exists()).toBe(false)
    await w.find('[data-test="update-release-notes"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith(URL)
    await w.find('[data-test="update-notes"] a').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://x.test/pr/1')
    await w.find('[data-test="update-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('while installing, the X waits like Later', () => {
    const w = mount(UpdateDialog, { props: { status: status(), installing: true }, attachTo: document.body })
    expect(w.find('[data-test="update-close"]').element.disabled).toBe(true)
    expect(w.find('[data-test="update-release-notes"]').exists()).toBe(false)
    w.unmount()
  })
})
