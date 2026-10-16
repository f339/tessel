// @vitest-environment node
// A terminal re-attached (main's pty:attach, run from index.js's own code): the
// output queued before its snapshot is dropped the moment the answer is read
// (it is in the snapshot), what follows is kept and reaches the window only
// after the answer has gone (sent first, the snapshot would have replaced it),
// and the replay is cut to what the window keeps of a pane.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { PANE_HISTORY_CHARS } from '../../shared/paneHistory'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
function slice(from, to) {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`index.js changed: ${from}`)
  return main.slice(a, b)
}

function load({ registerDelay = null } = {}) {
  const handlers = {}
  const sent = []
  const timers = []
  let answer = null
  const host = {
    // The host's answer, read with output around it (ptyClient: onReply runs
    // as the answer is read, before the lines after it).
    request: vi.fn((op, body, _timeout, onReply) => new Promise((resolve) => (answer = { body, onReply, resolve })))
  }
  const ctx = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    send: (channel, payload) => sent.push([channel, payload]),
    setTimeout: (fn) => timers.push(fn),
    host,
    liveShare: null,
    ptyInfo: new Map(),
    revokeTeamSecret: vi.fn(),
    setTeamSecret: vi.fn(),
    remoteHosts: { paneStarted: vi.fn() },
    agentStateStore: { register: vi.fn(() => registerDelay || Promise.resolve()) },
    windowsBuildNumber: () => 26200,
    PANE_HISTORY_CHARS,
    Date,
    Math,
    log: { info: vi.fn() }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('const pendingData = new Map()', '// Live Share (liveShare.js)') +
      slice('const attachStats = {', '// After the interface restores its panes') +
      '\nthis.api = { queueData, flushData }',
    ctx
  )
  const flush = () => timers.splice(0).forEach((fn) => fn())
  return { ctx, handlers, sent, flush, api: ctx.api, reply: (r) => (answer.onReply(r), answer.resolve(r)), asked: () => answer && answer.body }
}

describe('pty:attach', () => {
  it('drops the output its snapshot holds, then sends what follows only after its answer', async () => {
    let releaseRegister
    const env = load({ registerDelay: new Promise((r) => (releaseRegister = r)) })
    const attaching = env.handlers['pty:attach'](null, 'pane-1')
    expect(env.asked()).toEqual({ id: 'pane-1', maxChars: PANE_HISTORY_CHARS })
    // Before the snapshot: in it already.
    env.api.queueData('pane-1', 'old ')
    // Another pane's output is not held.
    env.api.queueData('pane-2', 'other')
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'SCREEN', agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 })
    // Read right after the answer, in the same read: after the snapshot.
    env.api.queueData('pane-1', 'new')
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-2', data: 'other' }]])
    // Its answer is still on its way (registering its agent state): held.
    await Promise.resolve()
    env.flush()
    expect(env.sent).toHaveLength(1)
    releaseRegister()
    const res = await attaching
    expect(res).toMatchObject({ ok: true, buffer: 'SCREEN', pid: 7 })
    // Now the output after the snapshot goes, once, without what it held.
    env.flush()
    expect(env.sent).toEqual([
      ['pty:data', { id: 'pane-2', data: 'other' }],
      ['pty:data', { id: 'pane-1', data: 'new' }]
    ])
  })

  it('cuts the replay to what the window keeps of a pane (an older host sends it all)', async () => {
    const env = load()
    const attaching = env.handlers['pty:attach'](null, 'pane-1')
    const long = 'a'.repeat(50) + 'b'.repeat(PANE_HISTORY_CHARS)
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: long })
    const res = await attaching
    expect(res.buffer).toHaveLength(PANE_HISTORY_CHARS)
    expect(res.buffer).toBe('b'.repeat(PANE_HISTORY_CHARS))
  })

  it('a terminal that is gone releases nothing and keeps its output flowing', async () => {
    const env = load()
    const attaching = env.handlers['pty:attach'](null, 'pane-9')
    env.api.queueData('pane-9', 'x')
    env.reply({ ok: false, error: 'not found' })
    expect(await attaching).toEqual({ ok: false })
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-9', data: 'x' }]])
  })
})
