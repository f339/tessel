// @vitest-environment node
// Sub-agents of an Antigravity CLI (agy) conversation: conversations of their
// own whose parent agy's index names, read from fixtures shaped like agy's
// files (conversation_summaries.db, brain/<id>/.system_generated/logs).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { antigravitySubagents, agyTime, parseAgyHead, summarizeAgyTail, _clearChildCachesForTest } from '../agentChildren'

const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')
const line = (o) => JSON.stringify(o)
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
// agy's own time format in its index.
const agy = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/Z$/, '4321+00:00')
const ZERO = '0001-01-01 00:00:00+00:00'

const P = '89cec4e6-00f8-47a4-b013-796a12edd5e4'
const K1 = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'
const K3 = '33333333-3333-4333-8333-333333333333'
const K4 = '44444444-4444-4444-8444-444444444444'
const K5 = '55555555-5555-4555-8555-555555555555'
const K6 = '66666666-6666-4666-8666-666666666666'
const OTHER = '77777777-7777-4777-8777-777777777777'

// The table as agy 1.3 makes it (gorm).
const SCHEMA =
  'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))'

function index(root, rows) {
  fs.mkdirSync(root, { recursive: true })
  const db = new sqlite.DatabaseSync(join(root, 'conversation_summaries.db'))
  db.exec(SCHEMA)
  const add = db.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_user_input_time, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of rows) {
    add.run(r.id, r.title || '', r.steps ?? 4, r.modified || ZERO, '["file:///C:/proj"]', r.status || 'CASCADE_RUN_STATUS_IDLE', r.agent || '', r.parent || '', r.depth ?? (r.parent ? 1 : 0), r.notIdle ? 1 : 0, r.killed ? 1 : 0, ZERO, 'antigravity-cli')
  }
  db.close()
}

const settings = (label) =>
  `<USER_SETTINGS_CHANGE>The user changed setting \`Model Selection\` from None to ${label}. </USER_SETTINGS_CHANGE>\n<USER_REQUEST>\nFind the bug\n</USER_REQUEST>`
const input = (ms, content) => ({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(ms), content })
const reply = (ms, step, tk) => ({ step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(ms), content: 'ok', input_tokens: tk[0], cache_read_tokens: tk[1], output_tokens: tk[2] })
const generic = (ms, step) => ({ step_index: step, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(ms), content: 'x' })

