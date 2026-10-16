// Settings > AI provider accounts > Where you're signed in (SignedInPlaces.vue):
// this PC at once, each host checked on its own ("checking…"), the accounts
// grouped by provider with a chip per place (its menu: Make default here,
// Sign out on the host, Remove from this host, Check again), "Switch
// panes…" for the panes on other accounts, the accounts not named yet as
// "Unknown account", and the places not read folded into one quiet line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SignedInPlaces from '../components/SignedInPlaces.vue'
import { settings } from '../settings'
import { accountSub, groupByProvider, panesUsing, placesToCheck, shownOrg, switchCandidates, switchTarget } from '../signedInPlaces'

const pc = { id: 'pc', kind: 'pc', state: 'ready', entries: [{ agent: 'claude', scope: 'system', id: null, email: 'coreine13@gmail.com', org: "coreine13@gmail.com's Organization", plan: 'pro', state: 'signed-in' }] }
const hostEntries = [
  { agent: 'claude', scope: 'default', id: null, email: 'coreine13@gmail.com', plan: 'pro', state: 'signed-in', removable: false, signOut: true, lastSeen: null },
  { agent: 'claude', scope: 'tessel', id: 'abc123', email: 'work@corp.example', org: 'Corp', plan: 'max', state: 'signed-in', removable: true, signOut: false, lastSeen: null }
]
const ready = (entries = hostEntries) => ({ ok: true, place: { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'ready', entries } })
const menuItems = () => [...document.body.querySelectorAll('.orca-menu .orca-menu-item')]
const menuItem = (label) => menuItems().find((b) => b.textContent.trim() === label)

