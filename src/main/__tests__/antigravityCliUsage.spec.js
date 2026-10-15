// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  AGY_USAGE_ARGS,
  AGY_TIMEOUT_MS,
  createAntigravityCliUsage,
  findAgy,
  mapAntigravityUsage,
  parseAntigravityUsage
} from '../antigravityCliUsage'

// The shape of `agy -p /usage --output-format json` (values made up).
const fixture = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'a text table',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-10-22T12:00:00Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.75, reset_time: '2026-10-15T17:00:00Z' }
          ]
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-22T12:05:00Z' },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0, reset_time: '2026-10-15T17:05:00Z' }
          ]
        }
      ]
    }
  }
}
const ROWS = [
  { label: 'Gemini 5-hour', usedPct: 25, resetsAt: Date.parse('2026-10-15T17:00:00Z') },
  { label: 'Gemini weekly', usedPct: 10, resetsAt: Date.parse('2026-10-22T12:00:00Z') },
  { label: 'Claude and GPT 5-hour', usedPct: 100, resetsAt: Date.parse('2026-10-15T17:05:00Z') },
  { label: 'Claude and GPT weekly', usedPct: 0, resetsAt: Date.parse('2026-10-22T12:05:00Z') }
]

describe('mapping agy /usage', () => {
  it('one row per bucket: per group, its 5-hour then its weekly limit, used = 1 - remaining', () => {
    expect(mapAntigravityUsage(fixture)).toEqual(ROWS)
  })
  it('skips buckets without a fraction, names another window by its own name, keeps a label once', () => {
    const data = {
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { window: '5h', remaining_fraction: 'n/a', reset_time: '2026-10-15T17:00:00Z' },
                { window: 'daily', name: 'Daily Limit Remaining', remaining_fraction: 0.5 },
                { window: 'weekly', remaining_fraction: 0.996 },
                { window: 'weekly', remaining_fraction: 0.1 }
              ]
            },
            { buckets: [{ window: '5h', remaining_fraction: 0.5 }, { window: 'weekly', remaining_fraction: 0.5 }] }
          ]
        }
      }
    }
    expect(mapAntigravityUsage(data)).toEqual([
      { label: 'Gemini weekly', usedPct: 0.4, resetsAt: null },
      { label: 'Gemini Daily', usedPct: 50, resetsAt: null },
      // A group without a name: the window alone, as other providers name it.
      { label: '5-hour', usedPct: 50, resetsAt: null },
      { label: 'Weekly', usedPct: 50, resetsAt: null }
    ])
  })
  it('anything else maps to nothing', () => {
    for (const data of [null, {}, { command: { data: { groups: 'x' } } }, { command: { data: { groups: [{ buckets: 'x' }] } } }])
      expect(mapAntigravityUsage(data)).toEqual([])
  })
})

