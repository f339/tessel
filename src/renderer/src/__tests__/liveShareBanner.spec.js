// Live Share said above the panes (LiveShareBanner.vue): sharing (host) or in
// someone's session (guest), on the project concerned or from another one.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LiveShareBanner from '../components/LiveShareBanner.vue'

const host = (extra = {}) => ({ mode: 'host', starting: false, projects: [{ id: 'ws1', name: 'Tessel', here: true }], here: true, canAdd: false, guests: 2, waiting: 0, ...extra })
const guest = (extra = {}) => ({ mode: 'guest', reconnecting: false, host: 'Cédric', sessionId: 'g1', here: true, rights: 'You can watch.', ...extra })
const two = [
  { id: 'ws1', name: 'Tessel', here: true },
  { id: 'ws2', name: 'Site', here: false }
]

describe('Live Share banner', () => {
  it('host on a shared project: LIVE, the projects shared, guests in, those waiting', async () => {
    const w = mount(LiveShareBanner, { props: { banner: host({ waiting: 1 }) } })
    expect(w.classes()).toContain('host')
    expect(w.text()).toContain('LIVE')
    expect(w.text()).toContain('Guests see this project live. You share:')
    expect(w.find('[data-test="live-project-ws1"]').text()).toBe('Tessel')
    expect(w.find('[data-test="live-project-ws1"]').classes()).toContain('here')
    expect(w.text()).toContain('2 guest(s) in')
    expect(w.text()).toContain('1 waiting for your answer')
    // The only project shared: it stays (Stop sharing, in Manage, ends it);
    // the one on screen is shared: nothing to add.
    expect(w.find('[data-test="live-remove-ws1"]').exists()).toBe(false)
    expect(w.find('[data-test="live-share-add"]').exists()).toBe(false)
    await w.find('[data-test="live-share-manage"]').trigger('click')
    expect(w.emitted('manage')).toHaveLength(1)
  })

  it('host sharing several projects: each one goes to it, and × takes it out of the share', async () => {
    const w = mount(LiveShareBanner, { props: { banner: host({ projects: two }) } })
    expect(w.findAll('[data-test="live-share-projects"] .live-project').map((p) => p.text())).toEqual(['Tessel', 'Site'])
    await w.find('[data-test="live-project-ws2"] .live-project-name').trigger('click')
    expect(w.emitted('goto')).toEqual([['ws2']])
    await w.find('[data-test="live-remove-ws2"]').trigger('click')
    expect(w.emitted('remove')).toEqual([['ws2']])
    expect(w.find('[data-test="live-remove-ws1"]').attributes('aria-label')).toBe('Stop sharing Tessel: guests no longer see it')
    // While it starts: nothing taken out yet.
    const starting = mount(LiveShareBanner, { props: { banner: host({ projects: two, starting: true }) } })
    expect(starting.text()).toContain('STARTING')
    expect(starting.find('[data-test="live-remove-ws2"]').exists()).toBe(false)
  })

  it('host on a project that is not shared: says so, and + Share this project adds it', async () => {
    const w = mount(LiveShareBanner, { props: { banner: host({ here: false, canAdd: true, projects: [{ id: 'ws1', name: 'Tessel', here: false }] }) } })
    expect(w.text()).toContain('This project is not shared. You share:')
    expect(w.find('[data-test="live-project-ws1"]').classes()).not.toContain('here')
    await w.find('[data-test="live-share-add"]').trigger('click')
    expect(w.emitted('add')).toHaveLength(1)
    await w.find('[data-test="live-project-ws1"] .live-project-name').trigger('click')
    expect(w.emitted('goto')).toEqual([['ws1']])
  })

  it("guest: whose session, what it may do, and leaving", async () => {
    const w = mount(LiveShareBanner, { props: { banner: guest() } })
    expect(w.classes()).toContain('guest')
    expect(w.text()).toContain('LIVE SHARE')
    expect(w.text()).toContain('You are in Cédric’s session: these panes run on Cédric’s computer.')
    expect(w.text()).toContain('You can watch.')
    await w.find('[data-test="live-share-leave"]').trigger('click')
    expect(w.emitted('leave')).toHaveLength(1)
  })

  it('guest reconnecting, or on one of its own projects', () => {
    expect(mount(LiveShareBanner, { props: { banner: guest({ reconnecting: true }) } }).text()).toContain('Reconnecting to Cédric’s session…')
    const other = mount(LiveShareBanner, { props: { banner: guest({ here: false }) } })
    expect(other.text()).toContain('(this project is yours)')
    expect(other.findAll('button').some((b) => b.text() === 'Go to the session')).toBe(true)
  })
})
