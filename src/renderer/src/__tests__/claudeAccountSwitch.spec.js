// Per-session Claude accounts in the window (App.vue): a pane restarted on
// another account (pane menu), and an older version's account switch
// finished by restarting the Claude sessions it started. Run on App.vue's
// own code, as missingAgentPane.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const code = slice('// Pane menu > Restart on <account>', '// Pane menu > Restart in Yolo / Restart asking first')

function load({ leaves = {}, accounts = {}, restart = async () => true } = {}) {
  const ctx = {
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    findLeaf: (id) => leaves[id] || null,
    restartingLeaves: new Set(),
    restartInPlace: vi.fn(restart),
    showToast: vi.fn(),
    refreshAccountChoices: vi.fn(),
    onMounted: () => {},
    onBeforeUnmount: () => {},
    window: { shellApi: { accounts }, addEventListener: () => {}, removeEventListener: () => {} },
    Promise
  }
  vm.runInNewContext(`${code}\nthis.api = { restartOnAccount, finishClaudeSwitch, checkClaudeSwitch }`, ctx)
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
    expect(env.showToast.mock.calls[0][0]).toContain('each on its own account')
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
    const [text, opts] = env.showToast.mock.calls[0]
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
    expect(env.showToast.mock.calls[0][1].action).toBeNull()
    expect(env.restartInPlace).toHaveBeenCalledWith('p1', { resume: true })
    // Nothing stopped (a check failed first): nothing to start again.
    accounts.finishClaudeSwitch.mockImplementation(async () => ({ ok: false, error: 'unreadable' }))
    env.restartInPlace.mockClear()
    await env.api.finishClaudeSwitch()
    expect(env.restartInPlace).not.toHaveBeenCalled()
    expect(env.showToast.mock.calls.at(-1)[1].action).toBeNull()
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
