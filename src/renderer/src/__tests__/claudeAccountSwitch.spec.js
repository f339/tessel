// Per-session Claude accounts in the window (App.vue): a pane restarted on
// another account (pane menu), and an older version's account switch
// finished by restarting the Claude sessions it started. Run on App.vue's
// own code, as missingAgentPane.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { HOST_ACCOUNT_AGENTS, validHostAccount } from '../hostAccounts'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const code = slice('// Pane menu > Restart on <account>', '// Pane menu > Restart in Yolo / Restart asking first')

function load({ leaves = {}, accounts = {}, remoteAccounts = null, restart = async () => true, splitLeaf = async () => ({ id: 'n1' }) } = {}) {
  const ctx = {
    HOST_ACCOUNT_AGENTS,
    validHostAccount,
    refreshHostAccounts: vi.fn(),
    splitLeaf: vi.fn(splitLeaf),
    agentById: (id) => ({ id, name: id === 'claude' ? 'Claude Code' : 'Codex' }),
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    findLeaf: (id) => leaves[id] || null,
    restartingLeaves: new Set(),
    restartInPlace: vi.fn(restart),
    showToast: vi.fn(),
    refreshAccountChoices: vi.fn(),
    onMounted: () => {},
    onBeforeUnmount: () => {},
    window: { shellApi: { accounts, ...(remoteAccounts ? { remoteAccounts } : {}) }, addEventListener: () => {}, removeEventListener: () => {} },
    Promise
  }
  vm.runInNewContext(`${code}\nthis.api = { restartOnAccount, signInOnHost, finishClaudeSwitch, checkClaudeSwitch }`, ctx)
  return ctx
}
const claude = (extra = {}) => ({ id: 'p1', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Claude Code', ...extra })

describe('pane menu > Restart on <account>', () => {
  it('restarts a Claude Code pane on the account chosen, its conversation resumed', async () => {
    const env = load({ leaves: { p1: claude() } })
    await env.api.restartOnAccount('p1', 'acct-b')
    expect(env.restartInPlace).toHaveBeenCalledWith('p1', { resume: true, accountId: 'acct-b' })
    await env.api.restartOnAccount('p1', null)
    expect(env.restartInPlace).toHaveBeenLastCalledWith('p1', { resume: true, accountId: null })
    expect(env.showToast).not.toHaveBeenCalled()
  })

  it('never for a Codex pane (its account keeps its own conversations), one on an SSH host, or a bad account', async () => {
    const env = load({ leaves: { c: claude({ id: 'c', agentId: 'codex' }), s: claude({ id: 's', remoteHostId: 'h1' }), p1: claude() } })
    await env.api.restartOnAccount('c', 'acct-b')
    await env.api.restartOnAccount('s', 'acct-b')
    await env.api.restartOnAccount('p1', 42)
    expect(env.restartInPlace).not.toHaveBeenCalled()
  })

  it('on an SSH host: Claude Code goes on with its conversation on a host account (null: the host’s own sign-in), Codex starts a new one', async () => {
    const env = load({ leaves: { s: claude({ id: 's', remoteHostId: 'ssh-1' }), x: claude({ id: 'x', agentId: 'codex', agentCommand: 'codex', remoteHostId: 'ssh-1' }), g: claude({ id: 'g', agentId: 'gemini', remoteHostId: 'ssh-1' }) } })
    await env.api.restartOnAccount('s', 'abc123')
    expect(env.restartInPlace).toHaveBeenLastCalledWith('s', { resume: true, hostAccount: 'abc123' })
    await env.api.restartOnAccount('s', null)
    expect(env.restartInPlace).toHaveBeenLastCalledWith('s', { resume: true, hostAccount: undefined })
    await env.api.restartOnAccount('x', 'def456')
    expect(env.restartInPlace).toHaveBeenLastCalledWith('x', { resume: false, hostAccount: 'def456' })
    expect(env.refreshHostAccounts).toHaveBeenCalledWith('ssh-1', { fresh: true })
    // Not an account folder id, or an agent with no account folders: nothing.
    await env.api.restartOnAccount('s', '../x')
    await env.api.restartOnAccount('g', 'abc123')
    expect(env.restartInPlace).toHaveBeenCalledTimes(3)
  })

  it('sign in to another account on a host: a new folder there, the agent opened in it next to the pane', async () => {
    const remoteAccounts = { create: vi.fn(async () => ({ ok: true, id: 'a1b2c3' })) }
    const env = load({ leaves: { s: claude({ id: 's', remoteHostId: 'ssh-1', remotePath: '/srv/app', shellId: 'pwsh' }), p1: claude() }, remoteAccounts })
    await env.api.signInOnHost('s')
    expect(remoteAccounts.create).toHaveBeenCalledWith('ssh-1', 'claude')
    expect(env.splitLeaf).toHaveBeenCalledWith('s', 'row', expect.objectContaining({ id: 'claude', command: 'claude' }), 'pwsh', null, { hostAccount: 'a1b2c3', remoteHostId: 'ssh-1', remotePath: '/srv/app', inheritView: true })
    // A pane on this PC: never.
    await env.api.signInOnHost('p1')
    expect(remoteAccounts.create).toHaveBeenCalledTimes(1)
    // The folder could not be made: said, nothing opened.
    remoteAccounts.create.mockResolvedValueOnce({ ok: false, error: 'not connected' })
    await env.api.signInOnHost('s')
    expect(env.splitLeaf).toHaveBeenCalledTimes(1)
    expect(env.showToast.mock.calls.at(-1)[0]).toContain('not connected')
  })

  it("says the terminal did not stop only when that is what happened (a refused start already said why)", async () => {
    let answer = false
    const env = load({ leaves: { p1: claude() }, restart: async () => answer })
    await env.api.restartOnAccount('p1', 'acct-b')
    expect(env.showToast).toHaveBeenCalledTimes(1)
    expect(env.showToast.mock.calls[0][0]).toContain('its terminal did not stop')
    answer = null
    await env.api.restartOnAccount('p1', 'acct-b')
    expect(env.showToast).toHaveBeenCalledTimes(1)
  })
})

describe('a restart in place (the real restartInPlaceNow)', () => {
  const restartNow = (() => {
    const a = source.indexOf('async function restartInPlaceNow(leafId, opts) {')
    const b = source.indexOf('\n}\n', a)
    if (a < 0 || b < 0) throw new Error('App.vue changed: restartInPlaceNow')
    return source.slice(a, b + 3)
  })()
  function run(opts, created = { id: 'p1' }) {
    const old = claude({ accountId: 'acct-a', sessionId: 's1', shellId: 'pwsh' })
    const ws = { tree: old }
    const createLeaf = vi.fn(async () => created)
    const ctx = {
      findLeaf: (id) => (id === 'p1' ? ws.tree : null),
      wsOfLeaf: () => ws,
      window: { shellApi: { killPty: vi.fn(), attachPty: async () => ({ ok: false }) } },
      dropBuffer: () => {},
      clearAgentStatus: () => {},
      createLeaf,
      setDraft: () => {},
      replaceNode: (tree, id, make) => make(tree),
      teamToolsVersion: 'v',
      setTimeout: (fn) => fn(),
      Promise,
      Date
    }
    vm.runInNewContext(`${restartNow}\nthis.go = (o) => restartInPlaceNow('p1', o)`, ctx)
    return ctx.go(opts).then((ok) => ({ ok, createLeaf }))
  }

  it('starts on the account asked for; on its own account otherwise', async () => {
    let r = await run({ resume: true, accountId: 'acct-b' })
    expect(r.ok).toBe(true)
    expect(r.createLeaf.mock.calls[0][4]).toMatchObject({ id: 'p1', accountId: 'acct-b', sessionId: 's1', resume: true })
    r = await run({ resume: true, accountId: null })
    expect(r.createLeaf.mock.calls[0][4].accountId).toBeNull()
    r = await run({ resume: true })
    expect(r.createLeaf.mock.calls[0][4].accountId).toBe('acct-a')
  })

  it('on an SSH host: on the host account asked for (undefined: the host’s own), else its own', async () => {
    let r = await run({ resume: true, hostAccount: 'abc123' })
    expect(r.createLeaf.mock.calls[0][4]).toMatchObject({ hostAccount: 'abc123' })
    r = await run({ resume: true, hostAccount: undefined })
    expect('hostAccount' in r.createLeaf.mock.calls[0][4]).toBe(true)
    expect(r.createLeaf.mock.calls[0][4].hostAccount).toBeUndefined()
  })

  it('a start that was refused: null, not "its terminal did not stop"', async () => {
    expect((await run({ resume: true }, null)).ok).toBeNull()
  })

  it('a plain Restart keeps its account and never reads a missing opts', () => {
    const a = source.indexOf('async function restartLeaf(leafId) {')
    const b = source.indexOf('\n}\n', a)
    expect(a).toBeGreaterThan(0)
    expect(source.slice(a, b)).not.toMatch(/\bopts\b/)
  })
})

describe('an older version\'s account switch', () => {
  it('stops the sessions it started, then starts each again on its account', async () => {
    const accounts = {
      claudeSwitch: vi.fn(async () => ({ pending: true, panes: ['p1', 'orphan'] })),
      finishClaudeSwitch: vi.fn(async () => ({ ok: true })),
      discardClaudeSwitch: vi.fn()
    }
    const env = load({ leaves: { p1: claude() }, accounts })
    await env.api.finishClaudeSwitch()
    expect(accounts.finishClaudeSwitch).toHaveBeenCalledTimes(1)
    // A terminal no pane shows is only stopped.
    expect(env.restartInPlace.mock.calls).toEqual([['p1', { resume: true }]])
    // Said at once, then when done.
    expect(env.showToast.mock.calls[0][0]).toBe('Restarting the Claude sessions (2)…')
    expect(env.showToast.mock.calls[1][0]).toContain('each on its own account')
    expect(env.refreshAccountChoices).toHaveBeenCalled()
  })

  it('its snapshot unusable (nothing stopped): offers to give the old sign-in up, then starts the sessions again', async () => {
    const accounts = {
      claudeSwitch: vi.fn(async () => ({ pending: true, panes: ['p1'] })),
      finishClaudeSwitch: vi.fn(async () => ({ ok: false, error: 'snapshot is unavailable or invalid', snapshotInvalid: true })),
      discardClaudeSwitch: vi.fn(async () => ({ ok: true, signedOut: true, stopped: true }))
    }
    const env = load({ leaves: { p1: claude() }, accounts })
    await env.api.finishClaudeSwitch()
    expect(env.restartInPlace).not.toHaveBeenCalled()
    const [text, opts] = env.showToast.mock.calls[1]
    expect(text).toContain('snapshot is unavailable or invalid')
    expect(opts.kind).toBe('error')
    expect(opts.action.label).toBe('Give up the old sign-in')
    await opts.action.run()
    expect(accounts.discardClaudeSwitch).toHaveBeenCalledTimes(1)
    expect(env.restartInPlace).toHaveBeenCalledWith('p1', { resume: true })
    expect(env.showToast.mock.calls.at(-1)[0]).toContain('signed out of Claude')
  })

  it('any other failure: nothing given up; sessions already stopped start again', async () => {
    const accounts = {
      claudeSwitch: vi.fn(async () => ({ pending: true, panes: ['p1'] })),
      finishClaudeSwitch: vi.fn(async () => ({ ok: false, error: 'changed during the operation', stopped: true })),
      discardClaudeSwitch: vi.fn()
    }
    const env = load({ leaves: { p1: claude() }, accounts })
    await env.api.finishClaudeSwitch()
    expect(env.showToast.mock.calls[1][1].action).toBeNull()
    expect(env.restartInPlace).toHaveBeenCalledWith('p1', { resume: true })
    // Nothing stopped (a check failed first): nothing to start again.
    accounts.finishClaudeSwitch.mockImplementation(async () => ({ ok: false, error: 'unreadable' }))
    env.restartInPlace.mockClear()
    await env.api.finishClaudeSwitch()
    expect(env.restartInPlace).not.toHaveBeenCalled()
    expect(env.showToast.mock.calls.at(-1)[1].action).toBeNull()
  })

  it('from the button, every outcome is said: nothing to do, already running, or not available yet', async () => {
    let answer = { pending: false, panes: [] }
    const accounts = { claudeSwitch: vi.fn(async () => answer), finishClaudeSwitch: vi.fn(() => new Promise(() => {})), discardClaudeSwitch: vi.fn() }
    const env = load({ leaves: { p1: claude() }, accounts })
    await env.api.finishClaudeSwitch()
    expect(env.showToast.mock.calls.at(-1)[0]).toContain('already runs on its own account')
    answer = { pending: false, panes: [], error: 'unreadable' }
    await env.api.finishClaudeSwitch()
    expect(env.showToast.mock.calls.at(-1)[0]).toContain('unreadable')
    // A restart already under way (it never ends here): the second click says so.
    answer = { pending: true, panes: ['p1'] }
    void env.api.finishClaudeSwitch()
    await new Promise((r) => setImmediate(r))
    await env.api.finishClaudeSwitch()
    expect(env.showToast.mock.calls.at(-1)[0]).toContain('already being restarted')
    expect(accounts.finishClaudeSwitch).toHaveBeenCalledTimes(1)
    // A window from before the update: Tessel has to start again.
    const old = load({ leaves: {}, accounts: {} })
    await old.api.finishClaudeSwitch()
    expect(old.showToast.mock.calls[0][0]).toContain('Restart Tessel')
  })

  it('at startup: offers to restart the sessions it waits for; none: finished at once', async () => {
    const accounts = {
      claudeSwitch: vi.fn(async () => ({ pending: true, panes: ['p1', 'p2'] })),
      finishClaudeSwitch: vi.fn(async () => ({ ok: true })),
      discardClaudeSwitch: vi.fn()
    }
    const env = load({ leaves: { p1: claude() }, accounts })
    await env.api.checkClaudeSwitch()
    expect(accounts.finishClaudeSwitch).not.toHaveBeenCalled()
    const [text, opts] = env.showToast.mock.calls[0]
    expect(text).toContain('2 Claude sessions started before the update')
    await opts.action.run()
    expect(accounts.finishClaudeSwitch).toHaveBeenCalledTimes(1)

    accounts.claudeSwitch.mockImplementation(async () => ({ pending: true, panes: [] }))
    await env.api.checkClaudeSwitch()
    expect(accounts.finishClaudeSwitch).toHaveBeenCalledTimes(2)

    accounts.claudeSwitch.mockImplementation(async () => ({ pending: false, panes: [] }))
    await env.api.checkClaudeSwitch()
    expect(accounts.finishClaudeSwitch).toHaveBeenCalledTimes(2)
  })
})