describe('Where you’re signed in', () => {
  let previous, release, api, panes, w
  beforeEach(() => {
    previous = window.shellApi
    settings.hostAccountDefaults = {}
    const slow = new Promise((r) => (release = r))
    api = {
      places: vi.fn(async () => ({ ok: true, places: [pc, { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'unknown', entries: [] }, { id: 'ssh:ssh-2', kind: 'ssh', hostId: 'ssh-2', label: 'offline-box', state: 'not-connected', entries: [] }] })),
      scan: vi.fn(async (id) => (id === 'ssh:ssh-1' ? slow : { ok: false }))
    }
    window.shellApi = { signedIn: api, remoteAccounts: { remove: vi.fn(async () => ({ ok: false, cancelled: true })), signOut: vi.fn() } }
    panes = { list: () => [{ id: 'p1', name: 'Archimedes', agentId: 'claude', remoteHostId: 'ssh-1' }], switchTo: vi.fn(async () => true) }
  })
  afterEach(() => {
    w?.unmount()
    w = null
    document.body.innerHTML = ''
    settings.hostAccountDefaults = {}
    window.shellApi = previous
  })
  const open = async () => {
    w = mount(SignedInPlaces, { global: { provide: { accountPanes: panes } }, attachTo: document.body })
    await flushPromises()
    return w
  }
  const chipsOf = (account) => account.findAll('[data-test="signed-in-chip"]')

  it('this PC at once; a host checked in the background, one not connected never asked; by provider, a chip per place', async () => {
    await open()
    expect(w.text()).toContain('Only the machines Tessel knows')
    expect(api.scan).toHaveBeenCalledTimes(1)
    expect(api.scan).toHaveBeenCalledWith('ssh:ssh-1', {})
    expect(w.get('[data-test="signed-in-foot"]').text()).toContain('Checking linux-box…')
    expect(w.get('[data-test="signed-in-waiting"]').text()).toBe('Not checked yet: offline-box. Open a terminal there to check.')
    release(ready())
    await flushPromises()
    const providers = w.findAll('[data-test="signed-in-provider"]')
    expect(providers).toHaveLength(1)
    expect(providers[0].find('h4').text()).toContain('Claude Code')
    const accounts = w.findAll('[data-test="signed-in-account"]')
    expect(accounts).toHaveLength(2)
    // One account, two places; its personal organization not repeated.
    expect(chipsOf(accounts[0]).map((c) => c.find('.si-chip-name').text())).toEqual(['This PC', 'linux-box'])
    expect(accounts[0].find('.si-meta').exists()).toBe(false)
    expect(accounts[0].get('[data-test="signed-in-plan"]').text()).toBe('Pro')
    expect(accounts[1].get('.si-meta').text()).toBe('Corp')
    // The host's own sign-in is the default there (nothing kept): marked.
    expect(chipsOf(accounts[0])[1].find('[data-test="signed-in-default"]').exists()).toBe(true)
    expect(chipsOf(accounts[1])[0].find('[data-test="signed-in-default"]').exists()).toBe(false)
    // The pane on the host's own sign-in: one pane on it; no per-pane button.
    expect(accounts[0].get('[data-test="signed-in-used"]').text()).toBe('Used by 1 pane')
    expect(w.find('[data-test="signed-in-switch"]').exists()).toBe(false)
  })

  it('a chip’s menu: Make default here, Remove only on a folder Tessel made, sign-out only on the host’s own, Check again', async () => {
    api.scan.mockResolvedValue(ready())
    await open()
    const [own, work] = w.findAll('[data-test="signed-in-account"]')
    await chipsOf(own)[1].trigger('click')
    expect(chipsOf(own)[1].attributes('aria-expanded')).toBe('true')
    expect(menuItems().map((b) => b.textContent.trim())).toEqual(['Default for new panes here', 'Sign out on the host…', 'Check again'])
    expect(menuItem('Default for new panes here').disabled).toBe(true)
    menuItem('Check again').click()
    await flushPromises()
    expect(api.scan).toHaveBeenLastCalledWith('ssh:ssh-1', { fresh: true })
    await chipsOf(work)[0].trigger('click')
    expect(menuItems().map((b) => b.textContent.trim())).toEqual(['Make default here', 'Remove from this host…', 'Check again'])
    menuItem('Make default here').click()
    await flushPromises()
    expect(settings.hostAccountDefaults).toEqual({ 'ssh-1': { claude: 'abc123' } })
    expect(chipsOf(work)[0].find('[data-test="signed-in-default"]').exists()).toBe(true)
    expect(chipsOf(own)[1].find('[data-test="signed-in-default"]').exists()).toBe(false)
    expect(w.text()).toContain('New Claude Code panes on linux-box now start on this account.')
    await chipsOf(work)[0].trigger('click')
    menuItem('Remove from this host…').click()
    await flushPromises()
    expect(window.shellApi.remoteAccounts.remove).toHaveBeenCalledWith('ssh-1', 'claude', 'abc123', { panes: [], orphan: false })
    expect(w.text()).not.toContain('Removed from')
    // This PC: Check again only.
    await chipsOf(own)[0].trigger('click')
    expect(menuItems().map((b) => b.textContent.trim())).toEqual(['Check again'])
  })

  it('opened from the keyboard, the menu takes the focus; Esc gives it back to the chip', async () => {
    api.scan.mockResolvedValue(ready())
    await open()
    const chip = chipsOf(w.findAll('[data-test="signed-in-account"]')[1])[0]
    chip.element.focus()
    // A key press on a button clicks it with no pointer (detail 0).
    chip.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    await flushPromises()
    expect(document.activeElement.textContent.trim()).toBe('Make default here')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(menuItems()).toHaveLength(0)
    expect(document.activeElement).toBe(chip.element)
  })

  it('Switch panes…: the panes on other accounts, by place, with checkboxes; Restart on this account', async () => {
    api.scan.mockResolvedValue(ready())
    await open()
    const work = w.findAll('[data-test="signed-in-account"]')[1]
    // No pane on it: nothing said.
    expect(work.find('[data-test="signed-in-used"]').exists()).toBe(false)
    const toggle = work.get('[data-test="signed-in-switch-open"]')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const panel = w.get('[data-test="signed-in-switch-panel"]')
    expect(panel.get('legend').text()).toBe('linux-box')
    const go = panel.get('[data-test="signed-in-switch-go"]')
    expect(go.attributes('disabled')).toBeDefined()
    await panel.get('[data-test="signed-in-switch-pane"]').setValue(true)
    expect(go.attributes('disabled')).toBeUndefined()
    await go.trigger('click')
    await flushPromises()
    expect(panes.switchTo).toHaveBeenCalledWith('p1', 'abc123')
    expect(w.text()).toContain('Archimedes restarts on work@corp.example.')
    expect(w.find('[data-test="signed-in-switch-panel"]').exists()).toBe(false)
    // Its own account: nothing to switch.
    expect(w.findAll('[data-test="signed-in-account"]')[0].find('[data-test="signed-in-switch-open"]').exists()).toBe(false)
  })

  it('a sign-in that names no account yet: an "Unknown account" row of its provider, with Check again', async () => {
    api.scan.mockResolvedValue(ready([...hostEntries, { agent: 'claude', scope: 'tessel', id: 'bd93c7f5566d', plan: 'max', state: 'signed-in', removable: true, signOut: false }]))
    await open()
    const accounts = w.findAll('[data-test="signed-in-account"]')
    expect(accounts).toHaveLength(3)
    const unknown = accounts[2]
    expect(unknown.get('.si-who').text()).toBe('Unknown account')
    expect(unknown.get('[data-test="signed-in-plan"]').text()).toBe('Max')
    expect(chipsOf(unknown).map((c) => c.find('.si-chip-name').text())).toEqual(['linux-box'])
    expect(unknown.find('[data-test="signed-in-switch-open"]').exists()).toBe(false)
    await unknown.get('[data-test="signed-in-unknown-check"]').trigger('click')
    expect(api.scan).toHaveBeenLastCalledWith('ssh:ssh-1', { fresh: true })
  })

  it('signed out: said on its chip; a profile with only its account id left is an Unknown account, signed out', async () => {
    api.scan.mockResolvedValue(
      ready([
        { ...hostEntries[1], state: 'profile' },
        { agent: 'claude', scope: 'tessel', id: 'old1', account: '1f0c6d1e-1111-4111-8111-111111111111', state: 'profile', removable: true, signOut: false }
      ])
    )
    await open()
    const accounts = w.findAll('[data-test="signed-in-account"]')
    const work = accounts.find((a) => a.get('.si-who').text() === 'work@corp.example')
    expect(chipsOf(work)[0].get('[data-test="signed-in-chip-state"]').text()).toBe('signed out')
    expect(chipsOf(work)[0].attributes('title')).toContain('signed out (its profile is still there)')
    const unknown = accounts.find((a) => a.get('.si-who').text() === 'Unknown account')
    expect(unknown.get('.si-meta').text()).toBe('signed out; its account is not known')
    expect(chipsOf(unknown)[0].get('[data-test="signed-in-chip-state"]').text()).toBe('signed out')
    // Nothing that is not signed in is listed as signed in.
    expect(w.text()).not.toContain('Signed in (no account name)')
    // Signed in on this PC: no state word.
    expect(chipsOf(accounts[0])[0].find('[data-test="signed-in-chip-state"]').exists()).toBe(false)
  })

  it('a signed-out profile with no email is never listed as signed in; a sign-in to renew says so', async () => {
    api.scan.mockResolvedValue(
      ready([
        hostEntries[0],
        { agent: 'codex', scope: 'default', id: null, email: null, plan: null, state: 'profile', removable: false, signOut: false, lastSeen: null },
        { ...hostEntries[1], state: 'missing' }
      ])
    )
    await open()
    const codex = w.findAll('[data-test="signed-in-provider"]').find((p) => p.text().includes('Codex'))
    const unknown = codex.get('[data-test="signed-in-account"]')
    expect(unknown.get('.si-who').text()).toBe('Unknown account')
    expect(unknown.get('.si-meta').text()).toBe('signed out; its account is not known')
    expect(chipsOf(unknown)[0].get('[data-test="signed-in-chip-state"]').text()).toBe('signed out')
    const work = w.findAll('[data-test="signed-in-account"]').find((a) => a.get('.si-who').text() === 'work@corp.example')
    expect(chipsOf(work)[0].get('[data-test="signed-in-chip-state"]').text()).toBe('sign-in needed')
  })

  it('Sign out names the panes on that login (main stops them); on a Mac it says the Keychain login stays; Refresh asks the login shells again', async () => {
    api.scan.mockResolvedValue(ready())
    window.shellApi.remoteAccounts.signOut = vi.fn(async () => ({ ok: true, keychain: true }))
    await open()
    await chipsOf(w.findAll('[data-test="signed-in-account"]')[0])[1].trigger('click')
    menuItem('Sign out on the host…').click()
    await flushPromises()
    expect(window.shellApi.remoteAccounts.signOut).toHaveBeenCalledWith('ssh-1', 'claude', { panes: ['p1'] })
    expect(w.text()).toContain('the macOS Keychain login remains')
    await w.get('[data-test="signed-in-refresh"]').trigger('click')
    await flushPromises()
    expect(api.scan).toHaveBeenLastCalledWith('ssh:ssh-1', { fresh: true, relogin: true })
  })

  it('the places not read fold into one quiet line (the list on demand); a WSL distro not started: Check', async () => {
    const hosts = ['148.113.224.19', '158.69.53.210', 'box-3', 'box-4', 'box-5'].map((label, i) => ({ id: `ssh:h${i}`, kind: 'ssh', hostId: `h${i}`, label, state: 'not-connected', entries: [] }))
    api.places.mockResolvedValue({ ok: true, places: [pc, ...hosts, { id: 'wsl:Ubuntu-24.04', kind: 'wsl', distro: 'Ubuntu-24.04', label: 'Ubuntu-24.04', state: 'stopped', entries: [] }] })
    api.scan.mockResolvedValue({ ok: false })
    await open()
    expect(w.get('[data-test="signed-in-waiting"]').text()).toBe('Not checked yet: 148.113.224.19, 158.69.53.210 and 3 more. Open a terminal there to check.')
    expect(w.findAll('[data-test="signed-in-place"]')).toHaveLength(0)
    const wsl = w.get('[data-test="signed-in-wsl-stopped"]')
    expect(wsl.text()).toContain('Ubuntu-24.04 not started')
    await wsl.get('button').trigger('click')
    expect(api.scan).toHaveBeenLastCalledWith('wsl:Ubuntu-24.04', { start: true })
    const toggle = w.get('[data-test="signed-in-places-toggle"]')
    expect(toggle.text()).toBe('All places (6)')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const rows = w.findAll('[data-test="signed-in-place"]')
    expect(rows).toHaveLength(6)
    expect(rows[0].text()).toContain('not connected')
  })
})

