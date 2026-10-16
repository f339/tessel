// Resume a session (SessionsDialog.vue): Past conversations in a dialog, the
// same surface as the right side panel's tab (SessionHistoryPanel.vue): its
// scope, search, rows with one action each, row menu, session search.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, config } from '@vue/test-utils'
import { nextTick } from 'vue'
import SessionsDialog from '../components/SessionsDialog.vue'
import SessionHistoryPanel from '../components/SessionHistoryPanel.vue'
import { VIEW_STORAGE_KEY } from '../sessionHistory'

// Real <Transition>: the stub would wrap the teleported menus in an element.
config.global.stubs.transition = false

const NOW = Date.now()
const ROWS = [
  { agent: 'gemini', id: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: 'C:\\Project', title: 'Gemini login', updated: NOW - 60_000 },
  { agent: 'qwen', id: 'bbbbbbbb-1111-4222-8333-444444444444', cwd: 'C:\\Project', title: 'Qwen database', updated: NOW - 120_000 },
  { agent: 'opencode', id: 'cccccccc-1111-4222-8333-444444444444', cwd: 'D:\\Other', title: 'OpenCode layout', updated: NOW - 180_000 }
]

let wrapper
const previousApi = window.shellApi
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  window.shellApi = previousApi
  localStorage.removeItem(VIEW_STORAGE_KEY)
})

