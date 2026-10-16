// The agents' accounts on SSH hosts in the window (hostAccounts.js): the
// account a pane there runs on (header, menu), the accounts it can restart
// on, and "Where you're signed in" grouped by account (signedInPlaces.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyHostAccounts, entryLabel, hostAccountChoices, hostEntry, hostPaneAccount, hostWatchers, planName, refreshHostAccounts, unwatchHostAccounts, validHostAccount, watchHostAccounts, checkHostAccountsNow, defaultHostAccount, hostAccountChoice, isDefaultHostAccount, setDefaultHostAccount, recheckAfterTurn, unnamedEntry, hostPaneFolder, PANE_BATCH_MS } from '../hostAccounts'
import { settings, loadSettings, validHostAccountDefaults } from '../settings'
import { accountKey, groupAccounts, panesOnLogin, switchTarget, switchablePanes } from '../signedInPlaces'

const own = { agent: 'claude', scope: 'default', dir: '/home/u/.claude', email: 'coreine13@gmail.com', org: "coreine13@gmail.com's Organization", plan: 'pro', cred: 'file', state: 'signed-in' }
const work = { agent: 'claude', scope: 'tessel', id: 'abc123', dir: '/home/u/.tessel-server/accounts/claude/abc123', email: 'work@corp.example', org: 'Corp', plan: 'max', cred: 'file', state: 'signed-in' }
const fresh = { agent: 'claude', scope: 'tessel', id: 'new999', dir: '/home/u/.tessel-server/accounts/claude/new999', state: 'empty' }
const codex = { agent: 'codex', scope: 'default', dir: '/home/u/.codex', email: 'dev@example.com', plan: 'plus', cred: 'file', state: 'signed-in' }

describe('hostAccounts', () => {
  beforeEach(() => applyHostAccounts('ssh-1', { ok: true, entries: [own, work, fresh, codex] }))

  it('the entry a pane runs on: its folder, else the host’s own sign-in (the login shell’s folder first)', () => {
    expect(hostEntry('ssh-1', 'claude', undefined)).toEqual(own)
    expect(hostEntry('ssh-1', 'claude', 'abc123')).toEqual(work)
    expect(hostEntry('ssh-1', 'claude', 'gone00')).toBeNull()
    expect(hostEntry('ssh-1', 'gemini', undefined)).toBeNull()
    applyHostAccounts('ssh-2', { ok: true, entries: [own, { ...own, scope: 'env', dir: '/opt/claude', email: 'env@example.com' }] })
    expect(hostEntry('ssh-2', 'claude', undefined).email).toBe('env@example.com')
  })

  it('header label: "name · Plan", the whole account and host in its title', () => {
    expect(hostPaneAccount('ssh-1', 'claude', undefined, 'box')).toEqual({
      name: 'coreine13 · Pro',
      title: "coreine13@gmail.com · Pro · coreine13@gmail.com's Organization, on box",
      signedIn: true,
      override: []
    })
    expect(hostPaneAccount('ssh-1', 'claude', 'abc123', 'box').name).toBe('work · Max')
    expect(hostPaneAccount('ssh-1', 'claude', 'new999', 'box')).toMatchObject({ name: 'not signed in yet', signedIn: false })
    expect(entryLabel({ ...own, cred: undefined, state: 'profile' }, 'box').title).toContain('signed out there')
    expect(entryLabel({ agent: 'copilot', scope: 'default', login: 'octocat', state: 'signed-in' }).name).toBe('@octocat')
    expect(planName('team')).toBe('Team')
    expect(planName('default_claude_max_20x')).toBe('Default Claude Max 20x')
  })

  it('restart choices: the host’s own sign-in and each folder signed in (never one waiting for a sign-in)', () => {
    const choices = hostAccountChoices('ssh-1', 'claude', 'box')
    expect(choices.map((c) => [c.id, c.name])).toEqual([
      [null, 'coreine13 · Pro'],
      ['abc123', 'work · Max']
    ])
    expect(choices[0].title).toContain('The host’s own sign-in')
    expect(hostAccountChoices('ssh-1', 'gemini', 'box')).toEqual([])
    expect(hostAccountChoices('ssh-unknown', 'claude', 'box')).toEqual([])
  })

  it('a failed read keeps what was known', () => {
    applyHostAccounts('ssh-1', { ok: false, error: 'timeout' })
    expect(hostEntry('ssh-1', 'claude', 'abc123')).toEqual(work)
  })

  it('validHostAccount: only a folder id', () => {
    expect(validHostAccount('abc123')).toBe('abc123')
    expect(validHostAccount('acct-b')).toBeUndefined()
    expect(validHostAccount('../x')).toBeUndefined()
    expect(validHostAccount(null)).toBeUndefined()
  })
})

