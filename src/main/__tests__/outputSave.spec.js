import { describe, it, expect, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createOutputSaver, SAVE_ROWS_MAX } from '../outputSave'

// The terminal host's save of every terminal's output (2026-10-12 freeze: it
// serialized 18 full histories every 30 s, about a second and 9-15 MB of which
// the app kept 64 KB each, and saves piled up while the host was slow).
const term = (text, rev = 0) => ({ text, rev })
const fakeSnapshot = () => vi.fn((entry, rows) => Promise.resolve(`${entry.text}|rows=${rows}`))
const quiet = () => {}

describe('createOutputSaver', () => {
  it('serializes only the rows asked and keeps the end of each, cut at a line start', async () => {
    const snapshot = vi.fn(() => Promise.resolve('old line\n'.repeat(50) + 'last line'))
    const saver = createOutputSaver({ snapshot, log: quiet })
    const out = await saver.save(new Map([['a', term('x')]]), { scrollback: 1000, maxChars: 100 })
    expect(snapshot).toHaveBeenCalledWith(expect.anything(), 1000)
    expect(out.a.length).toBeLessThanOrEqual(100)
    expect(out.a.startsWith('old line\n')).toBe(true)
    expect(out.a.endsWith('last line')).toBe(true)
  })

  it('an older app asks for nothing: the whole history, untrimmed', async () => {
    const snapshot = fakeSnapshot()
    const saver = createOutputSaver({ snapshot, log: quiet })
    const out = await saver.save(new Map([['a', term('x')]]))
    expect(out).toEqual({ a: `x|rows=${SAVE_ROWS_MAX}` })
  })

  it('caps the rows at the history the host keeps', async () => {
    const snapshot = fakeSnapshot()
    const saver = createOutputSaver({ snapshot, log: quiet })
    await saver.save(new Map([['a', term('x')]]), { scrollback: 999999 })
    expect(snapshot).toHaveBeenCalledWith(expect.anything(), SAVE_ROWS_MAX)
  })

  it('gives the text of a terminal with no new output again, and reads a changed one', async () => {
    const snapshot = fakeSnapshot()
    const saver = createOutputSaver({ snapshot, log: quiet })
    const a = term('a')
    const b = term('b')
    const ptys = new Map([
      ['a', a],
      ['b', b]
    ])
    const opts = { scrollback: 1000, maxChars: 65536 }
    await saver.save(ptys, opts)
    expect(snapshot).toHaveBeenCalledTimes(2)
    b.rev++
    b.text = 'b2'
    const out = await saver.save(ptys, opts)
    expect(snapshot).toHaveBeenCalledTimes(3)
    expect(snapshot.mock.calls[2][0]).toBe(b)
    expect(out).toEqual({ a: 'a|rows=1000', b: 'b2|rows=1000' })
  })

  it('reads again when other rows or another length are asked', async () => {
    const snapshot = fakeSnapshot()
    const saver = createOutputSaver({ snapshot, log: quiet })
    const ptys = new Map([['a', term('a')]])
    await saver.save(ptys, { scrollback: 1000 })
    const out = await saver.save(ptys, { scrollback: 200 })
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(out.a).toBe('a|rows=200')
  })

  it('a save asked while the same one runs waits for it instead of doing it again', async () => {
    let finish
    const snapshot = vi.fn(() => new Promise((r) => (finish = r)))
    const saver = createOutputSaver({ snapshot, log: quiet })
    const ptys = new Map([['a', term('a')]])
    const first = saver.save(ptys, { scrollback: 1000 })
    const second = saver.save(ptys, { scrollback: 1000 })
    expect(second).toBe(first)
    await Promise.resolve()
    expect(snapshot).toHaveBeenCalledTimes(1)
    finish('screen')
    expect(await second).toEqual({ a: 'screen' })
  })

  it('a terminal that does not answer in time gives its last text, is logged, and holds no later save', async () => {
    const lines = []
    const stuck = term('stuck')
    let hang = false
    const snapshot = vi.fn((entry) => (hang && entry === stuck ? new Promise(() => {}) : Promise.resolve(entry.text)))
    const saver = createOutputSaver({ snapshot, log: (m) => lines.push(m), terminalTimeoutMs: 20 })
    const ptys = new Map([
      ['ok', term('fine')],
      ['stuck', stuck]
    ])
    expect(await saver.save(ptys, { scrollback: 10 })).toEqual({ ok: 'fine', stuck: 'stuck' })
    hang = true
    stuck.rev++
    expect(await saver.save(ptys, { scrollback: 10 })).toEqual({ ok: 'fine', stuck: 'stuck' })
    expect(lines.some((l) => /1 did not answer in 20 ms/.test(l))).toBe(true)
    // Not stuck behind it: the next save runs (and tries that terminal again).
    expect(await saver.save(ptys, { scrollback: 10 })).toEqual({ ok: 'fine', stuck: 'stuck' })
    expect(snapshot.mock.calls.filter(([e]) => e === stuck)).toHaveLength(3)
  })

  it('a terminal whose snapshot fails gives an empty text', async () => {
    const snapshot = vi.fn(() => Promise.reject(new Error('disposed')))
    const saver = createOutputSaver({ snapshot, log: quiet })
    expect(await saver.save(new Map([['a', term('a')]]), {})).toEqual({ a: '' })
  })

  it('logs a slow save with what it did, and stays silent for a quick one', async () => {
    const lines = []
    let clock = 0
    const snapshot = vi.fn((entry) => {
      clock += entry.text === 'slow' ? 2500 : 10
      return Promise.resolve('x'.repeat(1000))
    })
    const saver = createOutputSaver({ snapshot, log: (m) => lines.push(m), now: () => clock })
    await saver.save(new Map([['a', term('quick')]]), { scrollback: 5 })
    expect(lines).toEqual([])
    await saver.save(new Map([['b', term('slow')]]), { scrollback: 5 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^saving terminal output took 2500 ms: 1 terminal\(s\), 1 read again, 0\.0 MB$/)
  })

  it('with the real headless terminal, fewer rows of history give a smaller text with the latest lines', async () => {
    const vt = new HeadlessTerminal({ cols: 80, rows: 10, scrollback: 5000, allowProposedApi: true })
    const ser = new SerializeAddon()
    vt.loadAddon(ser)
    let data = ''
    for (let i = 0; i < 3000; i++) data += `\x1b[32mline ${i}\x1b[0m\r\n`
    await new Promise((r) => vt.write(data, r))
    const snapshot = (entry, rows) => Promise.resolve(ser.serialize({ scrollback: rows }))
    const saver = createOutputSaver({ snapshot, log: quiet })
    const ptys = new Map([['a', term('a')]])
    const all = (await saver.save(ptys, { scrollback: 5000 })).a
    const some = (await saver.save(ptys, { scrollback: 100 })).a
    expect(all).toMatch(/line 0(?!\d)/)
    expect(some).not.toMatch(/line 0(?!\d)/)
    expect(some).toContain('line 2999')
    expect(some.length).toBeLessThan(all.length / 10)
    vt.dispose()
  })
})
