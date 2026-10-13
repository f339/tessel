// Live Share's dialogs: Share / Join (LiveShareDialog.vue) and the prompt
// when someone asks to join (LiveShareAsk.vue), against a fake
// window.shellApi.liveShare (src/preload: liveShare).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import LiveShareAsk from '../components/LiveShareAsk.vue'

const OFF_HOST = { state: 'off', invite: null, expiresAt: null, guests: [], progress: null, error: null }
const OFF_GUEST = { state: 'off', host: null, session: null, panes: [], layout: null, reason: null, rights: null, code: null }
const PROJECTS = { projects: [{ id: 'ws-1', name: 'tessel' }, { id: 'ws-2', name: 'site' }], projectId: 'ws-1' }

let api
let push
let offs
beforeEach(() => {
  push = {}
  offs = []
  const on = (name) => (cb) => {
    push[name] = cb
    const off = vi.fn()
    offs.push(off)
    return off
  }
  api = {
    state: vi.fn().mockResolvedValue({ host: OFF_HOST, guest: OFF_GUEST, defaultName: 'ada' }),
    start: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    approve: vi.fn().mockResolvedValue({ ok: true }),
    setRights: vi.fn().mockResolvedValue({ ok: true }),
    newInvite: vi.fn().mockResolvedValue({ ok: true, state: 'sharing', invite: 'TS1.new', expiresAt: Date.now() + 3600000, guests: [] }),
    removeGuest: vi.fn().mockResolvedValue({ ok: true }),
    join: vi.fn().mockResolvedValue({ ok: true }),
    leave: vi.fn().mockResolvedValue({ ok: true }),
    onHost: on('host'),
    onGuest: on('guest'),
    onAsk: on('ask')
  }
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function open(props = {}) {
  const wrapper = mount(LiveShareDialog, { props: { open: true, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
async function host(status) {
  push.host({ ...OFF_HOST, ...status })
  await flushPromises()
}
async function guest(status) {
  push.guest({ ...OFF_GUEST, ...status })
  await flushPromises()
}

describe('LiveShareDialog: Share', () => {
  it('warns before sharing, then starts with the name', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.find('[data-test="ls-share-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('run any command on this PC as you')
    expect(wrapper.text()).toContain('then can only watch')
    expect(wrapper.find('[data-test="ls-share-name"]').element.value).toBe('ada')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada' })
    wrapper.unmount()
  })

  it('shares the project you pick, and needs one', async () => {
    const wrapper = await open(PROJECTS)
    const select = wrapper.find('[data-test="ls-project"]')
    expect(select.element.value).toBe('ws-1')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['tessel', 'site'])
    await select.setValue('ws-2')
    expect(wrapper.emitted('update:projectId')).toEqual([['ws-2']])
    wrapper.unmount()
    const none = await open({ projects: [], projectId: null })
    expect(none.find('[data-test="ls-start"]').attributes('disabled')).toBeDefined()
    none.unmount()
  })

  it('says how far it got: download, start, address check', async () => {
    const wrapper = await open()
    await host({ state: 'preparing', progress: 0.424 })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Downloading the Cloudflare tunnel… 42%')
    await host({ state: 'preparing', progress: null })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Getting the Cloudflare tunnel ready…')
    await host({ state: 'starting' })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Starting…')
    await host({ state: 'checking' })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Checking the address…')
    await wrapper.find('[data-test="ls-cancel-share"]').trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows the code to copy, the guests, and stops', async () => {
    const wrapper = await open(PROJECTS)
    await host({
      state: 'sharing',
      invite: 'tessel-ls:abc',
      expiresAt: Date.now() + 3600000,
      guests: [
        { id: 'g1', name: 'Bob', state: 'joined', since: 1, rights: { type: false, open: true, close: false } },
        { id: 'g2', name: 'Eve', state: 'waiting', since: 2, code: '123 456' }
      ]
    })
    expect(wrapper.find('[data-test="ls-invite"]').element.value).toBe('tessel-ls:abc')
    expect(wrapper.find('[data-test="ls-invite"]').attributes('readonly')).toBeDefined()
    await wrapper.find('[data-test="ls-copy"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('tessel-ls:abc')
    expect(wrapper.find('[data-test="ls-copy"]').text()).toBe('Copied')
    expect(wrapper.find('[data-test="ls-guest-g1"]').text()).toContain('Bob')
    expect(wrapper.find('[data-test="ls-guest-g2"]').text()).toContain('Waiting for your answer (code 123 456)')
    // What Bob may do: each right on its own.
    expect(wrapper.find('[data-test="ls-right-type-g1"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-test="ls-right-open-g1"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="ls-right-type-g2"]').exists()).toBe(false)
    await wrapper.find('[data-test="ls-right-type-g1"]').trigger('click')
    expect(api.setRights).toHaveBeenCalledWith({ guestId: 'g1', rights: { type: true, open: true, close: false } })
    await wrapper.find('[data-test="ls-remove-g2"]').trigger('click')
    expect(api.removeGuest).toHaveBeenCalledWith({ guestId: 'g2' })
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('says until when the code works, and makes a new one', async () => {
    const wrapper = await open(PROJECTS)
    await host({ state: 'sharing', invite: 'TS1.old', expiresAt: Date.now() + 3600000 })
    expect(wrapper.find('[data-test="ls-expiry"]').text()).toContain('New guests can join with it until')
    await wrapper.find('[data-test="ls-new-code"]').trigger('click')
    await flushPromises()
    expect(api.newInvite).toHaveBeenCalled()
    expect(wrapper.find('[data-test="ls-invite"]').element.value).toBe('TS1.new')
    await host({ state: 'sharing', invite: 'TS1.old', expiresAt: Date.now() - 1000 })
    expect(wrapper.find('[data-test="ls-expiry"]').text()).toContain('This code expired')
    expect(wrapper.find('[data-test="ls-copy"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('shows why sharing failed', async () => {
    api.start.mockResolvedValue({ ok: false, error: 'No internet.' })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('No internet.')
    await host({ state: 'error', error: 'The tunnel stopped.' })
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('The tunnel stopped.')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: Join', () => {
  it('joins with the code and the name, and follows the session', async () => {
    const wrapper = await open({ initialTab: 'join' })
    expect(wrapper.find('[data-test="ls-join"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="ls-join-invite"]').setValue('  tessel-ls:xyz  ')
    await wrapper.find('[data-test="ls-join-name"]').setValue('Bob')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    expect(api.join).toHaveBeenCalledWith({ invite: 'tessel-ls:xyz', name: 'Bob' })
    await guest({ state: 'connecting' })
    expect(wrapper.find('[data-test="ls-connecting"]').text()).toBe('Connecting…')
    await guest({ state: 'waiting', code: '123 456' })
    expect(wrapper.find('[data-test="ls-waiting"]').text()).toBe('Waiting for the host to accept…')
    expect(wrapper.find('[data-test="ls-code"]').text()).toBe('Your code is 123 456. Tell your host, so they know it is you.')
    await guest({ state: 'joined', host: 'Ada', rights: { type: false, open: false, close: false } })
    expect(wrapper.find('[data-test="ls-joined"]').text()).toContain('Ada')
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch. The host has not let you type yet.')
    await guest({ state: 'joined', host: 'Ada', rights: { type: true, open: true, close: false } })
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch and type in its terminals and agents, open terminals and agents.')
    await wrapper.find('[data-test="ls-leave"]').trigger('click')
    expect(api.leave).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('says why the session ended, and offers to join again', async () => {
    const wrapper = await open({ initialTab: 'join' })
    await guest({ state: 'waiting' })
    await guest({ state: 'ended', host: 'Ada', reason: 'denied' })
    expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The host said no.')
    expect(wrapper.find('[data-test="ls-join-invite"]').exists()).toBe(true)
    await guest({ state: 'ended', reason: 'refused' })
    expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The invite code is not valid any more.')
    wrapper.unmount()
  })

  it('shows a code that is not an invite', async () => {
    api.join.mockResolvedValue({ ok: false, error: 'This is not a Tessel Live Share invite code.' })
    const wrapper = await open({ initialTab: 'join' })
    await wrapper.find('[data-test="ls-join-invite"]').setValue('hello')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-join-error"]').text()).toBe('This is not a Tessel Live Share invite code.')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: keyboard and lifetime', () => {
  it('Escape and the backdrop close it; closing does not stop sharing', async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="live-share-dialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.find('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(api.stop).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('opens on its card and stops listening once gone', async () => {
    const wrapper = await open()
    expect(document.activeElement).toBe(wrapper.find('[data-test="live-share-dialog"]').element)
    wrapper.unmount()
    expect(offs).toHaveLength(2)
    for (const off of offs) expect(off).toHaveBeenCalled()
  })

  it('says so when this version has no Live Share', async () => {
    window.shellApi = {}
    const wrapper = await open()
    expect(wrapper.text()).toContain('Live Share is not available in this version.')
    wrapper.unmount()
  })
})

describe('LiveShareAsk', () => {
  it('shows nothing while no one is waiting', () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: null } })
    expect(wrapper.find('[data-test="live-share-ask"]').exists()).toBe(false)
  })

  const bob = { kind: 'join', key: 'g1', guestId: 'g1', name: 'Bob', code: '123 456', forward: true }

  it('names who asks, the project, the code to check, and starts on Deny', async () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: bob, project: 'tessel' }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Bob wants to join your Live Share')
    expect(wrapper.text()).toContain('They will see tessel live. They can only watch until you let them type')
    expect(wrapper.find('[data-test="ls-ask-code"]').text()).toContain('123 456')
    expect(wrapper.find('[data-test="ls-ask-old"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('[data-test="ls-ask-deny"]').element)
    wrapper.unmount()
  })

  it('says when the guest Tessel is older (no forward secrecy)', () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { ...bob, forward: false } } })
    expect(wrapper.find('[data-test="ls-ask-old"]').text()).toContain('encrypted with the invite code only')
  })

  it('Allow only answers after a moment; Allow, Deny and Escape answer that ask; a click beside it does not', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(LiveShareAsk, { props: { ask: bob } })
      await wrapper.find('.help-backdrop').trigger('pointerdown')
      expect(wrapper.emitted('answer')).toBeUndefined()
      // Too soon: a click meant for something else.
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toBeUndefined()
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      await wrapper.find('[data-test="ls-ask-deny"]').trigger('click')
      await wrapper.find('[data-test="live-share-ask"]').trigger('keydown', { key: 'Escape' })
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true }], [{ key: 'g1', yes: false }], [{ key: 'g1', yes: false }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a guest without a name is "A guest"', () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { ...bob, name: '' } } })
    expect(wrapper.text()).toContain('A guest wants to join your Live Share')
  })

  it('asks before a guest closes an agent or a busy terminal: Keep it or Close it', async () => {
    vi.useFakeTimers()
    try {
      const ask = { kind: 'close', key: 'close-pane-1', guestId: 'g1', name: 'Bob', paneId: 'pane-1', paneName: 'Claude Code', detail: 'Its agent session ends.' }
      const wrapper = mount(LiveShareAsk, { props: { ask } })
      expect(wrapper.text()).toContain('Bob wants to close Claude Code')
      expect(wrapper.text()).toContain('Its agent session ends.')
      expect(wrapper.find('[data-test="ls-ask-deny"]').text()).toBe('Keep it')
      expect(wrapper.find('[data-test="ls-ask-allow"]').text()).toBe('Close it')
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'close-pane-1', yes: true }]])
    } finally {
      vi.useRealTimers()
    }
  })
})
