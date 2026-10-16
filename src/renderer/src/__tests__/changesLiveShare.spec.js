// Source Control (ChangesPanel.vue) on a Live Share host's project (an
// lshare:// root): stage, unstage, discard and commit only with the host's git
// right, live; never push, pull, sync, Generate or Create PR; the access taken
// away or a host's Tessel too old said instead of the list; a local project
// as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChangesPanel from '../components/ChangesPanel.vue'
import { setTasks } from '../taskBoardStore'
import { scmStatus } from '../scmState'
import { setLshareAccess, forgetLshareAccess } from '../liveShareGuestAccess'

const ROOT = 'lshare://p1'
let w
let calls

const ENTRIES = [
  { path: 'a.js', area: 'unstaged', status: 'modified', added: 2, removed: 1 },
  { path: 'src/b.js', area: 'staged', status: 'added', added: 4, removed: 0 },
  { path: 'n.txt', area: 'untracked', status: 'untracked' }
]
function status(extra = {}) {
  // Ahead of its upstream: locally the main button would offer Push.
  return { ok: true, repo: true, top: ROOT, branch: 'main', hasUpstream: true, upstream: 'origin/main', ahead: 2, behind: 0, remotes: ['origin'], entries: ENTRIES, ...extra }
}
function api(statusFn = () => status()) {
  calls = []
  const rec = (name, fn) =>
    vi.fn(async (q) => {
      calls.push([name, q])
      return fn(q)
    })
  window.shellApi = {
    scm: {
      status: rec('status', statusFn),
      stage: rec('stage', () => ({ ok: true })),
      unstage: rec('unstage', () => ({ ok: true })),
      discard: rec('discard', () => ({ ok: true })),
      commit: rec('commit', () => ({ ok: true })),
      push: rec('push', () => ({ ok: true })),
      pull: rec('pull', () => ({ ok: true })),
      sync: rec('sync', () => ({ ok: true })),
      fetch: rec('fetch', () => ({ ok: true })),
      generate: rec('generate', () => ({ ok: true, message: 'm' }))
    },
    writeClipboard: vi.fn(),
    openExternal: vi.fn()
  }
}
function make(props = {}) {
  w = mount(ChangesPanel, {
    props: { root: ROOT, ...props },
    attachTo: document.body,
    global: { provide: { askConfirm: async () => true } }
  })
  return w
}
const has = (sel) => w.find(`[data-test="${sel}"]`).exists()
const row = (path, area) => w.find(`[data-test="changes-row"][data-path="${path}"][data-area="${area}"]`)

beforeEach(() => {
  setTasks([])
  forgetLshareAccess()
  for (const k of Object.keys(scmStatus)) delete scmStatus[k]
})
afterEach(() => {
  w?.unmount()
  w = null
  delete window.shellApi
  forgetLshareAccess()
  document.body.innerHTML = ''
})