function transcript(root, id, rows, mtime) {
  const dir = join(root, 'brain', id, '.system_generated', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, 'transcript.jsonl')
  fs.writeFileSync(file, rows.map(line).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

describe("an Antigravity CLI conversation's sub-agents: agy's times and transcripts", () => {
  it("reads agy's index times, its zero time is none", () => {
    expect(agyTime('2026-10-15 13:25:05.0955539+00:00')).toBe(Date.parse('2026-10-15T13:25:05.095Z'))
    expect(agyTime('2026-10-02 17:04:54+02:00')).toBe(Date.parse('2026-10-02T15:04:54Z'))
    expect(agyTime(ZERO)).toBe(null)
    expect(agyTime('')).toBe(null)
    expect(agyTime('yesterday')).toBe(null)
  })

  it('the start and the model agy noted with the first prompt; the tokens of its last reply', () => {
    const at = Date.parse('2026-10-15T12:11:51Z')
    const text = [input(at, settings('Gemini 4 Argon (High)')), reply(at + 5000, 1, [11878, 0, 114])].map(line).join('\n')
    expect(parseAgyHead(text)).toEqual({ startedAt: at, model: 'Gemini 4 Argon', effort: 'high' })
    // The user's own words never count as agy's note.
    expect(parseAgyHead(line(input(at, '<USER_REQUEST>setting `Model Selection` from None to Fake (High). </USER_REQUEST>'))).model).toBe(null)
    const tail = summarizeAgyTail([line(reply(at + 1000, 1, [100, 0, 10])), line(reply(at + 2000, 3, [2670, 192959, 427])), line(generic(at + 3000, 4)), '{"cut'])
    expect(tail).toEqual({ last: at + 3000, tokens: 2670 + 192959 + 427, model: null, effort: null })
  })
})

describe.skipIf(!sqlite)("an Antigravity CLI conversation's sub-agents", () => {
  let gemini
  let root
  const now = Date.now()
  beforeEach(() => {
    _clearChildCachesForTest()
    gemini = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agykids-'))
    root = join(gemini, 'antigravity-cli')
  })
  afterEach(() => fs.rmSync(gemini, { recursive: true, force: true }))

  it('lists child conversations (and theirs) with state, type, title, times, tokens, model and effort', () => {
    index(root, [
      { id: P, title: 'Fix the login', steps: 284, modified: agy(now) },
      { id: K1, parent: P, agent: 'DeepCoder', title: 'Patch the parser', status: 'CASCADE_RUN_STATUS_RUNNING', modified: agy(now - 4000) },
      { id: K2, parent: P, agent: 'DeepInvestigator', title: 'Find the bug', modified: agy(now - 100000) },
      { id: K3, parent: P, killed: true, title: 'New Chat', status: 'CASCADE_RUN_STATUS_RUNNING', modified: agy(now - 200000) },
      // A child of K1: part of the same conversation.
      { id: K4, parent: K1, depth: 2, status: 'CASCADE_RUN_STATUS_BUSY', modified: agy(now - 2000) },
      // Still marked running, nothing written for 20 min.
      { id: K5, parent: P, status: 'CASCADE_RUN_STATUS_RUNNING', modified: agy(now - 20 * 60000) },
      // Just made: idle before its first step.
      { id: K6, parent: P, steps: 0, modified: ZERO },
      { id: OTHER, parent: '99999999-9999-4999-8999-999999999999', modified: agy(now) }
    ])
    transcript(root, K1, [input(now - 60000, settings('Claude Sonnet 4.6 (Thinking)')), reply(now - 4000, 1, [1000, 5000, 20])], now - 4000)
    transcript(root, K2, [input(now - 300000, settings('Gemini 4 Argon (High)')), reply(now - 200000, 1, [10, 0, 5]), reply(now - 100000, 3, [2670, 192959, 427])], now - 100000)
    transcript(root, K6, [input(now - 1000, 'go')], now - 1000)
    const list = antigravitySubagents(P, gemini, now)
    // Newest first by when they started (those without a transcript last);
    // never the conversation itself or another one's child.
    expect(list.map((c) => [c.id, c.type, c.title, c.state, c.tokens, c.model, c.effort])).toEqual([
      [K6, 'subagent', '', 'running', null, null, null],
      [K1, 'DeepCoder', 'Patch the parser', 'running', 6020, 'Claude Sonnet 4.6 (Thinking)', null],
      [K2, 'DeepInvestigator', 'Find the bug', 'done', 196056, 'Gemini 4 Argon', 'high'],
      [K4, 'subagent', '', 'running', null, null, null],
      [K3, 'subagent', '', 'done', null, null, null],
      [K5, 'subagent', '', 'quiet', null, null, null]
    ])
    const by = Object.fromEntries(list.map((c) => [c.id, c]))
    expect(by[K2].startedAt).toBe(Date.parse(iso(now - 300000)))
    expect(by[K2].endedAt).toBe(agyTime(agy(now - 100000)))
    expect(by[K1].endedAt).toBe(null)
    expect(by[K1].lastAt).toBeGreaterThanOrEqual(agyTime(agy(now - 4000)))
    expect(by[K5].lastAt).toBe(agyTime(agy(now - 20 * 60000)))
  })

  it('nothing for an id that is not a conversation id, another conversation, or no index', () => {
    index(root, [{ id: K1, parent: P }])
    expect(antigravitySubagents('not an id', gemini, now)).toEqual([])
    expect(antigravitySubagents(OTHER, gemini, now)).toEqual([])
    expect(antigravitySubagents(P, join(gemini, 'nowhere'), now)).toEqual([])
    expect(antigravitySubagents(P.toUpperCase(), gemini, now).map((c) => c.id)).toEqual([K1])
  })

  it("agy's folder reached through a junction is not read", () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agykids-outside-'))
    try {
      index(outside, [{ id: K1, parent: P, title: 'OUTSIDE' }])
      fs.symlinkSync(outside, root, 'junction')
      expect(antigravitySubagents(P, gemini, now)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a child's transcript folder reached through a junction is not read (the index row still is)", () => {
    index(root, [{ id: K1, parent: P, title: 'Mine', modified: agy(now - 1000) }])
    const outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agykids-brain-'))
    try {
      transcript(outside, K1, [input(now - 5000, settings('Gemini 4 Argon (High)')), reply(now - 1000, 1, [1, 1, 1])])
      fs.symlinkSync(join(outside, 'brain'), join(root, 'brain'), 'junction')
      const [kid] = antigravitySubagents(P, gemini, now)
      expect([kid.id, kid.title, kid.state, kid.model, kid.tokens]).toEqual([K1, 'Mine', 'done', null, null])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
