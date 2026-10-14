// Live Share said above the panes (LiveShareBanner.vue): sharing (host) or in
// someone's session (guest), on the project concerned or from another one.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LiveShareBanner from '../components/LiveShareBanner.vue'

const host = (extra = {}) => ({ mode: 'host', starting: false, project: 'Tessel', sharedId: 'ws1', here: true, guests: 2, waiting: 0, ...extra })
const guest = (extra = {}) => ({ mode: 'guest', reconnecting: false, host: 'Cédric', sessionId: 'g1', here: true, rights: 'You can watch.', ...extra })

describe('Live Share banner', () => {
  it('host on the shared project: LIVE, which project, guests in, those waiting', async () => {
    const w = mount(LiveShareBanner, { props: { banner: host({ waiting: 1 }) } })
    expect(w.classes()).toContain('host')
    expect(w.text()).toContain('LIVE')
    expect(w.text()).toContain('You are sharing this project (Tessel)')
    expect(w.text()).toContain('2 guest(s) in')
    expect(w.text()).toContain('1 waiting for your answer')
    // On the shared project: no way "back" to it.
    expect(w.text()).not.toContain('Go to the shared project')
    await w.find('[data-test="live-share-manage"]').trigger('click')
    expect(w.emitted('manage')).toHaveLength(1)
  })

  it('host on another project: says which one is shared, and goes back to it', async () => {
    const w = mount(LiveShareBanner, { props: { banner: host({ here: false }) } })
    expect(w.text()).toContain('You are sharing Tessel (not this project)')
    const back = w.findAll('button').find((b) => b.text() === 'Go to the shared project')
    await back.trigger('click')
    expect(w.emitted('goto')).toHaveLength(1)
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
