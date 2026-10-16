// Live Share's People, Trusted and Access sections (liveshare/LsPeople.vue,
// LsTrusted.vue, LsAccess.vue): live edits of what each person sees and may
// do, trust, removal (a trusted person: asked whether to stop trusting too),
// trusted people edited while offline or not sharing, the people x projects
// grid, one project's people, and an invitation's change made for the people
// who joined with it or not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import { RIGHT_IDS, NO_RIGHTS } from '../../../shared/liveShareRights'
import { fakeApi, OFF_HOST, OFF_GUEST, invite, guest, trustedOne, sharing } from './liveShareFakes'

const PROJECTS = [
  { id: 'ws-1', name: 'tessel' },
  { id: 'ws-2', name: 'site' },
  { id: 'ws-3', name: 'notes' }
]

let api
let push
beforeEach(() => {
  ;({ api, push } = fakeApi())
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function openAt(section, host, extra = {}) {
  api.state.mockResolvedValue({ host, guest: OFF_GUEST, defaultName: 'ada' })
  const wrapper = mount(LiveShareDialog, { props: { open: true, initialSection: section, projects: PROJECTS, projectIds: host.projectIds || [], paneTitle: (id) => (id === 'pane-1' ? 'Claude Code' : ''), ...extra }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const tick = async (w, sel) => {
  const box = w.find(sel)
  box.element.checked = !box.element.checked
  await box.trigger('change')
  await flushPromises()
}

describe('Live Share: People', () => {
  it('an empty state until someone asks', async () => {
    const w = await openAt('people', sharing())
    expect(w.find('[data-test="ls-people-empty"]').text()).toContain('No one has joined yet')
    w.unmount()
  })

  it('each person with their invitation, what they watch, their projects and rights as boxes', async () => {
    const w = await openAt(
      'people',
      sharing({
        guests: [guest({ rights: { ...NO_RIGHTS, type: false, open: true, close: false } }), guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })],
        offline: [{ id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: true, open: false, close: false }, projects: ['ws-2'], invite: { id: null, label: 'Old' }, trusted: false, trustable: false }],
        presence: [{ id: 'pane-1', guests: [{ id: 'g1', watching: true, typing: false, reading: false }] }]
      })
    )
    const bob = w.find('[data-test="ls-guest-g1"]')
    expect(bob.text()).toContain('Came with Simpa')
    expect(bob.text()).toContain('Watching Claude Code')
    expect(w.find('[data-test="ls-proj-ws-1-g1"] input').element.checked).toBe(true)
    expect(w.find('[data-test="ls-proj-ws-2-g1"] input').element.checked).toBe(false)
    expect(w.find('[data-test="ls-right-open-g1"] input').element.checked).toBe(true)
    // Every right of the catalog is a box (and nothing else).
    expect(bob.findAll('[data-test^="ls-right-"]').map((x) => x.attributes('data-test'))).toEqual(RIGHT_IDS.map((id) => `ls-right-${id}-g1`))
    expect(w.find('[data-test="ls-waiting-g2"]').text()).toContain('Waiting for your answer (code 123 456)')
    const alex = w.find('[data-test="ls-offline-k-abc"]')
    expect(alex.text()).toContain('Offline: comes back by itself')
    expect(alex.text()).toContain('Came with Old (no longer exists)')
    // An older Tessel can't be trusted.
    expect(w.find('[data-test="ls-person-trust-k-abc"]').exists()).toBe(false)
    w.unmount()
  })

  it('each box is one live change (offline people too); a click while its change is on its way does nothing', async () => {
    let answer
    api.access.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const w = await openAt('people', sharing({ guests: [guest()], offline: [{ id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: true, open: false, close: false }, projects: ['ws-1'], invite: null, trusted: false, trustable: true }] }))
    await tick(w, '[data-test="ls-proj-ws-2-g1"] input')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'g1', project: 'ws-2', on: true })
    // The box waits while its change is on its way.
    expect(w.find('[data-test="ls-proj-ws-2-g1"] input').attributes('disabled')).toBeDefined()
    answer({ ok: false })
    await flushPromises()
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('That change could not be made (the person may have left or been removed).')
    api.access.mockResolvedValue({ ok: true })
    await tick(w, '[data-test="ls-right-type-k-abc"] input')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'k-abc', right: 'type', on: false })
    expect(w.find('[data-test="ls-host-error"]').exists()).toBe(false)
    w.unmount()
  })

  it('a trusted person shows once: its newest connection, not its old one, not as offline', async () => {
    const tess = (id, since) => guest({ id, name: 'Tess', trusted: true, trustId: 't-1', since })
    const w = await openAt('people', sharing({ guests: [tess('g1', 1), tess('g2', 2)], offline: [{ id: 'k-old', name: 'Tess', rights: {}, projects: [], invite: null, trusted: true, trustId: 't-1', trustable: true }] }))
    expect(w.findAll('[data-test^="ls-guest-"]').map((x) => x.attributes('data-test'))).toEqual(['ls-guest-g2'])
    expect(w.find('[data-test="ls-offline-k-old"]').exists()).toBe(false)
    w.unmount()
  })

  it('Trust makes a guest trusted', async () => {
    const w = await openAt('people', sharing({ guests: [guest()] }))
    await w.find('[data-test="ls-person-trust-g1"]').trigger('click')
    await flushPromises()
    expect(api.trust).toHaveBeenCalledWith({ guestId: 'g1' })
    expect(w.find('[data-test="ls-host-notice"]').text()).toContain('Bob is trusted')
    w.unmount()
  })

  it('a full trusted list says so plainly', async () => {
    api.trust.mockResolvedValue({ ok: false, reason: 'trust-full', max: 50 })
    const w = await openAt('people', sharing({ guests: [guest()] }))
    await w.find('[data-test="ls-person-trust-g1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('Trusted list is full (50): remove someone first.')
    w.unmount()
  })

  it('Remove asks first; a trusted person stops being trusted too unless you untick it', async () => {
    const w = await openAt('people', sharing({ guests: [guest(), guest({ id: 'g2', name: 'Tess', trusted: true })] }))
    // Not trusted: no trust question.
    await w.find('[data-test="ls-person-remove-g1"]').trigger('click')
    expect(api.removeGuest).not.toHaveBeenCalled()
    expect(w.find('[data-test="ls-person-untrust-g1"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.find('[data-test="ls-person-remove-cancel-g1"]').element)
    await w.find('[data-test="ls-person-remove-yes-g1"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g1', untrust: false })
    // Trusted: "Also stop trusting" comes ticked.
    expect(w.find('[data-test="ls-guest-g2"]').text()).toContain('Trusted')
    await w.find('[data-test="ls-person-remove-g2"]').trigger('click')
    const untrust = w.find('[data-test="ls-person-untrust-g2"] input')
    expect(untrust.element.checked).toBe(true)
    await w.find('[data-test="ls-person-remove-yes-g2"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g2', untrust: true })
    // Unticked: removed, still trusted (and it says so).
    await w.find('[data-test="ls-person-remove-g2"]').trigger('click')
    expect(w.find('[data-test="ls-person-keep-trust-g2"]').exists()).toBe(false)
    await w.find('[data-test="ls-person-untrust-g2"] input').setValue(false)
    expect(w.find('[data-test="ls-person-keep-trust-g2"]').text()).toBe('They stay trusted: they can come back without asking.')
    await w.find('[data-test="ls-person-remove-yes-g2"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g2', untrust: false })
    w.unmount()
  })
})

