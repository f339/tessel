// The update card (bottom right): shown as soon as a new version is found,
// with its download progress, then ready to install.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateCard from '../components/UpdateCard.vue'

describe('the update card', () => {
  beforeEach(() => window.localStorage.clear())

  it('while it downloads: the version and its progress, no Update yet', () => {
    const w = mount(UpdateCard, { props: { status: { state: 'downloading', version: '1.14.6', percent: 45.4 } } })
    expect(w.find('[data-test="update-card"]').exists()).toBe(true)
    expect(w.find('[data-test="update-card-text"]').text()).toBe('Tessel v1.14.6 is downloading… 45%')
    expect(w.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('45')
    const button = w.find('[data-test="update-card-update"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toBe('Downloading…')
  })

  it('ready: Update opens the restart', async () => {
    const w = mount(UpdateCard, { props: { status: { state: 'ready', version: '1.14.6' } } })
    expect(w.find('[data-test="update-card-text"]').text()).toBe('Tessel v1.14.6 is ready.')
    expect(w.find('[role="progressbar"]').exists()).toBe(false)
    await w.find('[data-test="update-card-update"]').trigger('click')
    expect(w.emitted('update')).toHaveLength(1)
  })

  it('dismissed while it downloads: back once ready; dismissed when ready: not again for that version', async () => {
    const w = mount(UpdateCard, { props: { status: { state: 'downloading', version: '1.14.6', percent: 10 } } })
    await w.find('[data-test="update-card-dismiss"]').trigger('click')
    await new Promise((r) => setTimeout(r, 200))
    expect(w.find('[data-test="update-card"]').exists()).toBe(false)
    await w.setProps({ status: { state: 'ready', version: '1.14.6' } })
    expect(w.find('[data-test="update-card"]').exists()).toBe(true)
    await w.find('[data-test="update-card-dismiss"]').trigger('click')
    await new Promise((r) => setTimeout(r, 200))
    expect(w.find('[data-test="update-card"]').exists()).toBe(false)
    const again = mount(UpdateCard, { props: { status: { state: 'ready', version: '1.14.6' } } })
    expect(again.find('[data-test="update-card"]').exists()).toBe(false)
    const next = mount(UpdateCard, { props: { status: { state: 'downloading', version: '1.14.7', percent: 1 } } })
    expect(next.find('[data-test="update-card"]').exists()).toBe(true)
  })

  it('nothing to say: no card', () => {
    for (const state of ['idle', 'checking', 'none', 'error', 'disabled']) {
      const w = mount(UpdateCard, { props: { status: { state, version: '1.14.6' } } })
      expect(w.find('[data-test="update-card"]').exists()).toBe(false)
    }
  })
})
