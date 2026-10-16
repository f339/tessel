import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { codexModelFromFile } from '../agentModel'
import { createRemoteModelReader } from '../remoteAgentModel'

// The lines a Codex 0.162 rollout writes: its settings when a turn starts,
// then items, some of them huge (web results, tool outputs).
const settings = (model, effort, at) =>
  JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort, service_tier: 'priority' } } })
const turn = (model, effort, at) =>
  JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model, collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } } } })
const big = (kb, at = '2026-10-16T12:10:00.000Z') =>
  JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', results: 'x'.repeat(kb * 1024) } } })

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codexfile-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('codexModelFromFile', () => {
  it('finds the model line far from the end (the observed bug: 312 KB of web results after it, the header fell back to config.toml)', () => {
    const f = join(dir, 'rollout-a.jsonl')
    fs.writeFileSync(f, [settings('gpt-6-astra', 'xhigh', '2026-10-14T12:56:34.399Z'), settings('gpt-6-luna', 'medium', '2026-10-16T12:09:37.580Z'), turn('gpt-6-luna', 'medium', '2026-10-16T12:09:37.635Z'), big(200), big(150), big(300)].join('\n') + '\n')
    expect(fs.statSync(f).size).toBeGreaterThan(600 * 1024)
    expect(codexModelFromFile(f)).toEqual({ model: 'gpt-6-luna', effort: 'medium', at: Date.parse('2026-10-16T12:09:37.635Z') })
  })

  it('a model line cut across two chunks still counts', () => {
    const f = join(dir, 'rollout-b.jsonl')
    // The settings line straddles the 512 KB chunk boundary from the end.
    const tailKb = 511
    fs.writeFileSync(f, [big(40), settings('gpt-6-sol', 'high', '2026-10-16T10:00:00.000Z'), big(tailKb)].join('\n') + '\n')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('a grown file: only the new part is read; it keeps what it said until a new model line shows', () => {
    const f = join(dir, 'rollout-c.jsonl')
    fs.writeFileSync(f, [settings('gpt-6-astra', 'xhigh', '2026-10-16T09:00:00.000Z'), big(10)].join('\n') + '\n')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' })
    fs.appendFileSync(f, big(400) + '\n' + big(400) + '\n')
    const read = vi.spyOn(fs, 'readSync')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' })
    // Never further back than where the last read stopped.
    const bytes = read.mock.calls.reduce((n, c) => n + c[3], 0)
    read.mockRestore()
    expect(bytes).toBeLessThan(820 * 1024)
    fs.appendFileSync(f, settings('gpt-6-luna', 'medium', '2026-10-16T12:00:00.000Z') + '\n' + big(5) + '\n')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' })
    // Unchanged: the same answer, nothing read.
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-luna' })
  })

  it('a line being written when it was read is read again once whole', () => {
    const f = join(dir, 'rollout-d.jsonl')
    const line = settings('gpt-6-luna', 'low', '2026-10-16T12:00:00.000Z')
    fs.writeFileSync(f, turn('gpt-6-astra', 'xhigh', '2026-10-16T09:00:00.000Z') + '\n' + line.slice(0, 40))
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-astra' })
    fs.appendFileSync(f, line.slice(40) + '\n')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' })
  })

  it('a rewritten (smaller) file is read again from scratch; no model line: null; a missing file: null', () => {
    const f = join(dir, 'rollout-e.jsonl')
    fs.writeFileSync(f, settings('gpt-6-astra', 'xhigh', '2026-10-16T09:00:00.000Z') + '\n' + big(20) + '\n')
    expect(codexModelFromFile(f)).toMatchObject({ model: 'gpt-6-astra' })
    fs.writeFileSync(f, big(1) + '\n')
    expect(codexModelFromFile(f)).toBe(null)
    expect(codexModelFromFile(join(dir, 'nope.jsonl'))).toBe(null)
  })
})

describe('the SSH host reader keeps the model through a long turn', () => {
  it('a turn longer than the kept end: the model it named last still holds', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    let text = settings('gpt-6-luna', 'medium', '2026-10-16T12:09:37.580Z') + '\n'
    const readAgentFile = vi.fn(async (hostId, { offset, cap }) => {
      const buf = Buffer.from(text)
      const data = offset === null ? buf.subarray(Math.max(0, buf.length - cap)) : buf.subarray(Math.min(offset, buf.length), Math.min(offset + cap, buf.length))
      return { ok: true, size: buf.length, mtimeMs: buf.length, data }
    })
    let t = 0
    const reader = createRemoteModelReader({ readAgentFile, now: () => t, minGapMs: 0, tailBytes: 64 * 1024 })
    expect(await reader.read({ hostId: 'ssh-box1', agent: 'codex', sessionId: id })).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' })
    // Within the kept end, then past it in one go.
    text += big(40) + '\n'
    t += 1
    expect(await reader.read({ hostId: 'ssh-box1', agent: 'codex', sessionId: id })).toMatchObject({ model: 'gpt-6-luna' })
    text += big(100) + '\n'
    t += 1
    expect(await reader.read({ hostId: 'ssh-box1', agent: 'codex', sessionId: id })).toMatchObject({ model: 'gpt-6-luna' })
    text += settings('gpt-6-astra', 'xhigh', '2026-10-16T13:00:00.000Z') + '\n'
    t += 1
    expect(await reader.read({ hostId: 'ssh-box1', agent: 'codex', sessionId: id })).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' })
  })
})