describe('parsing agy output', () => {
  it('reads the usage command answer, even after a notice line', () => {
    expect(parseAntigravityUsage(JSON.stringify(fixture))).toEqual({ ok: true, windows: ROWS })
    expect(parseAntigravityUsage(`A new version of agy is available.\n${JSON.stringify(fixture)}\n`)).toEqual({ ok: true, windows: ROWS })
  })
  it('bad JSON, a model turn or no quota is an unreadable answer', () => {
    expect(parseAntigravityUsage('not json')).toEqual({ ok: false, reason: 'response' })
    expect(parseAntigravityUsage('')).toEqual({ ok: false, reason: 'response' })
    const turn = { ...fixture, num_turns: 1 }
    delete turn.command
    expect(parseAntigravityUsage(JSON.stringify(turn))).toEqual({ ok: false, reason: 'response' })
    expect(parseAntigravityUsage(JSON.stringify({ ...fixture, command: { name: 'usage', data: { groups: [] } } }))).toEqual({ ok: false, reason: 'response' })
  })
  it('a failed answer: signed out when it asks for a sign-in, failed otherwise, and none of its text', () => {
    const signedOut = parseAntigravityUsage(JSON.stringify({ status: 'ERROR', error: 'Not signed in. Run agy and log in. secret-xyz' }))
    expect(signedOut).toEqual({ ok: false, reason: 'signed-out' })
    expect(JSON.stringify(signedOut)).not.toContain('secret-xyz')
    expect(parseAntigravityUsage(JSON.stringify({ status: 'ERROR', error: 'quota service down' }))).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('finding agy', () => {
  const at = (...files) => (file) => files.includes(file)
  it('Windows: the first agy.exe on PATH, then its installer folder; relative PATH entries never', () => {
    const env = { Path: 'agy-here;C:\\Tools;"C:\\Quoted"', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    const opts = { env, platform: 'win32', home: 'C:\\Users\\u' }
    expect(findAgy({ ...opts, exists: at('agy-here\\agy.exe', 'C:\\Quoted\\agy.exe') })).toBe('C:\\Quoted\\agy.exe')
    expect(findAgy({ ...opts, exists: at('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe') })).toBe('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe')
    expect(findAgy({ ...opts, exists: () => false })).toBe(null)
  })
  it('elsewhere: agy on PATH, then ~/.local/bin', () => {
    const opts = { env: { PATH: '/usr/bin:/opt/agy' }, platform: 'linux', home: '/home/u' }
    expect(findAgy({ ...opts, exists: at('/opt/agy/agy') })).toBe('/opt/agy/agy')
    expect(findAgy({ ...opts, exists: at('/home/u/.local/bin/agy') })).toBe('/home/u/.local/bin/agy')
  })
})

describe('running agy', () => {
  const FILE = 'C:\\agy\\agy.exe'
  function setup({ answer = { error: null, stdout: JSON.stringify(fixture) }, found = FILE, ...options } = {}) {
    let now = 1000
    const stdin = { on: vi.fn(), end: vi.fn() }
    const calls = []
    const execFile = vi.fn((file, args, opts, done) => {
      calls.push(done)
      const reply = typeof answer === 'function' ? answer() : answer
      if (reply !== 'wait') setTimeout(() => done(reply.error, reply.stdout ?? '', ''), 0)
      return { stdin }
    })
    const env = vi.fn(() => ({ Path: 'C:\\Tools', SYSTEMROOT: 'C:\\Windows' }))
    const find = vi.fn(() => found)
    const reader = createAntigravityCliUsage({ execFile, env, find, clock: () => now, home: 'C:\\Users\\u', ...options })
    return { reader, execFile, env, find, stdin, calls, tick: (ms) => (now += ms) }
  }

  it('runs agy directly with the argument array, no shell, hidden, bounded, stdin closed', async () => {
    const { reader, execFile, stdin } = setup()
    expect(await reader.read()).toEqual({ ok: true, windows: ROWS, observedAt: 1000 })
    expect(execFile).toHaveBeenCalledTimes(1)
    const [file, args, opts] = execFile.mock.calls[0]
    expect(file).toBe(FILE)
    expect(args).toEqual(['-p', '/usage', '--output-format', 'json'])
    expect(args).toEqual([...AGY_USAGE_ARGS])
    expect(opts.shell).toBeUndefined()
    expect(opts).toMatchObject({ windowsHide: true, timeout: AGY_TIMEOUT_MS, cwd: 'C:\\Users\\u', env: { Path: 'C:\\Tools' } })
    expect(opts.maxBuffer).toBeGreaterThan(0)
    expect(opts.maxBuffer).toBeLessThanOrEqual(1024 * 1024)
    expect(stdin.end).toHaveBeenCalled()
  })

  it('agy not found: nothing runs', async () => {
    const { reader, execFile } = setup({ found: null })
    expect(await reader.read()).toEqual({ ok: false, reason: 'missing' })
    expect(execFile).not.toHaveBeenCalled()
    expect(reader.present()).toBe(false)
  })

  it.each([
    ['gone since it was found', { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 'missing'],
    ['stopped after its time', { error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }) }, 'timeout'],
    ['a non-zero exit', { error: Object.assign(new Error('Command failed'), { code: 1 }), stdout: 'boom' }, 'failed'],
    ['a non-zero exit asking for a sign-in', { error: Object.assign(new Error('Command failed'), { code: 1 }), stdout: '{"status":"ERROR","error":"Please sign in"}' }, 'signed-out'],
    ['too much output', { error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }, 'failed'],
    ['bad JSON', { error: null, stdout: '<html>' }, 'response']
  ])('%s: a short reason only', async (_name, answer, reason) => {
    const { reader } = setup({ answer })
    const result = await reader.read()
    expect(result).toEqual({ ok: false, reason })
  })

  it('a spawn that throws is a failure, not a crash', async () => {
    const { reader } = setup({
      execFile: () => {
        throw new Error('EPERM C:\\agy\\agy.exe')
      }
    })
    expect(await reader.read()).toEqual({ ok: false, reason: 'failed' })
  })

  it('one run at a time, and a result is reused for 30 s', async () => {
    const { reader, execFile, tick } = setup()
    const [a, b] = await Promise.all([reader.read(), reader.read()])
    expect(a).toEqual(b)
    expect(execFile).toHaveBeenCalledTimes(1)
    tick(29_000)
    await reader.read()
    expect(execFile).toHaveBeenCalledTimes(1)
    tick(2_000)
    await reader.read()
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('present() looks for agy without running it', () => {
    const { reader, execFile, find } = setup()
    expect(reader.present()).toBe(true)
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ env: { Path: 'C:\\Tools', SYSTEMROOT: 'C:\\Windows' } }))
    expect(execFile).not.toHaveBeenCalled()
  })
})