describe("a Live Share host's project", () => {
  it('shows its changes read-only until the host gives the git right: no stage, discard or commit', async () => {
    api()
    make()
    await flushPromises()
    expect(row('a.js', 'unstaged').exists()).toBe(true)
    expect(has('sc-read-only')).toBe(true)
    expect(has('sc-commit')).toBe(false)
    expect(has('sc-stage')).toBe(false)
    expect(has('sc-unstage')).toBe(false)
    expect(has('sc-discard')).toBe(false)
    expect(has('sc-stage-all')).toBe(false)
    expect(has('sc-discard-all')).toBe(false)
    expect(has('sc-dir-stage')).toBe(false)
    // A diff still opens.
    await row('a.js', 'unstaged').trigger('click')
    expect(w.emitted('open-diff')[0][0]).toMatchObject({ root: ROOT, rel: 'a.js', area: 'unstaged' })
  })

  it('the git right given, then taken back: stage and commit come and go live', async () => {
    api()
    make()
    await flushPromises()
    setLshareAccess('p1', { git: true })
    await flushPromises()
    expect(has('sc-read-only')).toBe(false)
    expect(has('sc-commit')).toBe(true)
    await row('a.js', 'unstaged').find('[data-test="sc-stage"]').trigger('click')
    await flushPromises()
    expect(calls.filter(([n]) => n === 'stage')).toEqual([['stage', { root: ROOT, paths: ['a.js'] }]])
    setLshareAccess('p1', { git: false })
    await flushPromises()
    expect(has('sc-commit')).toBe(false)
    expect(has('sc-stage')).toBe(false)
  })

  it("a status saying read-only keeps it read-only, whatever the right", async () => {
    api(() => status({ readOnly: true }))
    setLshareAccess('p1', { git: true })
    make()
    await flushPromises()
    expect(has('sc-read-only')).toBe(true)
    expect(has('sc-stage')).toBe(false)
  })

  it('with the git right: commit only, never push, pull, sync, Generate or Create PR', async () => {
    api(() => status({ entries: [{ path: 'src/b.js', area: 'staged', status: 'added', added: 4, removed: 0 }] }))
    setLshareAccess('p1', { git: true })
    make()
    await flushPromises()
    // Ahead of its upstream, nothing to commit: locally Push; here nothing to do.
    const primary = w.get('[data-test="sc-primary"]')
    expect(primary.text()).not.toMatch(/Push|Sync|Publish|Pull/)
    expect(has('sc-chevron')).toBe(false)
    expect(has('sc-generate')).toBe(false)
    expect(has('sc-create-pr')).toBe(false)
    await w.get('[data-test="sc-more"]').trigger('click')
    expect(document.body.textContent).not.toContain('Create PR…')
    await w.get('[data-test="sc-commit-message"]').setValue('Guest commit')
    await w.get('[data-test="sc-primary"]').trigger('click')
    await flushPromises()
    expect(calls.filter(([n]) => n === 'commit')).toEqual([['commit', { root: ROOT, message: 'Guest commit' }]])
    expect(calls.some(([n]) => ['push', 'pull', 'sync', 'fetch', 'generate'].includes(n))).toBe(false)
  })

  it('"You no longer have access to this project": said instead of the list, nothing asked; given back, read again', async () => {
    api()
    make()
    await flushPromises()
    setLshareAccess('p1', { state: 'no-access' })
    await flushPromises()
    expect(w.get('[data-test="changes-access"]').text()).toContain('You no longer have access to this project.')
    expect(row('a.js', 'unstaged').exists()).toBe(false)
    const before = calls.filter(([n]) => n === 'status').length
    setLshareAccess('p1', { state: 'ok' })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0))
    await flushPromises()
    expect(calls.filter(([n]) => n === 'status').length).toBeGreaterThan(before)
    expect(has('changes-access')).toBe(false)
    expect(row('a.js', 'unstaged').exists()).toBe(true)
  })

  it("the host's own refusal codes: no access, a Tessel too old", async () => {
    api(() => ({ ok: false, code: 'no-access', error: 'refused' }))
    make()
    await flushPromises()
    expect(w.get('[data-test="changes-access"]').text()).toContain('You no longer have access to this project.')
    w.unmount()
    for (const k of Object.keys(scmStatus)) delete scmStatus[k]
    api(() => ({ ok: false, code: 'outdated-host' }))
    make()
    await flushPromises()
    expect(w.get('[data-test="changes-access"]').text()).toMatch(/host’s Tessel is too old/)
  })

  it("lists none of this computer's task copies", async () => {
    setTasks([{ id: 't1', title: 'Copy task', column: 'doing', worktree: { path: 'C:\\copies\\t1', branch: 'x' } }])
    api()
    make()
    await flushPromises()
    expect(has('changes-target')).toBe(false)
  })
})

describe('a local project', () => {
  it('is exactly as before: every action, Push offered, Generate there; an answer never makes it read-only', async () => {
    api(() => ({ ...status({ readOnly: true }), top: 'C:\\proj' }))
    make({ root: 'C:\\proj' })
    await flushPromises()
    expect(has('sc-read-only')).toBe(false)
    expect(has('sc-commit')).toBe(true)
    expect(has('sc-chevron')).toBe(true)
    expect(has('sc-generate')).toBe(true)
    expect(has('sc-create-pr')).toBe(true)
    expect(row('a.js', 'unstaged').find('[data-test="sc-stage"]').exists()).toBe(true)
  })

  it('the readOnly prop alone makes it read-only', async () => {
    api(() => ({ ...status(), top: 'C:\\proj' }))
    make({ root: 'C:\\proj', readOnly: true })
    await flushPromises()
    expect(has('sc-read-only')).toBe(true)
    expect(has('sc-stage')).toBe(false)
  })
})
