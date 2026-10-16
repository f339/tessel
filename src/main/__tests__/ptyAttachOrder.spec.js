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
import { trimBuffer } from '../ptyProtocol'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
function slice(from, to) {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`index.js changed: ${from}`)
  return main.slice(a, b)
}

// Every promise settled (a later turn of the loop).
const turn = () => new Promise((r) => setImmediate(r))

function load({ registerDelay = null } = {}) {
  const handlers = {}
  const sent = []
  const timers = []
  const answers = []
  const host = {
    // The host's answer, read with output around it (ptyClient: onReply runs
    // as the answer is read, before the lines after it).
    request: vi.fn((op, body, _timeout, onReply) => new Promise((resolve, reject) => answers.push({ body, onReply, resolve, reject })))
  }
  const ctx = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    send: (channel, payload) => sent.push([channel, payload]),
    setTimeout: (fn, ms = 0) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: (n) => n && timers[n - 1] && (timers[n - 1].fn = () => {}),
    trimBuffer,
    host,
    liveShare: null,
    ptyInfo: new Map(),
    revokeTeamSecret: vi.fn(),
    setTeamSecret: vi.fn(),
    remoteHosts: { paneStarted: vi.fn() },
    agentStateStore: { register: vi.fn(() => registerDelay || Promise.resolve()), unregister: vi.fn(async () => {}) },
    windowsBuildNumber: () => 26200,
    PANE_HISTORY_CHARS,
    Date,
    Math,
    endedPtyPids: new Set(),
    installLogs: { onExit: vi.fn() },
    sshAskpass: { paneExited: vi.fn() },
    remoteAgentCheck: { paneExited: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn() }
  }
  ctx.remoteHosts.paneExited = vi.fn()
  vm.createContext(ctx)
  // The host's exit notice, as createPtyClient gets it in index.js.
  const onExit = slice('  onExit: (id, exitCode, signal, pid) => {', '  // ssh2 connections')
  vm.runInContext(
    slice('const pendingData = new Map()', '// Live Share (liveShare.js)') +
      slice('const attachStats = {', '// After the interface restores its panes') +
      '\nthis.api = { queueData, flushData, ...{' + onExit + '} }',
    ctx
  )
  // The output timers (8 ms) and the exit's turn; a long wait only with wait().
  const run = (long) => {
    for (const t of timers) if (!t.done && (long || t.ms < 1000)) (t.done = true), t.fn()
  }
  const flush = () => run(false)
  const wait = () => run(true)
  // The answer to the n-th request (the last one by default).
  const reply = (r, n = answers.length - 1) => {
    const a = answers[n]
    if (a.onReply) a.onReply(r)
    a.resolve(r)
  }
  const fail = (err, n = answers.length - 1) => answers[n].reject(err)
  return { ctx, handlers, sent, flush, wait, api: ctx.api, reply, fail, asked: (n = answers.length - 1) => answers[n] && answers[n].body }
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

  it('an end that comes while its answer is on its way follows the answer, after the last output', async () => {
    let releaseRegister
    const env = load({ registerDelay: new Promise((r) => (releaseRegister = r)) })
    const attaching = env.handlers['pty:attach'](null, 'pane-1')
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'SCREEN', agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 })
    // In the same read: its last output, then its end.
    env.api.queueData('pane-1', 'FINAL OUTPUT')
    env.api.onExit('pane-1', 3, 0, 7)
    await Promise.resolve()
    env.flush()
    // Nothing of it before the answer (still registering its agent state).
    expect(env.sent).toEqual([])
    expect(env.ctx.agentStateStore.unregister).not.toHaveBeenCalled()
    releaseRegister()
    const res = await attaching
    // The answer says it ended.
    expect(res).toMatchObject({ ok: true, buffer: 'SCREEN', exited: true, exitCode: 3 })
    expect(env.sent).toEqual([])
    env.flush()
    expect(env.sent).toEqual([
      ['pty:data', { id: 'pane-1', data: 'FINAL OUTPUT' }],
      ['pty:exit', { id: 'pane-1', exitCode: 3, signal: 0, pid: 7 }]
    ])
    // Its state, secret and logs are closed after it was registered.
    expect(env.ctx.agentStateStore.unregister).toHaveBeenCalledWith('pane-1', 'tok')
    expect(env.ctx.setTeamSecret.mock.invocationCallOrder[0]).toBeLessThan(env.ctx.revokeTeamSecret.mock.invocationCallOrder[0])
    // Another pane's end is not held.
    env.api.onExit('pane-2', 0, 0, 8)
    expect(env.sent.at(-1)).toEqual(['pty:exit', { id: 'pane-2', exitCode: 0, signal: 0, pid: 8 }])
  })

  it('a page reloaded while it restored asks again: the first answer to go does not let the output pass the second', async () => {
    let releaseSecond
    const env = load()
    env.ctx.agentStateStore.register = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => new Promise((r) => (releaseSecond = r)))
    const answer = { ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 }
    const first = env.handlers['pty:attach'](null, 'pane-1')
    const second = env.handlers['pty:attach'](null, 'pane-1')
    env.reply({ ...answer, buffer: 'SCREEN-1' }, 0)
    env.reply({ ...answer, buffer: 'SCREEN-2' }, 1)
    // After the second snapshot.
    env.api.queueData('pane-1', 'after both')
    // The first answer goes, the second is still on its way.
    await first
    await turn()
    env.flush()
    expect(env.sent).toEqual([])
    releaseSecond()
    await second
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-1', data: 'after both' }]])
  })

  it('an end held for two answers on their way follows the last of them', async () => {
    let releaseSecond
    const env = load()
    env.ctx.agentStateStore.register = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => new Promise((r) => (releaseSecond = r)))
    const first = env.handlers['pty:attach'](null, 'pane-1')
    const second = env.handlers['pty:attach'](null, 'pane-1')
    const answer = { ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'S', agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 }
    env.reply({ ...answer }, 0)
    env.reply({ ...answer }, 1)
    env.api.queueData('pane-1', 'last')
    env.api.onExit('pane-1', 0, 0, 7)
    await first
    env.flush()
    expect(env.sent).toEqual([])
    releaseSecond()
    expect(await second).toMatchObject({ exited: true })
    env.flush()
    expect(env.sent).toEqual([
      ['pty:data', { id: 'pane-1', data: 'last' }],
      ['pty:exit', { id: 'pane-1', exitCode: 0, signal: 0, pid: 7 }]
    ])
  })

  it('a failed or refused attach releases no hold it never took', async () => {
    let releaseRegister
    const env = load({ registerDelay: new Promise((r) => (releaseRegister = r)) })
    const held = env.handlers['pty:attach'](null, 'pane-1')
    // Its answer stays on its way (its agent state being registered).
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'S', agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 }, 0)
    // Two more asks for the same pane fail before any answer of theirs.
    const refused = env.handlers['pty:attach'](null, 'pane-1')
    env.reply({ ok: false, error: 'not found' }, 1)
    const lost = env.handlers['pty:attach'](null, 'pane-1')
    env.fail(new Error('terminal host disconnected'), 2)
    expect(await refused).toEqual({ ok: false })
    expect(await lost).toMatchObject({ ok: false })
    env.api.queueData('pane-1', 'x')
    env.flush()
    // Still held for the first answer.
    expect(env.sent).toEqual([])
    releaseRegister()
    await held
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-1', data: 'x' }]])
  })

  it('a probe (only whether it still runs) replays nothing and leaves its output as it flows', async () => {
    const env = load()
    env.api.queueData('pane-1', 'flowing ')
    const probing = env.handlers['pty:attach'](null, 'pane-1', { probe: true })
    expect(env.asked()).toEqual({ id: 'pane-1', scrollback: 0, maxChars: 1 })
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'SCREEN' })
    env.api.queueData('pane-1', 'on')
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-1', data: 'flowing on' }]])
    expect(await probing).toMatchObject({ ok: true, pid: 7, buffer: '' })
  })

  it('an agent state that takes too long to register holds the answer at most a moment', async () => {
    const env = load({ registerDelay: new Promise(() => {}) })
    let done = false
    const attaching = env.handlers['pty:attach'](null, 'pane-1').then((r) => ((done = true), r))
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: 'S', agentProvider: 'claude', agentLaunchToken: 'tok', agentStartedAt: 1 })
    env.api.queueData('pane-1', 'later')
    await turn()
    env.flush()
    expect(done).toBe(false)
    expect(env.sent).toEqual([])
    // The wait's limit (ATTACH_REGISTER_WAIT_MS) passes.
    env.wait()
    expect(await attaching).toMatchObject({ ok: true, buffer: 'S' })
    env.flush()
    expect(env.sent).toEqual([['pty:data', { id: 'pane-1', data: 'later' }]])
  })

  it('cuts the replay at a line start, never inside an escape sequence or a character', async () => {
    const env = load()
    const attaching = env.handlers['pty:attach'](null, 'pane-1')
    const line = '\x1b[38;2;217;119;87mword word\x1b[0m\r\n'
    const long = line.repeat(Math.ceil((PANE_HISTORY_CHARS + 5000) / line.length))
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: long })
    const res = await attaching
    expect(res.buffer.length).toBeLessThanOrEqual(PANE_HISTORY_CHARS)
    expect(res.buffer.startsWith('\x1b[38;2;217;119;87m')).toBe(true)
    expect(long.endsWith(res.buffer)).toBe(true)
    // No line start near the cut: still never half of a surrogate pair.
    const emoji = 'x' + '\u{1F600}'.repeat(10)
    const cut = trimBuffer(emoji, 5)
    expect(cut).toBe('\u{1F600}'.repeat(2))
    expect(cut.charCodeAt(0) >= 0xdc00 && cut.charCodeAt(0) <= 0xdfff).toBe(false)
  })

  it('cuts the replay to what the window keeps of a pane (an older host sends it all)', async () => {
    const env = load()
    const attaching = env.handlers['pty:attach'](null, 'pane-1')
    const long = 'a'.repeat(50) + 'b'.repeat(PANE_HISTORY_CHARS)
    env.reply({ ok: true, shellId: 'pwsh', shellName: 'PowerShell', pid: 7, buffer: long })
    const res = await attaching
    // No line start: its last PANE_HISTORY_CHARS characters.
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