describe('signedInPlaces: by provider, panes, places to check', () => {
  const host = { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'linux-box', state: 'ready', entries: hostEntries }
  it('groups the accounts by provider (fixed order), the unnamed ones as one Unknown account of theirs', () => {
    const codexHost = { ...host, id: 'ssh:ssh-2', hostId: 'ssh-2', entries: [{ agent: 'codex', scope: 'default', email: 'dev@example.com', state: 'signed-in' }, { agent: 'opencode', scope: 'default', providers: [{ name: 'anthropic' }], state: 'signed-in' }, { agent: 'claude', scope: 'tessel', id: 'new1', state: 'empty' }] }
    const out = groupByProvider([pc, codexHost, host])
    expect(out.map((p) => p.agent)).toEqual(['claude', 'codex', 'opencode'])
    expect(out[0].accounts.map((a) => [a.email, a.chips.length])).toEqual([['coreine13@gmail.com', 2], ['work@corp.example', 1]])
    expect(out[2].accounts).toMatchObject([{ unknown: true, chips: [{ place: { id: 'ssh:ssh-2' } }] }])
  })
  it('an organization that only repeats the account is not shown', () => {
    expect(shownOrg("coreine13@gmail.com's Organization", 'coreine13@gmail.com')).toBe('')
    expect(shownOrg('coreine13@gmail.com’s Organization', 'coreine13@gmail.com')).toBe('')
    expect(shownOrg('coreine13@gmail.com', 'coreine13@gmail.com')).toBe('')
    expect(shownOrg('Corp', 'work@corp.example')).toBe('Corp')
    expect(shownOrg(null, 'a@b.c')).toBe('')
  })
  it('the panes on an account and those that can switch to it, each once, by place', () => {
    const list = [
      { id: 'p1', name: 'Archimedes', agentId: 'claude', remoteHostId: 'ssh-1' },
      { id: 'p2', name: 'Fermi', agentId: 'claude', remoteHostId: 'ssh-1', hostAccount: 'abc123' },
      { id: 'p3', name: 'Curie', agentId: 'claude', accountId: null },
      { id: 'p4', name: 'Chat', agentId: 'claude', remoteHostId: 'ssh-1', kind: 'chat' }
    ]
    const [own, work] = groupByProvider([pc, host])[0].accounts
    // A chat on that login counts (it runs on it too).
    expect(panesUsing(own, list).map((p) => p.id)).toEqual(['p3', 'p1', 'p4'])
    expect(panesUsing(work, list).map((p) => p.id)).toEqual(['p2'])
    expect(switchCandidates(work, list).map((g) => [g.place.id, g.items.map((i) => [i.pane.id, i.target.id])])).toEqual([['ssh:ssh-1', [['p1', 'abc123']]]])
    expect(switchCandidates(own, list).map((g) => [g.place.id, g.items.map((i) => [i.pane.id, i.target.id])])).toEqual([['ssh:ssh-1', [['p2', null]]]])
  })
  it('a folder whose sign-in file is a link: no pane switched to it, never a default (its launch is refused)', () => {
    const linked = { agent: 'claude', scope: 'tessel', id: 'lnk123', email: 'work@corp.example', plan: 'max', cred: 'file', state: 'signed-in', linked: true }
    const place = { ...host, entries: [...hostEntries, linked] }
    expect(switchTarget(place, linked, place.entries)).toBeNull()
    const account = groupByProvider([place])[0].accounts.find((a) => a.email === 'work@corp.example')
    const list = [{ id: 'p1', name: 'Archimedes', agentId: 'claude', remoteHostId: 'ssh-1' }]
    // The folder Tessel made for that account still is a target; the linked one never.
    expect(switchCandidates(account, list).flatMap((g) => g.items.map((i) => i.target.id))).toEqual(['abc123'])
    expect(switchCandidates({ chips: [{ place, entry: linked }] }, list)).toEqual([])
  })
  it('places to check: not read yet (not connected, unknown, error), WSL not started apart, nothing being checked', () => {
    const places = [pc, { ...host, id: 'ssh:a', state: 'not-connected' }, { ...host, id: 'ssh:b', state: 'error' }, { ...host, id: 'ssh:c', state: 'unknown' }, host, { id: 'wsl:U', kind: 'wsl', label: 'U', state: 'stopped' }]
    const r = placesToCheck(places, { 'ssh:c': true })
    expect(r.waiting.map((p) => p.id)).toEqual(['ssh:a', 'ssh:b'])
    expect(r.stopped.map((p) => p.id)).toEqual(['wsl:U'])
    expect(r.all).toHaveLength(5)
  })
})

