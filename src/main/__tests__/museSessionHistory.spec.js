// @vitest-environment node
// Muse Code's conversations in Tessel: the history list, the session a pane
// started (found by its folder and time), resuming it, its details and
// search, the Conversations tab and the chat view's reading, from fixtures
// shaped like Muse's session logs in a temporary home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { museHistorySessions, agentSessionList, moreAgentsHistory, HISTORY_AGENTS } from '../agentSessionSources'
import { findAgentSession, resumeTarget } from '../agentResume'
import { museSessionsDir } from '../museSessions'
import { findTranscriptViewFile, transcriptViewRoots, viewEvents, TRANSCRIPT_VIEW_AGENTS } from '../chat/transcriptView'
import { conversationItems, TERMINAL_CONVERSATION_AGENTS } from '../chat/terminalConversations'
import { sessionDetails, CONTENT_AGENTS } from '../sessionDetails'
import { listSources, rowsFromLines } from '../sessionSearch/indexer'
import { uuid7, line, museLog, writeMuseSession } from './fixtures/museLog'

let dir, home
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-history-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-muse-history-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
const CWD = 'C:\\Users\\me\\proj'
const started = Date.parse('2026-10-15T14:00:00Z')
const id = uuid7(started)
const write = (lines, sid = id) => writeMuseSession(museSessionsDir(home), sid, lines)

describe('Muse Code sessions: history and resume', () => {
  it('listed with its folder, start and first prompt; a sub-agent’s log is part of its parent', () => {
    const file = write(museLog({ cwd: CWD }))
    const sub = join(file, '..', 'subagent', uuid7(started + 5000))
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(join(sub, 'session.jsonl'), museLog({ prompt: 'child work' }).join('\n'))
    const rows = museHistorySessions(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'muse', id, cwd: CWD, started, title: 'Fix the login bug', file })
    expect(HISTORY_AGENTS).toContain('muse')
    expect(moreAgentsHistory({ cwd: CWD }, home).filter((r) => r.agent === 'muse')).toEqual([{ agent: 'muse', id, cwd: CWD, started, updated: rows[0].updated, title: 'Fix the login bug' }])
    expect(agentSessionList('muse', home, { since: started - 1000 }).map((r) => r.id)).toEqual([id])
  })

  it('the one a pane started: in its folder, at or after its start', () => {
    write(museLog({ cwd: CWD }))
    expect(findAgentSession({ agent: 'muse', cwd: CWD, since: started - 2000 }, home)).toBe(id)
    expect(findAgentSession({ agent: 'muse', cwd: 'C:\\other', since: started - 2000 }, home)).toBe(null)
    expect(findAgentSession({ agent: 'muse', cwd: CWD, since: started + 3600 * 1000 }, home)).toBe(null)
  })

  it('resumed only when its log exists', () => {
    write(museLog({ cwd: CWD }))
    expect(resumeTarget({ agent: 'muse', sessionId: id }, home)).toEqual({})
    expect(resumeTarget({ agent: 'muse', sessionId: uuid7(started + 99000) }, home)).toBe(null)
  })
})

describe('Muse Code sessions: details, search, Conversations and the chat view', () => {
  const longer = () => [
    ...museLog({ cwd: CWD }),
    line('run.model.configured', { record: { model_id: 'muse-spark-1.3', reasoning_effort: 'high' } }, '2026-10-15T14:01:00Z'),
    line('runtime.user_intent.accepted', { refill_blocks: [{ type: 'text', text: 'Now add a test' }] }, '2026-10-15T14:02:00Z'),
    line('runtime.session', { event: { kind: 'started', prompt: 'Now add a test' } }, '2026-10-15T14:02:00.200Z'),
    line('runtime.reasoning_effort_reconfigure.completed', { record: { reasoning_effort: 'xhigh' } }, '2026-10-15T14:02:00.300Z'),
    line('runtime.session', { event: { kind: 'assistant_message_committed', text: 'Added login.spec.ts.' } }, '2026-10-15T14:03:00Z')
  ]

  it('its details: the first prompt and the latest turns', () => {
    write(longer())
    expect(CONTENT_AGENTS).toContain('muse')
    const d = sessionDetails({ agent: 'muse', id }, home)
    expect(d).toMatchObject({ ok: true, firstPrompt: 'Fix the login bug', messageCount: 4 })
    expect(d.turns.map((t) => [t.role, t.text])).toEqual([
      ['assistant', 'Done: the token is refreshed.'],
      ['user', 'Now add a test'],
      ['assistant', 'Added login.spec.ts.']
    ])
  })

  it('search indexes what was said, from its listed log', () => {
    const file = write(longer())
    const src = listSources({ home, titles: false }).filter((s) => s.agent === 'muse')
    expect(src).toEqual([expect.objectContaining({ agent: 'muse', path: file, id, cwd: CWD, title: 'Fix the login bug' })])
    const rows = rowsFromLines('muse', longer(), id)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(rows[2]).toMatchObject({ text: 'Now add a test', ts: Date.parse('2026-10-15T14:02:00Z') })
  })

  it('the Conversations tab: your prompts and its answers, each with the model and effort it ran with', () => {
    expect(TERMINAL_CONVERSATION_AGENTS).toContain('muse')
    const items = conversationItems('muse', longer(), id)
    expect(items).toEqual([
      { role: 'user', t: Date.parse('2026-10-15T14:00:05Z'), text: 'Fix the login bug', model: 'muse-spark-1.3', effort: null },
      { role: 'agent', t: Date.parse('2026-10-15T14:00:20Z'), text: 'Done: the token is refreshed.', model: 'muse-spark-1.3', effort: 'high' },
      { role: 'user', t: Date.parse('2026-10-15T14:02:00Z'), text: 'Now add a test', model: 'muse-spark-1.3', effort: 'high' },
      { role: 'agent', t: Date.parse('2026-10-15T14:03:00Z'), text: 'Added login.spec.ts.', model: 'muse-spark-1.3', effort: 'xhigh' }
    ].map(({ effort, ...it }) => (effort ? { ...it, effort } : it)))
  })

  it('its file found by its id inside its sessions folder, never anywhere else', () => {
    const file = write(longer())
    expect(TRANSCRIPT_VIEW_AGENTS).toContain('muse')
    const roots = transcriptViewRoots(home, {})
    expect(findTranscriptViewFile('muse', id, roots)).toBe(file)
    expect(findTranscriptViewFile('muse', 'not-an-id', roots)).toBe(null)
    expect(findTranscriptViewFile('muse', uuid7(started + 7000), roots)).toBe(null)
    const events = viewEvents('muse', longer(), id)
    expect(events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Fix the login bug', 'Now add a test'])
    expect(events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Done: the token is refreshed.', 'Added login.spec.ts.'])
  })
})