describe('refreshHostAccounts', () => {
  let previous
  beforeEach(() => {
    previous = window.shellApi
  })
  afterEach(() => {
    window.shellApi = previous
  })
  it('one read per host for all its panes; asked again only after a while, or when asked fresh', async () => {
    const detect = vi.fn(async () => ({ ok: true, entries: [codex] }))
    window.shellApi = { remoteAccounts: { detect } }
    await Promise.all([refreshHostAccounts('ssh-r'), refreshHostAccounts('ssh-r')])
    await refreshHostAccounts('ssh-r')
    expect(detect).toHaveBeenCalledTimes(1)
    await refreshHostAccounts('ssh-r', { fresh: true })
    expect(detect).toHaveBeenCalledTimes(2)
    expect(detect).toHaveBeenLastCalledWith('ssh-r', { fresh: true })
    expect(hostEntry('ssh-r', 'codex', undefined)).toMatchObject({ email: 'dev@example.com' })
  })
})

describe('Where you’re signed in: grouped by account', () => {
  const pc = { id: 'pc', kind: 'pc', entries: [{ agent: 'claude', scope: 'system', id: null, email: 'coreine13@gmail.com', plan: 'pro', state: 'signed-in' }, { agent: 'claude', scope: 'tessel', id: 'uuid-1', email: 'work@corp.example', state: 'signed-in' }] }
  const host = { id: 'ssh:ssh-1', kind: 'ssh', hostId: 'ssh-1', label: 'box', entries: [own, work, fresh, codex] }
  const distro = { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', label: 'Ubuntu', entries: [{ agent: 'claude', scope: 'default', email: 'coreine13@gmail.com', state: 'profile' }, { agent: 'opencode', scope: 'default', providers: [{ name: 'anthropic', type: 'oauth' }], state: 'signed-in' }] }

  it('each account lists every place it is signed in, the same email per agent', () => {
    const { groups, unnamed } = groupAccounts([pc, distro, host])
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.place.id)])).toEqual([
      ['claude|coreine13@gmail.com', ['pc', 'wsl:Ubuntu', 'ssh:ssh-1']],
      ['claude|work@corp.example', ['pc', 'ssh:ssh-1']],
      ['codex|dev@example.com', ['ssh:ssh-1']]
    ])
    expect(groups[0].plan).toBe('pro')
    // A folder nobody signed in to is no account; OpenCode's providers have no name.
    expect(unnamed.map((r) => r.entry.agent)).toEqual(['opencode'])
    expect(accountKey({ agent: 'copilot', login: 'octocat' })).toBe('copilot|@octocat')
    expect(accountKey({ agent: 'kimi' })).toBeNull()
    expect(groupAccounts(null)).toEqual({ groups: [], unnamed: [] })
  })

  it('switch: which pane account a row stands for, and the panes not on it already', () => {
    expect(switchTarget(pc, pc.entries[0])).toEqual({ id: null })
    expect(switchTarget(pc, pc.entries[1])).toEqual({ id: 'uuid-1' })
    expect(switchTarget(host, work, host.entries)).toEqual({ id: 'abc123' })
    expect(switchTarget(host, own, host.entries)).toEqual({ id: null })
    expect(switchTarget(host, own, [...host.entries, { ...own, scope: 'env' }])).toBeNull()
    expect(switchTarget(host, fresh, host.entries)).toBeNull()
    expect(switchTarget(distro, distro.entries[0])).toBeNull()
    const panes = [
      { id: 'p1', name: 'Archimedes', agentId: 'claude', remoteHostId: 'ssh-1' },
      { id: 'p2', name: 'Bell', agentId: 'claude', remoteHostId: 'ssh-1', hostAccount: 'abc123' },
      { id: 'p3', name: 'Local', agentId: 'claude', remoteHostId: null, accountId: null },
      { id: 'p4', name: 'Other host', agentId: 'claude', remoteHostId: 'ssh-2' },
      { id: 'p5', name: 'Codex', agentId: 'codex', remoteHostId: 'ssh-1' }
    ]
    expect(switchablePanes(host, work, { id: 'abc123' }, panes).map((p) => p.id)).toEqual(['p1'])
    expect(switchablePanes(host, own, { id: null }, panes).map((p) => p.id)).toEqual(['p2'])
    expect(switchablePanes(pc, pc.entries[1], { id: 'uuid-1' }, panes).map((p) => p.id)).toEqual(['p3'])
    expect(switchablePanes(host, work, null, panes)).toEqual([])
  })
})