describe('Live Share: someone waiting for your answer', () => {
  it('Let in… brings up their prompt (review-guest); Refuse turns them away', async () => {
    const w = await openAt('people', sharing({ guests: [guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    const row = w.find('[data-test="ls-waiting-g2"]')
    expect(row.text()).toContain('Waiting for your answer (code 123 456)')
    await row.find('[data-test="ls-waiting-letin-g2"]').trigger('click')
    expect(w.emitted('review-guest')).toEqual([['g2']])
    expect(api.approve).not.toHaveBeenCalled()
    await row.find('[data-test="ls-waiting-refuse-g2"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenCalledWith({ guestId: 'g2', yes: false, projects: [], rights: NO_RIGHTS, trust: false })
    expect(w.find('[data-test="ls-host-notice"]').text()).toBe('Eve was turned away.')
    w.unmount()
  })
})

describe('Live Share: Trusted', () => {
  it('an empty state; trusted people edited while not sharing (offline), every project of this window offered', async () => {
    const empty = await openAt('trusted', { ...OFF_HOST })
    expect(empty.find('[data-test="ls-trusted-empty"]').exists()).toBe(true)
    empty.unmount()
    const tess = trustedOne({ projects: ['ws-1', 'ws-gone'], lastSeen: Date.now() - 60000 })
    const w = await openAt('trusted', { ...OFF_HOST, trusted: [tess] })
    const row = w.find(`[data-test="ls-trusted-${tess.id}"]`)
    expect(row.text()).toContain('Tess')
    expect(row.text()).toContain('Last seen')
    // A project kept that this window does not have: counted, not lost.
    expect(row.text()).toContain('And 1 project not in this window (kept).')
    expect(w.find(`[data-test="ls-proj-ws-3-${tess.id}"]`).exists()).toBe(true)
    await tick(w, `[data-test="ls-proj-ws-3-${tess.id}"] input`)
    expect(api.access).toHaveBeenLastCalledWith({ subject: tess.id, project: 'ws-3', on: true })
    await tick(w, `[data-test="ls-right-close-${tess.id}"] input`)
    expect(api.access).toHaveBeenLastCalledWith({ subject: tess.id, right: 'close', on: true })
    w.unmount()
  })

  it('a project that could not be given says why (the cap)', async () => {
    api.access.mockResolvedValue({ ok: false })
    const tess = trustedOne()
    const w = await openAt('trusted', { ...OFF_HOST, trusted: [tess] })
    await tick(w, `[data-test="ls-proj-ws-2-${tess.id}"] input`)
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('site could not be given to Tess (a trusted person can have up to 64 projects).')
    api.access.mockResolvedValue({ ok: false, reason: 'trust-projects', max: 64 })
    await tick(w, `[data-test="ls-proj-ws-3-${tess.id}"] input`)
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('A trusted person can have up to 64 projects: take one away first.')
    w.unmount()
  })

  it('rename and stop trusting (asked first)', async () => {
    const tess = trustedOne({ online: true })
    const w = await openAt('trusted', sharing({ trusted: [tess] }))
    expect(w.find(`[data-test="ls-trusted-${tess.id}"]`).text()).toContain('Connected now')
    await w.find(`[data-test="ls-trusted-rename-${tess.id}"]`).trigger('click')
    const input = w.find(`[data-test="ls-trusted-name-input-${tess.id}"]`)
    expect(document.activeElement).toBe(input.element)
    await input.setValue('Tess B')
    await w.find(`[data-test="ls-trusted-${tess.id}"] form`).trigger('submit')
    await flushPromises()
    expect(api.renameTrusted).toHaveBeenCalledWith({ id: tess.id, name: 'Tess B' })
    await w.find(`[data-test="ls-trusted-untrust-${tess.id}"]`).trigger('click')
    expect(api.untrust).not.toHaveBeenCalled()
    expect(w.text()).toContain('If they are connected, they are disconnected')
    await w.find(`[data-test="ls-trusted-untrust-yes-${tess.id}"]`).trigger('click')
    await flushPromises()
    expect(api.untrust).toHaveBeenCalledWith({ id: tess.id })
    w.unmount()
  })
})

describe('Live Share: Access', () => {
  const host = () =>
    sharing({
      projectIds: ['ws-1', 'ws-2'],
      guests: [guest({ projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } }), guest({ id: 'g3', name: 'Tess', trusted: true, projects: ['ws-2'] })],
      offline: [
        { id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: false, open: false, close: false }, projects: ['ws-2'], invite: null, trusted: false, trustable: true },
        // A trusted person offline: shown once, as its trusted entry.
        { id: 'k-def', name: 'Ty', rights: { ...NO_RIGHTS, type: false, open: false, close: false }, projects: ['ws-1'], invite: null, trusted: true, trustable: true }
      ],
      trusted: [trustedOne({ id: 't-' + 'b'.repeat(32), name: 'Ty', projects: ['ws-1'], online: false }), trustedOne({ id: 't-' + 'c'.repeat(32), name: 'Tess', online: true })],
      invites: [invite({ projects: ['ws-1'], joined: 2 }), invite({ id: 'iv-bbbbbbbbbb', label: 'Team', projects: [], joined: 0 })]
    })

  it('one grid: people and invitations x shared projects, then rights; each box a live change', async () => {
    const w = await openAt('access', host())
    const grid = w.find('[data-test="ls-access-grid"]')
    expect(grid.exists()).toBe(true)
    const rows = grid.findAll('tbody tr[data-test^="ls-access-row-"]').map((r) => r.attributes('data-test').replace('ls-access-row-', ''))
    expect(rows).toEqual(['g1', 'g3', 'k-abc', 't-' + 'b'.repeat(32), 'iv-aaaaaaaaaa', 'iv-bbbbbbbbbb'])
    expect(grid.find('thead').text()).toContain('tessel')
    expect(grid.find('thead').text()).toContain('site')
    expect(w.find('[data-test="ls-access-g1-ws-1"]').element.checked).toBe(true)
    expect(w.find('[data-test="ls-access-g1-ws-2"]').element.checked).toBe(false)
    expect(w.find('[data-test="ls-access-g1-right-type"]').element.checked).toBe(true)
    expect(w.find('[data-test="ls-access-g1-ws-2"]').attributes('aria-label')).toBe('Bob: site')
    await tick(w, '[data-test="ls-access-g1-ws-2"]')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'g1', project: 'ws-2', on: true })
    await tick(w, '[data-test="ls-access-k-abc-right-close"]')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'k-abc', right: 'close', on: true })
    // An invitation nobody joined with: changed at once.
    await tick(w, '[data-test="ls-access-iv-bbbbbbbbbb-ws-2"]')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'iv-bbbbbbbbbb', project: 'ws-2', on: true })
    w.unmount()
  })

  it('an invitation people joined with asks whether its change is for them too', async () => {
    api.updateInvite.mockResolvedValue({ ok: true, applied: 2 })
    const w = await openAt('access', host())
    // Taking a project away: "Them too" comes first.
    await tick(w, '[data-test="ls-access-iv-aaaaaaaaaa-ws-1"]')
    expect(api.access).not.toHaveBeenCalled()
    const ask = w.find('[data-test="ls-access-apply"]')
    expect(ask.text()).toContain('2 people joined with “Simpa”. Take tessel away from them too?')
    expect(w.find('[data-test="ls-access-apply-yes"]').classes()).toContain('primary')
    await w.find('[data-test="ls-access-apply-yes"]').trigger('click')
    await flushPromises()
    expect(api.updateInvite).toHaveBeenLastCalledWith({ id: 'iv-aaaaaaaaaa', patch: { projects: [] }, applyRemovals: true, applyAdditions: false })
    // Giving a right: you choose; "Only the invitation" leaves them as they are.
    await tick(w, '[data-test="ls-access-iv-aaaaaaaaaa-right-open"]')
    expect(w.find('[data-test="ls-access-apply"]').text()).toContain('Give Open to them too?')
    expect(w.find('[data-test="ls-access-apply-no"]').classes()).toContain('primary')
    await w.find('[data-test="ls-access-apply-no"]').trigger('click')
    await flushPromises()
    expect(api.updateInvite).toHaveBeenLastCalledWith({ id: 'iv-aaaaaaaaaa', patch: { rights: { ...NO_RIGHTS, type: false, open: true, close: false } }, applyRemovals: false, applyAdditions: false })
    // Escape: nothing changes.
    await tick(w, '[data-test="ls-access-iv-aaaaaaaaaa-ws-2"]')
    await w.find('[data-test="ls-access-apply"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="ls-access-apply"]').exists()).toBe(false)
    expect(api.updateInvite).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('one project: who has it, who could be given it, with their rights', async () => {
    const w = await openAt('access', host())
    await w.find('[data-test="ls-access-col-ws-2"]').trigger('click')
    const view = w.find('[data-test="ls-access-project"]')
    expect(view.text()).toContain('Who has access to site')
    const has = w.find('[data-test="ls-access-with"]')
    expect(has.text()).toContain('Tess')
    expect(has.text()).toContain('Alex')
    const can = w.find('[data-test="ls-access-without"]')
    expect(can.text()).toContain('Bob')
    expect(can.text()).toContain('Ty')
    expect(can.text()).toContain('Simpa')
    expect(can.text()).toContain('Team')
    await tick(w, '[data-test="ls-access-has-g1"]')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'g1', project: 'ws-2', on: true })
    await tick(w, '[data-test="ls-right-type-p-k-abc"] input')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'k-abc', right: 'type', on: true })
    await w.find('[data-test="ls-access-back"]').trigger('click')
    expect(w.find('[data-test="ls-access-grid"]').exists()).toBe(true)
    w.unmount()
  })

  it('nobody has access: an empty state; a project no longer shared goes back to the grid', async () => {
    const w = await openAt('access', sharing({ projectIds: ['ws-1', 'ws-2'] }), { focusProject: 'ws-2' })
    expect(w.find('[data-test="ls-access-project-empty"]').text()).toBe('Nobody has access to site yet.')
    push.host(sharing({ projectIds: ['ws-1'] }))
    await flushPromises()
    await w.setProps({ projectIds: ['ws-1'] })
    expect(w.find('[data-test="ls-access-project"]').exists()).toBe(false)
    expect(w.find('[data-test="ls-access-empty"]').exists()).toBe(true)
    w.unmount()
  })
})
