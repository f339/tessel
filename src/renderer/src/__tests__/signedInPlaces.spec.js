// Settings > AI provider accounts > Where you're signed in (SignedInPlaces.vue):
// this PC at once, each host checked on its own ("checking…"), each account
// with every place, Switch for the panes that can move to it, Remove only
// for a folder Tessel made on a host (main asks first).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SignedInPlaces from '../components/SignedInPlaces.vue'

const pc = { id: 'pc', kind: 'pc', state: 'ready', entries: [{ agent: 'claude', scope: 'system', id: null, email: 'coreine13@gmail.com', plan: 'pro', state: 'signed-in' }] }
const hostEntries = [
  { agent: 'claude', scope: 'default', id: null, email: 'coreine13@gmail.com', plan: 'pro', state: 'signed-in', removable: false, signOut: true, lastSeen: null },
  { agent: 'claude', scope: 'tessel', id: 'abc123', email: 'work@corp.example', plan: 'max', state: 'signed-in', removable: true, signOut: false, lastSeen: null }
]

describe('Where you’re signed in', () => {
  let previous, release, api, panes
  beforeEach(() => {
    previous = window.shellApi
    const slow = new Promise((r) => (release = r))
    api = {
      places: vi.fn(async () => ({ ok: true, places: [pc, { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'unknown', entries: [] }, { id: 'ssh:ssh-2', kind: 'ssh', hostId: 'ssh-2', label: 'offline-box', state: 'not-connected', entries: [] }] })),
      scan: vi.fn(async (id) => (id === 'ssh:ssh-1' ? slow : { ok: false }))
    }
    window.shellApi = { signedIn: api, remoteAccounts: { remove: vi.fn(async () => ({ ok: false, cancelled: true })), signOut: vi.fn() } }
    panes = { list: () => [{ id: 'p1', name: 'Archimedes', agentId: 'claude', remoteHostId: 'ssh-1' }], switchTo: vi.fn(async () => true) }
  })
  afterEach(() => {
    window.shellApi = previous
  })

  it('this PC at once; a connected host checked in the background, one not connected never asked', async () => {
    const w = mount(SignedInPlaces, { global: { provide: { accountPanes: panes } } })
    await flushPromises()
    expect(w.text()).toContain('Only the machines Tessel knows')
    expect(w.text()).toContain('coreine13@gmail.com')
    expect(api.scan).toHaveBeenCalledTimes(1)
    expect(api.scan).toHaveBeenCalledWith('ssh:ssh-1', {})
    const places = w.findAll('[data-test="signed-in-place"]').map((p) => p.text())
    expect(places[0]).toContain('checking…')
    expect(places[1]).toContain('not connected')
    release({ ok: true, place: { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'ready', entries: hostEntries } })
    await flushPromises()
    // One account, two places; the work account on the host only.
    const accounts = w.findAll('[data-test="signed-in-account"]')
    expect(accounts).toHaveLength(2)
    expect(accounts[0].findAll('[data-test="signed-in-row"]').map((r) => r.find('.si-place').text())).toEqual(['This PC', 'linux-box'])
    // Remove only on the folder Tessel made; sign-out only on the host's own.
    expect(accounts[0].find('[data-test="signed-in-remove"]').exists()).toBe(false)
    expect(accounts[0].find('[data-test="signed-in-signout"]').exists()).toBe(true)
    expect(accounts[1].find('[data-test="signed-in-remove"]').exists()).toBe(true)
    w.unmount()
  })

  it('Switch moves an open pane on that host to the account; Remove asks main (cancelled: nothing said)', async () => {
    api.scan.mockResolvedValue({ ok: true, place: { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'ready', entries: hostEntries } })
    const w = mount(SignedInPlaces, { global: { provide: { accountPanes: panes } } })
    await flushPromises()
    const work = w.findAll('[data-test="signed-in-account"]')[1]
    const sw = work.get('[data-test="signed-in-switch"]')
    expect(sw.text()).toBe('Switch Archimedes')
    await sw.trigger('click')
    expect(panes.switchTo).toHaveBeenCalledWith('p1', 'abc123')
    await work.get('[data-test="signed-in-remove"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.remoteAccounts.remove).toHaveBeenCalledWith('ssh-1', 'claude', 'abc123', { panes: [], orphan: false })
    expect(w.text()).not.toContain('Removed from')
    w.unmount()
  })

  it('Sign out names the panes on that login (main stops them); on a Mac it says the Keychain login stays; Refresh asks the login shells again', async () => {
    api.scan.mockResolvedValue({ ok: true, place: { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'ready', entries: hostEntries } })
    window.shellApi.remoteAccounts.signOut = vi.fn(async () => ({ ok: true, keychain: true }))
    const w = mount(SignedInPlaces, { global: { provide: { accountPanes: panes } } })
    await flushPromises()
    await w.get('[data-test="signed-in-signout"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.remoteAccounts.signOut).toHaveBeenCalledWith('ssh-1', 'claude', { panes: ['p1'] })
    expect(w.text()).toContain('the macOS Keychain login remains')
    await w.get('[data-test="signed-in-refresh"]').trigger('click')
    await flushPromises()
    expect(api.scan).toHaveBeenLastCalledWith('ssh:ssh-1', { fresh: true, relogin: true })
    w.unmount()
  })
})
