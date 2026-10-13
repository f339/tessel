// Live Share's dialogs: Share / Join (LiveShareDialog.vue) and the prompt
// when someone asks to join (LiveShareAsk.vue), against a fake
// window.shellApi.liveShare (src/preload: liveShare).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import LiveShareAsk from '../components/LiveShareAsk.vue'

const OFF_HOST = { state: 'off', invite: null, guests: [], progress: null, error: null }
const OFF_GUEST = { state: 'off', host: null, session: null, panes: [], layout: null, reason: null }

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
    const wrapper = await open()
    expect(wrapper.find('[data-test="ls-share-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('run any command on this PC as you')
    expect(wrapper.find('[data-test="ls-share-name"]').element.value).toBe('ada')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada' })
    wrapper.unmount()
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
    const wrapper = await open()
    await host({
      state: 'sharing',
      invite: 'tessel-ls:abc',
      guests: [
        { id: 'g1', name: 'Bob', state: 'joined', since: 1 },
        { id: 'g2', name: 'Eve', state: 'waiting', since: 2 }
      ]
    })
    expect(wrapper.find('[data-test="ls-invite"]').element.value).toBe('tessel-ls:abc')
    expect(wrapper.find('[data-test="ls-invite"]').attributes('readonly')).toBeDefined()
    await wrapper.find('[data-test="ls-copy"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('tessel-ls:abc')
    expect(wrapper.find('[data-test="ls-copy"]').text()).toBe('Copied')
    expect(wrapper.find('[data-test="ls-guest-g1"]').text()).toContain('Bob')
    expect(wrapper.find('[data-test="ls-guest-g1"]').text()).toContain('Joined')
    expect(wrapper.find('[data-test="ls-guest-g2"]').text()).toContain('Waiting for your answer')
    await wrapper.find('[data-test="ls-remove-g2"]').trigger('click')
    expect(api.removeGuest).toHaveBeenCalledWith({ guestId: 'g2' })
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows why sharing failed', async () => {
    api.start.mockResolvedValue({ ok: false, error: 'No internet.' })
    const wrapper = await open()
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
    await guest({ state: 'waiting' })
    expect(wrapper.find('[data-test="ls-waiting"]').text()).toBe('Waiting for the host to accept…')
    await guest({ state: 'joined', host: 'Ada' })
    expect(wrapper.find('[data-test="ls-joined"]').text()).toContain('Ada')
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

  it('names who asks and starts on Deny', async () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { guestId: 'g1', name: 'Bob' } }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Bob wants to join your Live Share')
    expect(wrapper.text()).toContain('They will see your screen and can type in your terminals and agents.')
    expect(document.activeElement).toBe(wrapper.find('[data-test="ls-ask-deny"]').element)
    wrapper.unmount()
  })

  it('Allow, Deny and Escape answer; a click beside it does not', async () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { guestId: 'g1', name: 'Bob' } } })
    await wrapper.find('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('answer')).toBeUndefined()
    await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
    await wrapper.find('[data-test="ls-ask-deny"]').trigger('click')
    await wrapper.find('[data-test="live-share-ask"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('answer')).toEqual([[true], [false], [false]])
  })

  it('a guest without a name is "A guest"', () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { guestId: 'g1', name: '' } } })
    expect(wrapper.text()).toContain('A guest wants to join your Live Share')
  })
})