describe('one timer per host', () => {
  let previous, detect, answer
  beforeEach(() => {
    previous = window.shellApi
    vi.useFakeTimers()
    answer = { ok: true, entries: [own] }
    detect = vi.fn(async () => answer)
    window.shellApi = { remoteAccounts: { detect } }
  })
  afterEach(() => {
    vi.useRealTimers()
    window.shellApi = previous
  })

  it('the panes of a host share one timer: every minute, stopped with its last pane', async () => {
    watchHostAccounts('ssh-t1', 'p1', { agentId: 'claude' })
    watchHostAccounts('ssh-t1', 'p2', { agentId: 'claude' })
    await vi.advanceTimersByTimeAsync(0)
    expect(hostWatchers().filter((w) => w.hostId === 'ssh-t1')).toEqual([{ hostId: 'ssh-t1', panes: 2, wait: 0 }])
    expect(detect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(detect).toHaveBeenLastCalledWith('ssh-t1', { fresh: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(detect).toHaveBeenCalledTimes(3)
    unwatchHostAccounts('ssh-t1', 'p1')
    unwatchHostAccounts('ssh-t1', 'p2')
    expect(hostWatchers().some((w) => w.hostId === 'ssh-t1')).toBe(false)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(detect).toHaveBeenCalledTimes(3)
  })

  it('a pane waiting for a sign-in in its folder: sooner, then slower; the wait ends once it is signed in', async () => {
    answer = { ok: true, entries: [own, fresh] }
    watchHostAccounts('ssh-t2', 'p3', { agentId: 'claude', hostAccount: 'new999' })
    await vi.advanceTimersByTimeAsync(0)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t2').wait).toBe(15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(detect).toHaveBeenLastCalledWith('ssh-t2', { fresh: true })
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t2').wait).toBe(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t2').wait).toBe(60_000)
    // Signed in now (not merely an email: its login is there).
    answer = { ok: true, entries: [own, { ...fresh, email: 'n@example.com', state: 'profile' }] }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t2').wait).toBe(120_000)
    answer = { ok: true, entries: [own, { ...fresh, email: 'n@example.com', cred: 'file', state: 'signed-in' }] }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t2').wait).toBe(0)
    const n = detect.mock.calls.length
    await vi.advanceTimersByTimeAsync(59_000)
    expect(detect.mock.calls.length).toBe(n)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(detect).toHaveBeenLastCalledWith('ssh-t2', { fresh: false })
    unwatchHostAccounts('ssh-t2', 'p3')
  })

  it('a folder that is gone is no wait (never polled fast forever)', async () => {
    answer = { ok: true, entries: [own] }
    watchHostAccounts('ssh-t3', 'p4', { agentId: 'codex', hostAccount: 'gone00' })
    await vi.advanceTimersByTimeAsync(0)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-t3').wait).toBe(0)
    unwatchHostAccounts('ssh-t3', 'p4')
  })
})

describe('labels and logins', () => {
  it('a key or token set on the host is flagged on the account it overrides', () => {
    const l = entryLabel({ ...own, override: ['helper'] }, 'box', { claude: ['key'] })
    expect(l.name).toBe('coreine13 · Pro ⚠')
    expect(l.title).toContain('an API key helper, an API key')
    expect(entryLabel(own, 'box', { codex: ['key'] }).name).toBe('coreine13 · Pro')
  })

  it('the panes on a login: on its folder; on the agent’s own sign-in, the panes on no folder (unless the login shell names another folder); chats too', () => {
    const host = { kind: 'ssh', hostId: 'ssh-1', entries: [own, work] }
    const panes = [
      { id: 'p1', agentId: 'claude', remoteHostId: 'ssh-1' },
      { id: 'p2', agentId: 'claude', remoteHostId: 'ssh-1', hostAccount: 'abc123' },
      { id: 'c1', kind: 'chat', agentId: 'claude', remoteHostId: 'ssh-1', hostAccount: 'abc123' },
      { id: 'p3', agentId: 'codex', remoteHostId: 'ssh-1' },
      { id: 'p4', agentId: 'claude', remoteHostId: 'ssh-2' }
    ]
    expect(panesOnLogin(host, work, panes).map((p) => p.id)).toEqual(['p2', 'c1'])
    expect(panesOnLogin(host, own, panes).map((p) => p.id)).toEqual(['p1'])
    expect(panesOnLogin({ ...host, entries: [own, { ...own, scope: 'env' }] }, own, panes)).toEqual([])
    expect(panesOnLogin({ kind: 'pc' }, own, panes)).toEqual([])
    // A chat is stopped with its login, never switched from Settings.
    expect(switchablePanes(host, own, { id: null }, panes).map((p) => p.id)).toEqual(['p2'])
  })
})

describe('the account of a pane: not known yet, and the host’s default', () => {
  it('signed in but its email not read yet: its plan, and "not known yet" in the title, never "not signed in"', () => {
    const l = entryLabel({ agent: 'claude', scope: 'tessel', id: 'bd93c7f5566d', plan: 'max', cred: 'file', state: 'signed-in' }, 'box')
    expect(l).toMatchObject({ name: 'Max', signedIn: true, unknown: true })
    expect(l.title).toContain('not known yet')
    expect(entryLabel({ agent: 'claude', scope: 'tessel', id: 'x1', cred: 'file', state: 'signed-in' }, 'box').name).toBe('signed in')
    expect(entryLabel({ agent: 'claude', scope: 'tessel', id: 'x1', state: 'empty' }, 'box').name).toBe('not signed in yet')
    // Its email read: name · plan, the plan's own name in the title.
    const full = entryLabel({ agent: 'claude', scope: 'tessel', id: 'x1', email: 'coreine13@gmail.com', plan: 'max', planName: 'Claude Max', org: 'Org', cred: 'file', state: 'signed-in' }, 'box')
    expect(full.name).toBe('coreine13 · Max')
    expect(full.title).toContain('coreine13@gmail.com · Claude Max · Org')
  })

  it('a default per host and agent: kept in Settings, marked in the choices; null (the host’s own) keeps none', () => {
    settings.hostAccountDefaults = {}
    applyHostAccounts('ssh-d1', { ok: true, entries: [own, work] })
    expect(defaultHostAccount('ssh-d1', 'claude')).toBeUndefined()
    setDefaultHostAccount('ssh-d1', 'claude', 'abc123')
    expect(settings.hostAccountDefaults).toEqual({ 'ssh-d1': { claude: 'abc123' } })
    expect(defaultHostAccount('ssh-d1', 'claude')).toBe('abc123')
    expect(defaultHostAccount('ssh-d1', 'codex')).toBeUndefined()
    expect(isDefaultHostAccount('ssh-d1', 'claude', 'abc123')).toBe(true)
    expect(hostAccountChoices('ssh-d1', 'claude', 'box').map((c) => [c.id, c.isDefault])).toEqual([[null, false], ['abc123', true]])
    setDefaultHostAccount('ssh-d1', 'claude', null)
    expect(settings.hostAccountDefaults).toEqual({})
    expect(isDefaultHostAccount('ssh-d1', 'claude', null)).toBe(true)
    setDefaultHostAccount('../x', 'claude', 'abc123')
    setDefaultHostAccount('ssh-d1', 'gemini', 'abc123')
    expect(settings.hostAccountDefaults).toEqual({})
  })

  it('kept across restarts: only well-formed hosts, agents and folder ids', () => {
    expect(validHostAccountDefaults({ 'ssh-1': { claude: 'abc123', codex: 'def456', gemini: 'x' }, 'bad host!': { claude: 'abc123' }, 'ssh-2': { claude: '../x' }, 'ssh-3': 'nope' })).toEqual({ 'ssh-1': { claude: 'abc123', codex: 'def456' } })
    loadSettings({ hostAccountDefaults: { 'ssh-9': { claude: 'abc123' } } })
    expect(settings.hostAccountDefaults).toEqual({ 'ssh-9': { claude: 'abc123' } })
    settings.hostAccountDefaults = {}
  })

  it('hostAccountChoice: a folder id, null (the host’s own, chosen), else nothing chosen', () => {
    expect(hostAccountChoice('abc123')).toBe('abc123')
    expect(hostAccountChoice(null)).toBeNull()
    expect(hostAccountChoice(undefined)).toBeUndefined()
    expect(hostAccountChoice('../x')).toBeUndefined()
  })
})

describe('Check again', () => {
  let previous
  beforeEach(() => {
    previous = window.shellApi
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    window.shellApi = previous
  })
  it('asks the host now, past the last answer and the back-off', async () => {
    const detect = vi.fn(async () => ({ ok: true, entries: [own, fresh] }))
    window.shellApi = { remoteAccounts: { detect } }
    watchHostAccounts('ssh-c1', 'p9', { agentId: 'claude', hostAccount: 'new999' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-c1').wait).toBe(30_000)
    await checkHostAccountsNow('ssh-c1')
    expect(detect).toHaveBeenLastCalledWith('ssh-c1', { fresh: true })
    expect(hostWatchers().find((w) => w.hostId === 'ssh-c1').wait).toBe(15_000)
    unwatchHostAccounts('ssh-c1', 'p9')
  })
})

describe('an account signed in but not named yet, a folder linked elsewhere, Restart on the default', () => {
  let previous
  beforeEach(() => {
    previous = window.shellApi
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    window.shellApi = previous
    settings.hostAccountDefaults = {}
  })
  const unnamed = { agent: 'claude', scope: 'tessel', id: 'bd93c7f5566d', dir: '/home/u/.tessel-server/accounts/claude/bd93c7f5566d', plan: 'max', cred: 'file', state: 'signed-in' }

  it('signed in without its email: the host asked sooner (15 s, then slower), its own sign-in too; an API key is never named', async () => {
    expect(unnamedEntry(unnamed)).toBe(true)
    expect(unnamedEntry({ ...unnamed, email: 'max@example.com' })).toBe(false)
    expect(unnamedEntry({ ...unnamed, cred: undefined, method: 'apikey' })).toBe(false)
    const detect = vi.fn(async () => ({ ok: true, entries: [{ ...own, email: undefined }, unnamed] }))
    window.shellApi = { remoteAccounts: { detect } }
    watchHostAccounts('ssh-u1', 'p1', { agentId: 'claude' })
    await vi.advanceTimersByTimeAsync(0)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-u1').wait).toBe(15_000)
    // Named now: back to once a minute.
    detect.mockResolvedValue({ ok: true, entries: [own, { ...unnamed, email: 'max@example.com' }] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(hostWatchers().find((w) => w.hostId === 'ssh-u1').wait).toBe(0)
    unwatchHostAccounts('ssh-u1', 'p1')
  })

  it('back in Tessel (a sign-in finished in the browser): a host where a pane waits is asked at once', async () => {
    const detect = vi.fn(async () => ({ ok: true, entries: [own, fresh] }))
    window.shellApi = { remoteAccounts: { detect } }
    watchHostAccounts('ssh-f1', 'p2', { agentId: 'claude', hostAccount: 'new999' })
    await vi.advanceTimersByTimeAsync(0)
    const before = detect.mock.calls.length
    // Within the gap: not asked again.
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(detect.mock.calls.length).toBe(before)
    await vi.advanceTimersByTimeAsync(14_000)
    vi.setSystemTime(Date.now() + 30_000)
    const n = detect.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(detect.mock.calls.length).toBe(n + 1)
    expect(detect).toHaveBeenLastCalledWith('ssh-f1', { fresh: true })
    unwatchHostAccounts('ssh-f1', 'p2')
  })

  it('after a turn: asked again while its account is not signed in or not named, never sooner than the gap; never once named', async () => {
    const detect = vi.fn(async () => ({ ok: true, entries: [own, unnamed] }))
    window.shellApi = { remoteAccounts: { detect } }
    applyHostAccounts('ssh-t1', { ok: true, entries: [own, unnamed] })
    expect(recheckAfterTurn('ssh-t1', 'claude', 'bd93c7f5566d')).not.toBeNull()
    // Just answered: not before 20 s have passed since.
    await vi.advanceTimersByTimeAsync(4000)
    expect(detect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(detect).toHaveBeenCalledWith('ssh-t1', { fresh: true })
    expect(recheckAfterTurn('ssh-t1', 'claude', undefined)).toBeNull()
    expect(recheckAfterTurn('ssh-t1', 'gemini', undefined)).toBeNull()
  })

  it('after a turn: a few times at most while nothing changes; never for a Keychain profile, a sign-in with no entry, a folder removed', async () => {
    const detect = vi.fn(async () => ({ ok: true, entries: [own, fresh] }))
    window.shellApi = { remoteAccounts: { detect } }
    applyHostAccounts('ssh-t2', { ok: true, entries: [own, fresh] }, Date.now() - 60_000)
    const timers = []
    for (let i = 0; i < 5; i++) timers.push(recheckAfterTurn('ssh-t2', 'claude', 'new999'))
    expect(timers.filter(Boolean)).toHaveLength(3)
    // Signed in now (not named yet): a new state, its tries afresh.
    applyHostAccounts('ssh-t2', { ok: true, entries: [own, { ...fresh, cred: 'file', state: 'signed-in' }] }, Date.now() - 60_000)
    const again = recheckAfterTurn('ssh-t2', 'claude', 'new999')
    expect(again).not.toBeNull()
    // macOS Keychain: a profile only, no login file to see.
    applyHostAccounts('ssh-t3', { ok: true, entries: [{ ...own, cred: undefined, state: 'profile' }] }, Date.now() - 60_000)
    expect(recheckAfterTurn('ssh-t3', 'claude', undefined)).toBeNull()
    // No entry: a key in the environment, a folder removed.
    applyHostAccounts('ssh-t4', { ok: true, entries: [] }, Date.now() - 60_000)
    expect(recheckAfterTurn('ssh-t4', 'claude', undefined)).toBeNull()
    expect(recheckAfterTurn('ssh-t4', 'claude', 'gone123')).toBeNull()
    for (const tm of [...timers, again]) clearTimeout(tm)
  })

  it('the folder each pane’s agent runs on: the panes of a host asked together, once they stop coming', async () => {
    const paneFolders = vi.fn(async (hostId, list) => ({ ok: true, panes: Object.fromEntries(list.map((p) => [p.paneId, { found: 'yes', dir: null, folderId: null, own: true }])) }))
    window.shellApi = { remoteAccounts: { paneFolders } }
    const a = hostPaneFolder('ssh-b1', 'claude', 'pane-1')
    await vi.advanceTimersByTimeAsync(1000)
    const b = hostPaneFolder('ssh-b1', 'codex', 'pane-2')
    const c = hostPaneFolder('ssh-b1', 'claude', 'pane-1')
    const other = hostPaneFolder('ssh-b2', 'claude', 'pane-3')
    await vi.advanceTimersByTimeAsync(PANE_BATCH_MS)
    expect(paneFolders).toHaveBeenCalledTimes(2)
    expect(paneFolders).toHaveBeenCalledWith('ssh-b1', [{ paneId: 'pane-1', agent: 'claude' }, { paneId: 'pane-2', agent: 'codex' }])
    expect(paneFolders).toHaveBeenCalledWith('ssh-b2', [{ paneId: 'pane-3', agent: 'claude' }])
    expect(await a).toEqual({ ok: true, found: 'yes', dir: null, folderId: null, own: true })
    expect((await b).found).toBe('yes')
    expect(await c).toEqual(await a)
    expect((await other).ok).toBe(true)
    // Panes that keep coming: asked within a few seconds all the same.
    paneFolders.mockClear()
    for (let i = 0; i < 6; i++) {
      hostPaneFolder('ssh-b1', 'claude', `pane-k${i}`)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(paneFolders).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PANE_BATCH_MS)
    // The host not answering: each pane gets that answer.
    paneFolders.mockResolvedValue({ ok: false, notConnected: true })
    const d = hostPaneFolder('ssh-b3', 'claude', 'pane-9')
    await vi.advanceTimersByTimeAsync(PANE_BATCH_MS)
    expect(await d).toEqual({ ok: false, notConnected: true })
    expect(await hostPaneFolder('ssh-b3', 'gemini', 'pane-9')).toBeNull()
  })

  it('a folder whose sign-in file is a link: said, never a choice to start on', () => {
    const linked = { ...work, linked: true }
    applyHostAccounts('ssh-l1', { ok: true, entries: [own, linked] })
    expect(hostPaneAccount('ssh-l1', 'claude', 'abc123', 'box').title).toContain('is a link to another folder')
    expect(hostAccountChoices('ssh-l1', 'claude', 'box').map((c) => c.id)).toEqual([null])
  })

  it('the host’s default in Restart on: marked on its choice, only when signed in there', () => {
    applyHostAccounts('ssh-r1', { ok: true, entries: [own, work, fresh] })
    settings.hostAccountDefaults = { 'ssh-r1': { claude: 'abc123' } }
    expect(hostAccountChoices('ssh-r1', 'claude', 'box').find((c) => c.id === 'abc123')).toMatchObject({ name: 'work · Max', isDefault: true })
    // A default not signed in there: no choice for it.
    settings.hostAccountDefaults = { 'ssh-r1': { claude: 'new999' } }
    expect(hostAccountChoices('ssh-r1', 'claude', 'box').some((c) => c.isDefault)).toBe(false)
  })
})