function api(extra = {}) {
  window.shellApi = { listSessions: vi.fn().mockResolvedValue(ROWS), writeClipboard: vi.fn(), ...extra }
  return window.shellApi
}
async function open(props = { cwd: 'C:\\Project' }) {
  wrapper = mount(SessionsDialog, { props, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
  await flushPromises()
  return wrapper
}
const rows = () => wrapper.findAll('[data-test="session-row"]')
const titles = () => rows().map((r) => r.find('.sh-row-title').text())
// A menu opens on the trigger's pointer down; its items are teleported to <body>.
async function openMenu(trigger) {
  await new Promise((r) => setTimeout(r, 30))
  trigger.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
  await nextTick()
  await nextTick()
}
const menuItem = (test) => Array.from(document.querySelectorAll(`[data-test="${test}"]`)).at(-1) || null

describe('Resume a session: Past conversations in a dialog', () => {
  it('is the side panel’s surface, with its title; the search takes the keyboard', async () => {
    api()
    await open()
    const panel = wrapper.findComponent(SessionHistoryPanel)
    expect(panel.exists()).toBe(true)
    expect(panel.props('embedded')).toBe(true)
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Past conversations')
    expect(wrapper.get('.sh-title-full').text()).toBe('Past conversations')
    expect(document.activeElement).toBe(wrapper.get('[data-test="session-query"]').element)
    // The scope is a segmented control: this workspace first, then all.
    expect(wrapper.get('[data-test="session-scopes"]').attributes('role')).toBe('group')
    expect(wrapper.get('[data-test="scope-workspace"]').attributes('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['Gemini login', 'Qwen database'])
    await wrapper.get('[data-test="scope-all"]').trigger('click')
    expect(titles()).toEqual(['Gemini login', 'Qwen database', 'OpenCode layout'])
    await wrapper.get('[data-test="session-query"]').setValue('database')
    expect(titles()).toEqual(['Qwen database'])
  })

  it('one action per row (Resume), no raw session id; Copy session ID is in the row menu', async () => {
    const shell = api()
    await open()
    for (const r of rows()) {
      expect(r.findAll('[data-test="session-resume"]')).toHaveLength(1)
      expect(r.find('.exit-btn.primary').exists()).toBe(false)
      expect(r.text()).not.toContain(r.attributes('data-session').slice(0, 8))
    }
    await rows()[0].get('[data-test="session-resume"]').trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[{ agent: 'gemini', id: ROWS[0].id, cwd: 'C:\\Project', title: 'Gemini login' }]])
    await openMenu(rows()[1].get('[data-test="session-more"]'))
    menuItem('menu-copy-id').click()
    expect(shell.writeClipboard).toHaveBeenCalledWith(ROWS[1].id)
    expect(wrapper.emitted('toast').at(-1)).toEqual(['Session ID copied'])
  })

  it('a conversation open in a pane: Go to its pane (show); its log opens in the editor', async () => {
    api()
    await open({ cwd: 'C:\\Project', openIds: { [ROWS[1].id]: 'pane-4' } })
    await rows()[1].get('[data-test="session-jump"]').trigger('click')
    expect(wrapper.emitted('show')).toEqual([['pane-4']])
    wrapper.findComponent(SessionHistoryPanel).vm.$emit('open-editor', 'C:\\h\\a.jsonl')
    expect(wrapper.emitted('open-editor')).toEqual([['C:\\h\\a.jsonl']])
  })

  it('Escape empties the search first, then closes; so do the close button and the backdrop', async () => {
    api()
    await open()
    const search = wrapper.get('[data-test="session-query"]')
    await search.setValue('gem')
    await search.trigger('keydown', { key: 'Escape' })
    expect(search.element.value).toBe('')
    expect(wrapper.emitted('close')).toBeUndefined()
    await search.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.get('[data-test="sessions-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
    await wrapper.get('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(3)
  })

  it('a conversation whose folder is unknown cannot be resumed; an Antigravity IDE one is continued in the CLI', async () => {
    api({
      listSessions: vi.fn().mockResolvedValue([
        { agent: 'gemini', id: 'dddddddd-1111-4222-8333-444444444444', cwd: '', title: 'Older conversation', updated: NOW - 1000 },
        { agent: 'antigravity', origin: 'ide', id: 'eeeeeeee-1111-4222-8333-444444444444', cwd: '', title: 'From the IDE', updated: NOW - 2000 }
      ])
    })
    await open({ cwd: null })
    const [lost, ide] = rows()
    expect(lost.get('[data-test="session-resume"]').attributes('disabled')).toBeDefined()
    const cont = ide.get('[data-test="session-resume"]')
    expect(cont.attributes('disabled')).toBeUndefined()
    expect(cont.attributes('aria-label')).toContain('folder is unknown')
    await cont.trigger('click')
    expect(wrapper.emitted('resume')[0][0]).toMatchObject({ agent: 'antigravity', origin: 'ide' })
  })
})

describe('Resume a session: session search (opt-in)', () => {
  function search(status, extra = {}) {
    let current = { available: true, enabled: false, phase: 'idle', filesIndexed: 0, filesDue: 0, sessions: 0, sizeBytes: 0, historyDays: 90, ...status }
    const s = {
      status: vi.fn(async () => current),
      enable: vi.fn(async () => {
        current = { ...current, enabled: true, phase: 'current', sessions: 12, sizeBytes: 3 * 1048576 }
        return { ok: true }
      }),
      disable: vi.fn(async () => {
        current = { ...current, enabled: false }
        return { ok: true }
      }),
      clear: vi.fn(async () => ({ ok: true })),
      setHistoryDays: vi.fn(async (days) => {
        current = { ...current, historyDays: days }
        return { ok: true }
      }),
      search: vi.fn(async () => ({ ok: true, hits: [] })),
      ...extra
    }
    api({ sessionSearch: s })
    return s
  }

  it('off: a query offers it in one line, what the index keeps behind Learn more; Turn on', async () => {
    const s = search()
    await open()
    expect(wrapper.find('[data-test="session-notice"]').exists()).toBe(false)
    await wrapper.get('[data-test="session-query"]').setValue('login')
    const notice = wrapper.get('[data-test="session-notice"]')
    expect(notice.get('p').text()).toBe('Find a conversation by what was said in it: turn on session search.')
    const more = notice.get('[data-test="session-consent-more"]')
    expect(more.element.open).toBe(false)
    // What the index is, plainly: full text (pasted keys included), not encrypted, kept until cleared.
    expect(more.text()).toContain('nothing is sent anywhere')
    expect(more.text()).toContain('full text of the conversations, including what was pasted')
    expect(more.text()).toContain('not encrypted')
    expect(more.text()).toContain('until you clear it')
    expect(s.search).not.toHaveBeenCalled()
    expect(titles()).toEqual(['Gemini login'])
    await notice.get('[data-test="session-enable-search"]').trigger('click')
    await flushPromises()
    expect(s.enable).toHaveBeenCalled()
  })

  it('on: a result shows its passage, matches marked and secrets masked, and resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = search(
        { enabled: true, phase: 'current', sessions: 3 },
        {
          search: vi.fn(async () => ({
            ok: true,
            hits: [
              {
                agent: 'codex',
                sessionId: 'ffffffff-1111-4222-8333-444444444444',
                title: 'Deploy with token=abcdef0123456789abcdef0123456789',
                cwd: 'C:\\Project\\sub',
                updatedAt: NOW - 3_600_000,
                messageCount: 14,
                evidence: { snippet: 'the \uE000release\uE001 <b>notes</b> use Bearer abcdef0123456789abcdef0123456789abcd', role: 'assistant' }
              }
            ]
          }))
        }
      )
      await open()
      await wrapper.get('[data-test="session-query"]').setValue('release')
      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      expect(s.search).toHaveBeenLastCalledWith({ query: 'release', scope: { kind: 'folder', path: 'C:\\Project' }, agents: null, limit: 40 })
      const hit = rows()[0]
      expect(hit.get('mark').text()).toBe('release')
      expect(hit.find('b').exists()).toBe(false)
      expect(hit.text()).toContain('<b>notes</b>')
      expect(hit.text()).not.toContain('abcdef0123456789')
      await hit.get('[data-test="session-resume"]').trigger('click')
      expect(wrapper.emitted('resume')[0][0]).toMatchObject({ agent: 'codex', id: 'ffffffff-1111-4222-8333-444444444444', cwd: 'C:\\Project\\sub' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('on: the view menu says how the index is, keeps less, clears it and turns it off', async () => {
    const s = search({ enabled: true, phase: 'current', sessions: 412, sizeBytes: 38 * 1048576 })
    await open()
    await openMenu(wrapper.get('[data-test="session-view"]'))
    expect(menuItem('index-status').textContent).toBe('Index up to date: 412 conversations (38 MB)')
    expect(menuItem('index-keep').textContent).toContain('Keep: Last 90 days')
    menuItem('index-keep').click()
    await nextTick()
    await nextTick()
    menuItem('keep-30').click()
    await flushPromises()
    expect(s.setHistoryDays).toHaveBeenCalledWith(30)
    await openMenu(wrapper.get('[data-test="session-view"]'))
    menuItem('index-clear').click()
    await flushPromises()
    expect(s.clear).toHaveBeenCalled()
    await openMenu(wrapper.get('[data-test="session-view"]'))
    menuItem('index-disable').click()
    await flushPromises()
    expect(s.disable).toHaveBeenCalled()
  })

  it('off: Turn on… in the view menu shows the offer without a query (Not now hides it); an index left can be cleared', async () => {
    const s = search({ sizeBytes: 7 * 1048576 })
    await open()
    await openMenu(wrapper.get('[data-test="session-view"]'))
    expect(menuItem('index-clear').textContent).toContain('Clear the index left (7 MB)')
    menuItem('index-clear').click()
    await flushPromises()
    expect(s.clear).toHaveBeenCalled()
    await openMenu(wrapper.get('[data-test="session-view"]'))
    menuItem('index-enable').click()
    await flushPromises()
    expect(wrapper.get('[data-test="session-notice"]').text()).toContain('turn on session search')
    await wrapper.get('[data-test="session-consent-cancel"]').trigger('click')
    expect(wrapper.find('[data-test="session-notice"]').exists()).toBe(false)
  })

  it('no search bridge (an older main process): the list as before, no session search in the menu', async () => {
    api()
    await open()
    expect(titles()).toEqual(['Gemini login', 'Qwen database'])
    await openMenu(wrapper.get('[data-test="session-view"]'))
    expect(menuItem('index-enable')).toBe(null)
  })
})