// A Claude account's subscription as Anthropic last reported it
// (claudePlanCheck.js): the plan it shows, and the panes on an account with
// no subscription said at the top, with Switch panes… to move them. The
// fields are shaped like the profile endpoint's (fixture accounts only).
const T = Date.parse('2026-10-16T12:00:00Z')
const SUBS = {
  canceled: { organization_type: 'claude_free', rate_limit_tier: 'default_claude_ai', seat_tier: null, billing_type: 'none', subscription_status: 'canceled', has_claude_max: false, has_claude_pro: false, claude_code_trial_ends_at: null, checkedAt: T },
  max20: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', seat_tier: null, billing_type: 'stripe_subscription', subscription_status: 'active', has_claude_max: true, has_claude_pro: false, claude_code_trial_ends_at: null, checkedAt: T },
  pastDue: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', seat_tier: null, billing_type: 'stripe_subscription', subscription_status: 'past_due', has_claude_max: true, has_claude_pro: false, claude_code_trial_ends_at: null, checkedAt: T }
}
describe('Where you’re signed in: the plan Anthropic reports', () => {
  let previous, panes, w, listeners
  const pcWith = (systemSub, addedSub) => ({
    id: 'pc',
    kind: 'pc',
    state: 'ready',
    entries: [
      // The login file still says "max" for the canceled one.
      { agent: 'claude', scope: 'system', id: null, email: 'canceled.fixture@example.invalid', plan: 'max', ...(systemSub ? { sub: systemSub } : {}), state: 'signed-in' },
      { agent: 'claude', scope: 'tessel', id: 'acc-2', email: 'active.fixture@example.invalid', plan: 'max', ...(addedSub ? { sub: addedSub } : {}), state: 'signed-in' }
    ]
  })
  function setup(place) {
    previous = window.shellApi
    listeners = []
    window.shellApi = {
      signedIn: { places: vi.fn(async () => ({ ok: true, places: [place] })), scan: vi.fn(async () => ({ ok: false })) },
      accounts: { onPlansChanged: vi.fn((cb) => (listeners.push(cb), () => {})) }
    }
    const list = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, name: `Pane ${n}`, agentId: 'claude', accountId: n % 2 ? null : undefined }))
    list.push({ id: 'p6', name: 'Pane 6', agentId: 'claude', accountId: 'acc-2' })
    panes = { list: () => list, switchTo: vi.fn(async () => true) }
  }
  afterEach(() => {
    w?.unmount()
    w = null
    document.body.innerHTML = ''
    window.shellApi = previous
  })
  const open = async () => {
    w = mount(SignedInPlaces, { global: { provide: { accountPanes: panes } }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('a canceled Max: "No subscription", not "Max"; 5 panes on it said at the top; Switch panes… moves them to the account with an active plan', async () => {
    setup(pcWith(SUBS.canceled, SUBS.max20))
    await open()
    // By email: active.fixture first.
    const [active, canceled] = w.findAll('[data-test="signed-in-account"]')
    const tag = canceled.get('[data-test="signed-in-plan"]')
    expect(tag.text()).toBe('No subscription')
    expect(tag.classes()).toContain('warn')
    expect(tag.attributes('title')).toContain('Free')
    expect(canceled.text()).not.toContain('Max')
    expect(canceled.get('[data-test="signed-in-used"]').text()).toBe('Used by 5 panes')
    expect(canceled.get('[data-test="signed-in-used"]').classes()).toContain('warn')
    // No Switch panes… toward it (the 1 pane elsewhere would go to an account with none).
    expect(canceled.find('[data-test="signed-in-switch-open"]').exists()).toBe(false)
    expect(active.get('[data-test="signed-in-plan"]').text()).toBe('Max 20x')
    expect(active.find('[data-test="signed-in-plan-warn"]').exists()).toBe(false)
    const notice = w.get('[data-test="signed-in-no-sub"]')
    expect(notice.text()).toContain('5 panes use an account with no subscription')
    expect(notice.attributes('title')).toContain('canceled.fixture@example.invalid')
    await notice.get('[data-test="signed-in-no-sub-switch"]').trigger('click')
    const panel = w.get('[data-test="signed-in-switch-panel"]')
    expect(panel.text()).toContain('active.fixture@example.invalid')
    const boxes = panel.findAll('[data-test="signed-in-switch-pane"]')
    expect(boxes.map((b) => [b.attributes('value'), b.element.checked])).toEqual([['p1', true], ['p2', true], ['p3', true], ['p4', true], ['p5', true]])
    await panel.get('[data-test="signed-in-switch-go"]').trigger('click')
    await flushPromises()
    expect(panes.switchTo.mock.calls).toEqual([['p1', 'acc-2'], ['p2', 'acc-2'], ['p3', 'acc-2'], ['p4', 'acc-2'], ['p5', 'acc-2']])
    // A check that changes something: the places read again.
    expect(listeners).toHaveLength(1)
    listeners[0]()
    await flushPromises()
    expect(window.shellApi.signedIn.places).toHaveBeenCalledTimes(2)
  })

  it('an active Max 20x: its plan, no notice; not checked yet: the login file’s plan as before', async () => {
    setup(pcWith(SUBS.max20, null))
    await open()
    const [added, system] = w.findAll('[data-test="signed-in-account"]')
    expect(system.get('[data-test="signed-in-plan"]').text()).toBe('Max 20x')
    expect(added.get('[data-test="signed-in-plan"]').text()).toBe('Max')
    expect(w.find('[data-test="signed-in-no-sub"]').exists()).toBe(false)
  })

  it('past due: its plan and "Payment issue"; the notice says so; with no other account, no Switch button but what to do', async () => {
    setup({ id: 'pc', kind: 'pc', state: 'ready', entries: [{ agent: 'claude', scope: 'system', id: null, email: 'late.fixture@example.invalid', plan: 'max', sub: SUBS.pastDue, state: 'signed-in' }] })
    await open()
    const account = w.get('[data-test="signed-in-account"]')
    expect(account.get('[data-test="signed-in-plan"]').text()).toBe('Max 5x')
    expect(account.get('[data-test="signed-in-plan-warn"]').text()).toBe('Payment issue')
    const notice = w.get('[data-test="signed-in-no-sub"]')
    expect(notice.text()).toContain('5 panes use an account with a payment issue')
    expect(notice.text()).toContain('Add an account with a subscription to move them.')
    expect(notice.find('[data-test="signed-in-no-sub-switch"]').exists()).toBe(false)
  })

  it('an account signed in here and on a host: this PC’s own check stands for it, never a host’s; hosts agree only by account id', () => {
    const host = (id, sub, account) => ({ id: `ssh:${id}`, kind: 'ssh', hostId: id, label: id, state: 'ready', entries: [{ agent: 'claude', scope: 'default', email: 'canceled.fixture@example.invalid', ...(account ? { account } : {}), sub, state: 'signed-in' }] })
    const newerFree = { ...SUBS.canceled, checkedAt: T + 3600_000 }
    // This PC active (its own check), a host newer and free: the PC's stands.
    let [claude] = groupByProvider([pcWith(SUBS.max20, null), host('h1', newerFree)])
    let account = claude.accounts.find((a) => a.email === 'canceled.fixture@example.invalid')
    expect(account.chips).toHaveLength(2)
    expect(account.sub).toMatchObject({ organization_type: 'claude_max' })
    // Signed in here but not checked here yet: no host's answer for it.
    ;[claude] = groupByProvider([pcWith(null, null), host('h1', newerFree)])
    expect(claude.accounts.find((a) => a.email === 'canceled.fixture@example.invalid').sub).toBeNull()
    // Hosts only: one account (the same id), the newest; two ids, none.
    const A = '1f0c6d1e-1111-4111-8111-111111111111'
    const B = '5f0c6d1e-5555-4555-8555-555555555555'
    expect(accountSub([{ place: { kind: 'ssh' }, entry: { sub: SUBS.max20, account: A } }, { place: { kind: 'ssh' }, entry: { sub: newerFree, account: A } }])).toMatchObject({ organization_type: 'claude_free' })
    expect(accountSub([{ place: { kind: 'ssh' }, entry: { sub: SUBS.max20, account: A } }, { place: { kind: 'ssh' }, entry: { sub: newerFree, account: B } }])).toBeNull()
    expect(accountSub([{ place: { kind: 'ssh' }, entry: { sub: SUBS.max20 } }, { place: { kind: 'ssh' }, entry: { sub: newerFree } }])).toBeNull()
    expect(accountSub([{ place: { kind: 'ssh' }, entry: { sub: newerFree } }])).toMatchObject({ organization_type: 'claude_free' })
  })

  it('a host’s answer flags only that host’s panes: never this PC’s, never its Switch panes or its ticks', async () => {
    const hostPlace = { id: 'ssh:h1', kind: 'ssh', hostId: 'h1', label: 'linux-box', state: 'ready', entries: [{ agent: 'claude', scope: 'default', id: null, email: 'canceled.fixture@example.invalid', sub: { ...SUBS.canceled, checkedAt: T + 3600_000 }, state: 'signed-in', removable: false, signOut: true }] }
    setup(pcWith(SUBS.max20, SUBS.max20))
    window.shellApi.signedIn.places = vi.fn(async () => ({ ok: true, places: [pcWith(SUBS.max20, SUBS.max20), hostPlace] }))
    const list = panes.list()
    list.push({ id: 'h-1', name: 'Host pane', agentId: 'claude', remoteHostId: 'h1' })
    await open()
    const account = w.findAll('[data-test="signed-in-account"]').find((a) => a.text().includes('canceled.fixture@example.invalid'))
    // Its tag: this PC's own check.
    expect(account.get('[data-test="signed-in-plan"]').text()).toBe('Max 20x')
    // The host's chip carries its own warning.
    const hostChip = account.findAll('[data-test="signed-in-chip"]').find((c) => c.text().includes('linux-box'))
    expect(hostChip.classes()).toContain('warn')
    expect(hostChip.attributes('title')).toContain('No subscription')
    // One pane flagged: the host's; this PC's 5 are not.
    const notice = w.get('[data-test="signed-in-no-sub"]')
    expect(notice.text()).toContain('1 pane uses an account with no subscription')
    // This PC's account still takes panes here (the 1 pane on the other account).
    expect(account.find('[data-test="signed-in-switch-open"]').exists()).toBe(true)
  })
})
