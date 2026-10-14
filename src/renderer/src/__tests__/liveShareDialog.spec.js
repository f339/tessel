// Live Share's dialogs: Share / Join (LiveShareDialog.vue) and the prompt
// when someone asks to join (LiveShareAsk.vue), against a fake
// window.shellApi.liveShare (src/preload: liveShare).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import LiveShareAsk from '../components/LiveShareAsk.vue'

const OFF_HOST = { state: 'off', invite: null, expiresAt: null, projectIds: [], guests: [], progress: null, error: null }
const OFF_GUEST = { state: 'off', host: null, session: null, panes: [], projects: [], reason: null, rights: null, code: null }
const PROJECTS = { projects: [{ id: 'ws-1', name: 'tessel' }, { id: 'ws-2', name: 'site' }], projectIds: ['ws-1'] }

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
    setGuestRight: vi.fn().mockResolvedValue({ ok: true }),
    setGuestProject: vi.fn().mockResolvedValue({ ok: true }),
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
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'] })
    wrapper.unmount()
  })

  it('shares the projects you tick, and needs one', async () => {
    const wrapper = await open(PROJECTS)
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').element.checked).toBe(true)
    expect(box('ws-2').element.checked).toBe(false)
    expect(wrapper.find('[data-test="ls-projects"]').text()).toContain('Projects to share')
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    box('ws-1').element.checked = false
    await box('ws-1').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([
      ['ws-2', true],
      ['ws-1', false]
    ])
    // Two ticked: both go with the start.
    await wrapper.setProps({ projectIds: ['ws-1', 'ws-2'] })
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1', 'ws-2'] })
    wrapper.unmount()
    const none = await open({ projects: PROJECTS.projects, projectIds: [] })
    expect(none.find('[data-test="ls-start"]').attributes('disabled')).toBeDefined()
    expect(none.find('[data-test="ls-need-project"]').text()).toBe('Tick at least one project.')
    none.unmount()
    const empty = await open({ projects: [], projectIds: [] })
    expect(empty.find('[data-test="ls-start"]').attributes('disabled')).toBeDefined()
    expect(empty.text()).toContain('No project to share')
    empty.unmount()
  })

  it('while sharing: projects ticked or not on the spot, the last one stays, and each guest sees the ones turned on for them', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1'] })
    const guests = [
      { id: 'g1', name: 'Bob', state: 'joined', since: 1, rights: { type: false, open: false, close: false }, projects: ['ws-1'] },
      { id: 'g2', name: 'Eve', state: 'waiting', since: 2, code: '123 456', projects: [] }
    ]
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, projectIds: ['ws-1'], guests })
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    // The only project shared: it can't be unticked here.
    expect(box('ws-1').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-last-project"]').text()).toBe('To stop sharing your last project, use Stop sharing.')
    expect(wrapper.find('[data-test="ls-projects"]').text()).toContain('Projects you share (tick or untick at any time)')
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    // Main says both are shared now.
    await wrapper.setProps({ projectIds: ['ws-1', 'ws-2'] })
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, projectIds: ['ws-1', 'ws-2'], guests })
    expect(box('ws-1').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-test="ls-last-project"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-added-note"]').text()).toContain('A project you share later stays off for guests already in')
    // Bob sees ws-1, not ws-2 (shared after he came in); Eve, still waiting, has no such buttons.
    const chip = (p, g) => wrapper.find(`[data-test="ls-sees-${p}-${g}"]`)
    expect(chip('ws-1', 'g1').attributes('aria-pressed')).toBe('true')
    expect(chip('ws-2', 'g1').attributes('aria-pressed')).toBe('false')
    expect(chip('ws-1', 'g2').exists()).toBe(false)
    // Each click is one change (main makes it against what Bob has then).
    await chip('ws-2', 'g1').trigger('click')
    expect(api.setGuestProject).toHaveBeenLastCalledWith({ guestId: 'g1', project: 'ws-2', on: true })
    await chip('ws-1', 'g1').trigger('click')
    expect(api.setGuestProject).toHaveBeenLastCalledWith({ guestId: 'g1', project: 'ws-1', on: false })
    box('ws-1').element.checked = false
    await box('ws-1').trigger('change')
    expect(wrapper.emitted('toggle-project').at(-1)).toEqual(['ws-1', false])
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
    expect(api.setGuestRight).toHaveBeenCalledWith({ guestId: 'g1', right: 'type', on: true })
    await wrapper.find('[data-test="ls-right-open-g1"]').trigger('click')
    expect(api.setGuestRight).toHaveBeenLastCalledWith({ guestId: 'g1', right: 'open', on: false })
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
    expect(wrapper.find('[data-test="ls-joined"]').text()).toContain('Live Share project in the sidebar')
    expect(wrapper.find('[data-test="ls-no-projects"]').text()).toBe('Ada has not given you a project to see yet.')
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch. The host has not let you type yet.')
    await guest({ state: 'joined', host: 'Ada', projects: [{ id: 'ws-a', layout: null }], rights: { type: true, open: true, close: false } })
    expect(wrapper.find('[data-test="ls-no-projects"]').exists()).toBe(false)
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

  const bob = { kind: 'join', key: 'g1', guestId: 'g1', name: 'Bob', code: '123 456' }

  it('names who asks, the project, the code to check, and takes the keyboard on the card (not a button)', async () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: [{ id: 'ws-1', name: 'tessel' }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Bob wants to join your Live Share')
    expect(wrapper.text()).toContain('They will see tessel live. They can only watch until you let them type')
    expect(wrapper.find('[data-test="ls-ask-code"]').text()).toContain('123 456')
    // Keys typed for something else (Enter, Space) answer nothing.
    expect(document.activeElement).toBe(wrapper.find('[data-test="live-share-ask"]').element)
    wrapper.unmount()
  })

  it('Allow only answers after a moment; Allow and Deny answer that ask; Escape or a click beside it do not', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: [{ id: 'ws-1', name: 'tessel' }] } })
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
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-1'] }], [{ key: 'g1', yes: false, projects: ['ws-1'] }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a guest without a name is "A guest"', () => {
    const wrapper = mount(LiveShareAsk, { props: { ask: { ...bob, name: '' } } })
    expect(wrapper.text()).toContain('A guest wants to join your Live Share')
  })

  it('with several projects shared: you tick what the guest sees (all at first, one at least)', async () => {
    vi.useFakeTimers()
    try {
      const projects = [
        { id: 'ws-1', name: 'tessel' },
        { id: 'ws-2', name: 'site' },
        { id: 'ws-3', name: 'api' }
      ]
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects } })
      expect(wrapper.text()).toContain('Tick what they will see live')
      const box = (id) => wrapper.find(`[data-test="ls-ask-project-${id}"] input`)
      expect(projects.map((p) => box(p.id).element.checked)).toEqual([true, true, true])
      vi.advanceTimersByTime(1000)
      await nextTick()
      await box('ws-2').trigger('change')
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-1', 'ws-3'] }]])
      // None ticked: Allow waits, and says why.
      await box('ws-1').trigger('change')
      await box('ws-3').trigger('change')
      expect(wrapper.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-test="ls-ask-need-project"]').text()).toBe('Tick at least one project to allow them in.')
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toHaveLength(1)
      // The next guest asking starts with everything ticked again.
      await wrapper.setProps({ ask: { ...bob, key: 'g2', guestId: 'g2', name: 'Eve' } })
      expect(projects.map((p) => box(p.id).element.checked)).toEqual([true, true, true])
      await wrapper.find('[data-test="ls-ask-deny"]').trigger('click')
      expect(wrapper.emitted('answer').at(-1)).toEqual([{ key: 'g2', yes: false, projects: ['ws-1', 'ws-2', 'ws-3'] }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('with one project shared: nothing to tick, that project is given', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: [{ id: 'ws-1', name: 'tessel' }] } })
      expect(wrapper.find('[data-test="ls-ask-projects"]').exists()).toBe(false)
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-1'] }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('no project listed yet (a share taken back after a restart): Allow waits, and says why', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: [] } })
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-test="ls-ask-no-projects"]').text()).toBe('Tessel is still finding the projects you share: wait a moment to allow them in.')
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toBeUndefined()
      // They come: ticked (the first ones listed), and Allow waits a moment again.
      await wrapper.setProps({ projects: [{ id: 'ws-1', name: 'tessel' }] })
      expect(wrapper.find('[data-test="ls-ask-no-projects"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-1'] }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a project shared while it waits comes unticked, your own ticks stay, and Allow waits a moment again', async () => {
    vi.useFakeTimers()
    try {
      const two = [
        { id: 'ws-1', name: 'tessel' },
        { id: 'ws-2', name: 'site' }
      ]
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: two } })
      const box = (id) => wrapper.find(`[data-test="ls-ask-project-${id}"] input`)
      vi.advanceTimersByTime(1000)
      await nextTick()
      await box('ws-2').trigger('change') // unticked by you
      await wrapper.setProps({ projects: [...two, { id: 'ws-3', name: 'api' }] })
      expect([box('ws-1'), box('ws-2'), box('ws-3')].map((b) => b.element.checked)).toEqual([true, false, false])
      // The list changed under the pointer: a click right away is not a yes.
      expect(wrapper.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toBeUndefined()
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-1'] }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('one project left, unticked: it can be ticked (Allow waits until it is)', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mount(LiveShareAsk, { props: { ask: bob, projects: [{ id: 'ws-1', name: 'tessel' }, { id: 'ws-2', name: 'site' }] } })
      vi.advanceTimersByTime(1000)
      await nextTick()
      await wrapper.find('[data-test="ls-ask-project-ws-2"] input').trigger('change')
      await wrapper.setProps({ projects: [{ id: 'ws-2', name: 'site' }] })
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.find('[data-test="ls-ask-projects"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
      await wrapper.find('[data-test="ls-ask-project-ws-2"] input').trigger('change')
      await wrapper.find('[data-test="ls-ask-allow"]').trigger('click')
      expect(wrapper.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-2'] }]])
    } finally {
      vi.useRealTimers()
    }
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

describe('LiveShareDialog: what the review found', () => {
  it('says when the code is blocked, and names a guest without a name', async () => {
    const wrapper = await open(PROJECTS)
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, inviteBlocked: true, guests: [{ id: 'g1', name: '', state: 'joined', since: 1, rights: { type: false, open: false, close: false } }] })
    expect(wrapper.find('[data-test="ls-blocked"]').text()).toContain('no longer lets anyone in')
    expect(wrapper.find('[data-test="ls-guest-g1"]').text()).toContain('A guest')
    wrapper.unmount()
  })

  it('lists guests let in who are offline, with Remove', async () => {
    api.removeKnown = vi.fn().mockResolvedValue({ ok: true })
    const wrapper = await open(PROJECTS)
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, guests: [], offline: [{ id: 'k-abc', name: 'Alex', rights: { type: true, open: false, close: false } }] })
    expect(wrapper.find('[data-test="ls-offline-k-abc"]').text()).toContain('Offline: comes back by itself')
    expect(wrapper.text()).not.toContain('No one has joined yet.')
    await wrapper.find('[data-test="ls-remove-known-k-abc"]').trigger('click')
    expect(api.removeKnown).toHaveBeenCalledWith({ id: 'k-abc' })
    wrapper.unmount()
  })

  it('a guest offline: what it may do and sees can change too (it comes back with it)', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, projectIds: ['ws-1', 'ws-2'], guests: [], offline: [{ id: 'k-abc', name: 'Alex', rights: { type: true, open: false, close: false }, projects: ['ws-1', 'ws-2'] }] })
    expect(wrapper.find('[data-test="ls-right-type-k-abc"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="ls-sees-ws-1-k-abc"]').attributes('aria-pressed')).toBe('true')
    await wrapper.find('[data-test="ls-sees-ws-1-k-abc"]').trigger('click')
    expect(api.setGuestProject).toHaveBeenCalledWith({ guestId: 'k-abc', project: 'ws-1', on: false })
    await wrapper.find('[data-test="ls-right-type-k-abc"]').trigger('click')
    expect(api.setGuestRight).toHaveBeenCalledWith({ guestId: 'k-abc', right: 'type', on: false })
    wrapper.unmount()
  })

  it('a change that could not be made says so; a click while its change is on its way does nothing', async () => {
    let answer
    api.setGuestProject = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host({ state: 'sharing', invite: 'TS1.x', expiresAt: Date.now() + 3600000, projectIds: ['ws-1', 'ws-2'], guests: [{ id: 'g1', name: 'Bob', state: 'joined', since: 1, rights: { type: false, open: false, close: false }, projects: ['ws-1'] }] })
    const chip = wrapper.find('[data-test="ls-sees-ws-1-g1"]')
    await chip.trigger('click')
    await chip.trigger('click')
    expect(api.setGuestProject).toHaveBeenCalledTimes(1)
    answer({ ok: false })
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('That change could not be made (the guest may have left or been removed).')
    // Done: the next click goes (and the notice with it).
    await chip.trigger('click')
    expect(api.setGuestProject).toHaveBeenCalledTimes(2)
    answer({ ok: true })
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').exists()).toBe(false)
    api.setGuestRight.mockRejectedValueOnce(new Error('gone'))
    await wrapper.find('[data-test="ls-right-type-g1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('an end reason the host made up shows as the session ended (none breaks the dialog)', async () => {
    const wrapper = await open({ initialTab: 'join' })
    for (const reason of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'made-up']) {
      await guest({ state: 'ended', host: 'Ada', reason })
      expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The session ended.')
    }
    await guest({ state: 'ended', host: 'Ada', reason: 'removed' })
    expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The host removed you from the session.')
    wrapper.unmount()
  })

  it('says it is reconnecting, and Leave still works', async () => {
    const wrapper = await open({ initialTab: 'join' })
    await guest({ state: 'reconnecting', host: 'Ada' })
    expect(wrapper.find('[data-test="ls-reconnecting"]').text()).toBe('Connection lost: reconnecting to Ada…')
    await wrapper.find('[data-test="ls-leave"]').trigger('click')
    expect(api.leave).toHaveBeenCalled()
    wrapper.unmount()
  })
})
