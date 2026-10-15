// @vitest-environment node
// Sub-agents of a Gemini CLI conversation (chats/<session>/<agent>.jsonl), a
// Copilot CLI one (subagent.* events), a Kimi Code one (wire records) and a
// Cursor Agent one (child chats), read from fixtures shaped like their files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  geminiSubagents,
  parseGeminiChildHead,
  summarizeGeminiTail,
  copilotSubagents,
  kimiSubagents,
  cursorSubagents,
  parseCursorMeta,
  cursorTurnEnded,
  _clearChildCachesForTest,
  _setLogTailForTest
} from '../agentChildren'

const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')
const line = (o) => JSON.stringify(o)
const iso = (ms) => new Date(ms).toISOString()
const write = (file, rows, mtime) => {
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, rows.map(line).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

const SID = 'a1b2c3d4-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const D = 'dddddddd-0000-4000-8000-000000000004'

let home
const now = Date.now()
beforeEach(() => {
  _clearChildCachesForTest()
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kids-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe("a Gemini CLI conversation's sub-agents", () => {
  const meta = (id, at, kind = 'subagent') => ({ sessionId: id, projectHash: 'f3a1', startTime: iso(at), lastUpdated: iso(at), kind, directories: ['C:\\proj'] })
  const user = (at, text) => ({ id: `u${at}`, timestamp: iso(at), type: 'user', content: [{ text }] })
  const gemini = (at, extra = {}) => ({ id: `g${at}`, timestamp: iso(at), type: 'gemini', content: '', thoughts: [], tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 }, model: 'gemini-3-pro-preview', ...extra })
  const call = (name, status) => ({ id: `c-${name}`, name, args: {}, result: null, status, timestamp: iso(now) })

  it('reads the start, the prompt and the end of a sub-agent chat file', () => {
    const head = [line(meta(A, now - 60000)), line(user(now - 59000, 'Map the parser\nthen more'))].join('\n')
    expect(parseGeminiChildHead(head)).toEqual({ startedAt: now - 60000, child: true, title: 'Map the parser' })
    expect(parseGeminiChildHead(line(meta(A, now, 'main'))).child).toBe(false)
    const done = [line(gemini(now - 5000)), line(gemini(now - 5000, { toolCalls: [call('complete_task', 'success')] })), line({ $set: { lastUpdated: iso(now - 4000) } })]
    expect(summarizeGeminiTail(done)).toEqual({ done: true, last: now - 4000, tokens: 1060, model: 'gemini-3-pro-preview' })
    expect(summarizeGeminiTail([line(gemini(now - 5000, { toolCalls: [call('complete_task', 'error')] }))]).done).toBe(false)
    expect(summarizeGeminiTail([line({ $set: { summary: 'Found it.' } })]).done).toBe(true)
  })

  it('lists the files in the folder named after the conversation, done, running and quiet', () => {
    const chats = join(home, '.gemini', 'tmp', 'proj', 'chats')
    // The conversation's own file: its invoke_agent calls once they came back.
    write(join(chats, `session-2026-10-15T10-00-${SID.slice(0, 8)}.jsonl`), [
      meta(SID, now - 600000, 'main'),
      user(now - 590000, 'Fix it'),
      gemini(now - 3000, {
        toolCalls: [
          { id: 'c1', name: 'invoke_agent', args: { agent_name: 'codebase_investigator', prompt: 'Map the parser' }, status: 'success', agentId: A, displayName: 'Invoke Subagent' },
          { id: 'c2', name: 'invoke_agent', args: { agent_name: 'generalist', prompt: 'Stop' }, status: 'cancelled', agentId: D }
        ]
      })
    ])
    const dir = join(chats, SID)
    write(join(dir, `${A}.jsonl`), [meta(A, now - 300000), user(now - 299000, 'Map the parser'), gemini(now - 200000), gemini(now - 200000, { toolCalls: [call('complete_task', 'success')] }), { $set: { summary: 'Done' } }])
    write(join(dir, `${B}.jsonl`), [meta(B, now - 100000), user(now - 99000, 'Write the tests'), gemini(now - 2000, { model: 'gemini-3-flash-preview' }), { $set: { lastUpdated: iso(now - 2000) } }])
    write(join(dir, `${C}.jsonl`), [meta(C, now - 3600000), user(now - 3599000, 'Old one')], now - 3500000)
    write(join(dir, `${D}.jsonl`), [meta(D, now - 50000), user(now - 49000, 'Stop')])
    // Not a sub-agent's file.
    write(join(dir, 'eeeeeeee-0000-4000-8000-000000000005.jsonl'), [meta('eeeeeeee-0000-4000-8000-000000000005', now, 'main')])
    const list = geminiSubagents(SID, join(home, '.gemini'), now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.tokens, c.model])).toEqual([
      [D, 'generalist', 'Stop', 'done', null, null],
      [B, 'subagent', 'Write the tests', 'running', 1060, 'gemini-3-flash-preview'],
      [A, 'codebase_investigator', 'Map the parser', 'done', 1060, 'gemini-3-pro-preview'],
      [C, 'subagent', 'Old one', 'quiet', null, null]
    ])
    expect(list[2].startedAt).toBe(now - 300000)
    expect(list[1].endedAt).toBe(null)
    expect(geminiSubagents('not-an-id', join(home, '.gemini'), now)).toEqual([])
    expect(geminiSubagents(SID, join(home, 'nowhere'), now)).toEqual([])
  })

  it('a project folder reached through a junction is not read', () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kids-outside-'))
    try {
      write(join(outside, 'chats', SID, `${A}.jsonl`), [meta(A, now), user(now, 'OUTSIDE')])
      fs.mkdirSync(join(home, '.gemini', 'tmp'), { recursive: true })
      fs.symlinkSync(outside, join(home, '.gemini', 'tmp', 'proj'), 'junction')
      expect(geminiSubagents(SID, join(home, '.gemini'), now)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("a Copilot CLI conversation's sub-agents", () => {
  let n = 0
  const ev = (at, type, data, agentId) => ({ id: `e${++n}`, parentId: null, timestamp: iso(at), type, data, ...(agentId ? { agentId } : {}) })
  const events = () => join(home, '.copilot', 'session-state', SID, 'events.jsonl')

  it('one per task call: done, running in the background, failed; model and effort; a workflow run apart', () => {
    write(events(), [
      ev(now - 600000, 'session.start', { sessionId: SID, version: 1 }),
      ev(now - 500000, 'tool.execution_start', { toolCallId: 'call_A', toolName: 'task', arguments: { name: 'Find the bug', description: 'Find the bug', agent_type: 'explore', prompt: 'x', mode: 'sync' } }),
      ev(now - 500000, 'subagent.started', { toolCallId: 'call_A', agentName: 'explore', agentDisplayName: 'Find the bug', agentDescription: 'Explores', agentType: 'explore', executionMode: 'sync', model: 'claude-sonnet-4.5' }, 'call_A'),
      ev(now - 499000, 'subagent.configured', { model: 'claude-sonnet-4.5', reasoningEffort: 'high', multiTurn: false }, 'call_A'),
      ev(now - 450000, 'assistant.message', { content: 'x' }, 'call_A'),
      ev(now - 400000, 'subagent.completed', { toolCallId: 'call_A', agentName: 'explore', agentDisplayName: 'Find the bug', model: 'claude-sonnet-4.5', firstDispatchedModel: 'claude-haiku-4.5', totalTokens: 9000 }, 'call_A'),
      ev(now - 300000, 'subagent.started', { toolCallId: 'call_B', agentName: 'general-purpose', agentDisplayName: 'Write the docs', agentDescription: 'x', executionMode: 'background', model: 'gpt-5-mini' }, 'call_B'),
      ev(now - 299000, 'subagent.configured', { model: 'gpt-5-mini', reasoningEffort: 'medium', multiTurn: true }, 'call_B'),
      ev(now - 2000, 'tool.execution_start', { toolCallId: 'inner', toolName: 'view', arguments: {} }, 'call_B'),
      ev(now - 200000, 'subagent.started', { toolCallId: 'call_C', agentName: 'task', agentDisplayName: 'Run the build', agentDescription: 'x' }, 'call_C'),
      ev(now - 100000, 'subagent.failed', { toolCallId: 'call_C', agentName: 'task', agentDisplayName: 'Run the build', error: 'boom' }, 'call_C'),
      ev(now - 50000, 'subagent.started', { toolCallId: 'call_W', agentName: 'task', agentDisplayName: 'Workflow step', workflowRunId: 'w1' }, 'call_W')
    ])
    const list = copilotSubagents(SID, join(home, '.copilot'), now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.background, c.model, c.effort])).toEqual([
      ['call_C', 'task', 'Run the build', 'done', false, null, null],
      ['call_B', 'general-purpose', 'Write the docs', 'running', true, 'gpt-5-mini', 'medium'],
      ['call_A', 'explore', 'Find the bug', 'done', false, 'claude-haiku-4.5', 'high']
    ])
    expect(list[1].lastAt).toBe(now - 2000)
    expect(list[2].startedAt).toBe(now - 500000)
    expect(list[2].endedAt).toBe(now - 400000)
  })

  it('reads only what was added since; a rewritten file is read again', () => {
    write(events(), [ev(now - 300000, 'subagent.started', { toolCallId: 'call_B', agentName: 'general-purpose', agentDisplayName: 'Write the docs' }, 'call_B')])
    expect(copilotSubagents(SID, join(home, '.copilot'), now).map((c) => c.state)).toEqual(['running'])
    // A line still being written waits for its end.
    const done = line(ev(now - 1000, 'subagent.completed', { toolCallId: 'call_B', agentName: 'general-purpose', agentDisplayName: 'Write the docs' }, 'call_B'))
    fs.appendFileSync(events(), done.slice(0, 40))
    expect(copilotSubagents(SID, join(home, '.copilot'), now).map((c) => c.state)).toEqual(['running'])
    fs.appendFileSync(events(), done.slice(40) + '\n')
    expect(copilotSubagents(SID, join(home, '.copilot'), now).map((c) => [c.state, c.endedAt])).toEqual([['done', now - 1000]])
    write(events(), [ev(now, 'session.start', {})])
    expect(copilotSubagents(SID, join(home, '.copilot'), now)).toEqual([])
  })

  it('one started long before the end a log is read from (a large log, read cold) is still listed', () => {
    const filler = Array.from({ length: 20 }, (_, i) => ev(now - 400000 + i, 'assistant.message', { content: 'x'.repeat(1000) }))
    write(events(), [
      ev(now - 500000, 'tool.execution_start', { toolCallId: 'call_A', toolName: 'task', arguments: { name: 'Find the bug', agent_type: 'explore', mode: 'sync' } }),
      ev(now - 499000, 'subagent.completed', { toolCallId: 'call_A', agentName: 'explore', agentDisplayName: 'Find the bug' }, 'call_A'),
      ev(now - 450000, 'subagent.started', { toolCallId: 'call_B', agentName: 'general-purpose', agentDisplayName: 'Write the docs', executionMode: 'background', model: 'gpt-5-mini' }, 'call_B'),
      ev(now - 449000, 'subagent.configured', { model: 'gpt-5-mini', reasoningEffort: 'medium', multiTurn: true }, 'call_B'),
      ev(now - 448000, 'tool.execution_start', { toolCallId: 'early', toolName: 'view', arguments: { path: 'x'.repeat(500) } }, 'call_B'),
      ...filler,
      ev(now - 2000, 'tool.execution_start', { toolCallId: 'late', toolName: 'view', arguments: {} }, 'call_B')
    ])
    _setLogTailForTest(4096)
    try {
      const list = copilotSubagents(SID, join(home, '.copilot'), now)
      expect(list.map((c) => [c.id, c.title, c.state, c.background, c.model, c.effort, c.lastAt])).toEqual([
        ['call_B', 'Write the docs', 'running', true, 'gpt-5-mini', 'medium', now - 2000],
        ['call_A', 'Find the bug', 'done', false, null, null, now - 499000]
      ])
    } finally {
      _setLogTailForTest()
    }
  })

  it('nothing outside its session folder', () => {
    expect(copilotSubagents('../../etc', join(home, '.copilot'), now)).toEqual([])
    expect(copilotSubagents(SID, join(home, 'nowhere'), now)).toEqual([])
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kids-outside-'))
    try {
      write(join(outside, SID, 'events.jsonl'), [ev(now, 'subagent.started', { toolCallId: 'x', agentName: 'OUTSIDE' }, 'x')])
      fs.mkdirSync(join(home, '.copilot'), { recursive: true })
      fs.symlinkSync(outside, join(home, '.copilot', 'session-state'), 'junction')
      expect(copilotSubagents(SID, join(home, '.copilot'), now)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("a Kimi Code conversation's sub-agents", () => {
  const KID = 'session_3f2a9c1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b'
  const session = () => join(home, '.kimi-code', 'sessions', 'wd_proj_caffba220b07', KID)
  const rec = (at, type, fields) => ({ type, time: at, ...fields })

  it('from the wire of the agent that started each one, nested ones included', () => {
    const s = session()
    fs.mkdirSync(s, { recursive: true })
    fs.writeFileSync(join(s, 'state.json'), JSON.stringify({ agents: { main: { type: 'main' }, 'agent-1': { type: 'sub', parentAgentId: 'main' }, 'agent-2': { type: 'sub', parentAgentId: 'main', labels: { parentAgentId: 'agent-1' } } } }))
    write(join(s, 'agents', 'main', 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.5', created_at: now - 900000 },
      rec(now - 600000, 'subagent.spawned', { subagentId: 'agent-1', subagentName: 'coder', parentToolCallId: 'tc1', parentAgentId: 'main', description: 'Fix the tests\nand more', runInBackground: false, model: 'kimi-k2.6', thinkingEffort: 'high' }),
      rec(now - 599000, 'subagent.started', { subagentId: 'agent-1' }),
      rec(now - 300000, 'subagent.completed', { subagentId: 'agent-1', resultSummary: 'ok', contextTokens: 42000 }),
      rec(now - 200000, 'subagent.spawned', { subagentId: 'agent-3', subagentName: 'explore', parentToolCallId: 'tc3', description: 'Look around', runInBackground: true }),
      rec(now - 100000, 'subagent.cancelled', { subagentId: 'agent-3' })
    ])
    // agent-1 started one of its own.
    write(join(s, 'agents', 'agent-1', 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.5', created_at: now - 600000 },
      rec(now - 500000, 'subagent.spawned', { subagentId: 'agent-2', subagentName: 'coder', parentToolCallId: 'tc2', parentAgentId: 'agent-1', description: 'Patch one file', runInBackground: false, model: 'kimi-k2.6' }),
      rec(now - 499000, 'subagent.started', { subagentId: 'agent-2' })
    ], now - 300000)
    write(join(s, 'agents', 'agent-2', 'wire.jsonl'), [{ type: 'metadata', protocol_version: '1.5', created_at: now - 499000 }], now - 3000)
    const list = kimiSubagents(KID, join(home, '.kimi-code'), now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.background, c.tokens, c.model, c.effort])).toEqual([
      ['agent-3', 'explore', 'Look around', 'done', true, null, null, null],
      ['agent-2', 'coder', 'Patch one file', 'running', false, null, 'kimi-k2.6', null],
      ['agent-1', 'coder', 'Fix the tests', 'done', false, 42000, 'kimi-k2.6', 'high']
    ])
    expect(list[1].lastAt).toBeGreaterThanOrEqual(now - 3001)
    expect(list[2].endedAt).toBe(now - 300000)
  })

  it('one spawned long before the end a large wire is read from (read cold) is still listed', () => {
    const s = session()
    write(join(s, 'agents', 'main', 'wire.jsonl'), [
      rec(now - 600000, 'subagent.spawned', { subagentId: 'agent-1', subagentName: 'coder', parentToolCallId: 'tc1', description: 'Fix the tests', runInBackground: true, model: 'kimi-k2.6', thinkingEffort: 'high' }),
      rec(now - 590000, 'subagent.spawned', { subagentId: 'agent-2', subagentName: 'explore', parentToolCallId: 'tc2', description: 'Look around', runInBackground: false }),
      rec(now - 580000, 'subagent.completed', { subagentId: 'agent-2', resultSummary: 'ok', contextTokens: 900 }),
      ...Array.from({ length: 20 }, (_, i) => rec(now - 500000 + i, 'content.part', { text: 'x'.repeat(1000) }))
    ])
    write(join(s, 'agents', 'agent-1', 'wire.jsonl'), [{ type: 'metadata' }], now - 1000)
    _setLogTailForTest(4096)
    try {
      expect(kimiSubagents(KID, join(home, '.kimi-code'), now).map((c) => [c.id, c.state, c.background, c.tokens, c.effort])).toEqual([
        ['agent-2', 'done', false, 900, null],
        ['agent-1', 'running', true, null, 'high']
      ])
    } finally {
      _setLogTailForTest()
    }
  })

  it('an unfinished one whose wire is silent for 20 min is quiet; nothing for another session', () => {
    const s = session()
    write(join(s, 'agents', 'main', 'wire.jsonl'), [rec(now - 3600000, 'subagent.spawned', { subagentId: 'agent-1', subagentName: 'coder', parentToolCallId: 'tc1', runInBackground: false })], now - 3600000)
    write(join(s, 'agents', 'agent-1', 'wire.jsonl'), [{ type: 'metadata' }], now - 20 * 60000)
    expect(kimiSubagents(KID, join(home, '.kimi-code'), now).map((c) => c.state)).toEqual(['quiet'])
    expect(kimiSubagents('session_other1', join(home, '.kimi-code'), now)).toEqual([])
    expect(kimiSubagents('bad id', join(home, '.kimi-code'), now)).toEqual([])
  })
})

describe.skipIf(!sqlite)("a Cursor Agent conversation's sub-agents", () => {
  const hex = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('hex')
  function chat(bucket, id, meta, mtime) {
    const dir = join(home, '.cursor', 'chats', bucket, id)
    fs.mkdirSync(dir, { recursive: true })
    const db = new sqlite.DatabaseSync(join(dir, 'store.db'))
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', hex({ agentId: id, latestRootBlobId: 'f'.repeat(64), name: 'New Agent', mode: 'default', createdAt: now - 3600000, blobEncryptionKey: 'k', ...meta }))
    db.close()
    if (mtime) fs.utimesSync(join(dir, 'store.db'), new Date(mtime), new Date(mtime))
  }
  const transcript = (id, rows, mtime) => write(join(home, '.cursor', 'projects', 'c-proj', 'agent-transcripts', id, `${id}.jsonl`), rows, mtime)
  const said = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })

  it('child chats beside the conversation that name it as their parent (or root)', () => {
    const P = '49e9a219-5e0d-4a1d-8be7-d246e638bb08'
    chat('9f86d081', P, { lastUsedModel: 'grok-4.7' })
    transcript(P, [said('hi')])
    chat('9f86d081', A, { name: 'Find the bug', createdAt: now - 500000, lastUsedModel: 'gpt-5', subagentInfo: { parentAgentId: P, rootParentAgentId: P, toolCallId: 't1', typeName: 'explore' } }, now - 400000)
    transcript(A, [said('looking'), { type: 'turn_ended', status: 'success' }], now - 400000)
    chat('9f86d081', B, { name: 'Write tests', createdAt: now - 100000, lastUsedModel: 'claude-4.5-sonnet', subagentInfo: { parentAgentId: P, rootParentAgentId: P, toolCallId: 't2', typeName: 'generalPurpose' } }, now - 1000)
    transcript(B, [said('writing')], now - 1000)
    // A child of A: the conversation is its root.
    chat('9f86d081', C, { createdAt: now - 450000, subagentInfo: { parentAgentId: A, rootParentAgentId: P, toolCallId: 't3', typeName: 'shell' } }, now - 3600000)
    // Not one of its children.
    chat('9f86d081', D, { createdAt: now - 3600000 })
    chat('9f86d081', 'eeeeeeee-0000-4000-8000-000000000005', { subagentInfo: { parentAgentId: 'someone-else', rootParentAgentId: 'someone-else', typeName: 'explore' } })
    const list = cursorSubagents(P, join(home, '.cursor'), now)
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.model])).toEqual([
      [B, 'generalPurpose', 'Write tests', 'running', 'claude-4.5-sonnet'],
      [C, 'shell', 'New Agent', 'quiet', null],
      [A, 'explore', 'Find the bug', 'done', 'gpt-5']
    ])
    expect(list[2].startedAt).toBe(now - 500000)
    expect(list[2].endedAt).toBe(now - 400000)
    expect(cursorSubagents('nope!!', join(home, '.cursor'), now)).toEqual([])
    expect(cursorSubagents(D, join(home, '.cursor'), now)).toEqual([])
  })

  it("reads Cursor's meta and a transcript's end", () => {
    expect(parseCursorMeta(hex({ agentId: 'x', subagentInfo: { typeName: 'explore' } }))).toEqual({ agentId: 'x', subagentInfo: { typeName: 'explore' } })
    expect(parseCursorMeta('zz')).toBe(null)
    expect(cursorTurnEnded([line(said('a')), line({ type: 'turn_ended', status: 'aborted' })])).toBe(true)
    expect(cursorTurnEnded([line({ type: 'turn_ended', status: 'success' }), line(said('again'))])).toBe(false)
    expect(cursorTurnEnded([])).toBe(false)
  })
})
