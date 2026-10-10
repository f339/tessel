// The conversations of the agents (src/shared/conversations.js): the lines
// read from the activity log, their threads, the filters and the export.
import { describe, it, expect } from 'vitest'
import { conversationLines, buildThreads, filterThreads, participantsOf, lineCount, threadKeyOf, threadText, statusText, replyText, preview, recipients } from '../conversations'

const T0 = Date.parse('2026-10-10T12:00:00Z')
const MIN = 60 * 1000
const ada = { title: 'Ada', agentId: 'claude' }
const bob = { title: 'Bob', agentId: 'codex' }
const msg = (min, paneId, agent, extra = {}) => ({
  t: T0 + min * MIN,
  type: 'message',
  paneId,
  agent,
  status: 'sent',
  source: 'you',
  scope: 'workspace',
  wsId: 'ws1',
  ...extra
})
const reply = (min, paneId, agent, extra = {}) => ({ t: T0 + min * MIN, type: 'reply', paneId, agent, kind: 'chat', wsId: 'ws1', ...extra })

const events = [
  // You and Ada, in her chat.
  msg(0, 'p1', ada, { scope: 'chat', text: 'Please add the tab' }),
  reply(1, 'p1', ada, { text: 'Done: the tab is there.' }),
  // Ada and Bob, through the team channel (Bob's pane receives).
  msg(2, 'p2', bob, { source: 'agent', from: 'Ada', scope: 'team-chat', status: 'unread', teamId: 'team1', text: 'Can you review the API?' }),
  msg(3, 'p1', ada, { source: 'agent', from: 'Bob', scope: 'team-chat', status: 'read', teamId: 'team1', text: 'Looks good.' }),
  // Tessel tells Ada her team changed.
  msg(4, 'p1', ada, { source: 'tessel', scope: 'team-change', teamId: 'team1', text: '[Tessel] Bob joined your team.' }),
  // Bob asks you to decide, you answer.
  reply(5, 'p2', bob, { kind: 'decision', teamId: 'team1', taskTitle: 'Ship it', text: 'Merge now or wait?' }),
  msg(6, 'p2', bob, { scope: 'decision', teamId: 'team1', taskTitle: 'Ship it', text: 'Wait' }),
  // Bob reports to Ada (who gave the card).
  reply(7, 'p2', bob, { kind: 'report', outcome: 'succeeded', teamId: 'team1', taskTitle: 'Ship it', toPaneId: 'p1', to: 'Ada', text: 'Merged after the checks.' }),
  // Notes held behind an approval, then delivered: one line.
  msg(8, 'p1', ada, { scope: 'notes', status: 'held', text: 'Read the notes' }),
  msg(9, 'p1', ada, { scope: 'notes', status: 'delivered', text: 'Read the notes' }),
  // Another workspace.
  msg(10, 'p9', { title: 'Zed', agentId: 'gemini' }, { wsId: 'ws2', text: 'Elsewhere' }),
  // Not conversations.
  { t: T0, type: 'agent.state', paneId: 'p1', state: 'working', agent: ada },
  { t: T0, type: 'task', action: 'started', paneId: 'p1', title: 'x' }
]

describe('conversationLines', () => {
  it('reads messages and replies, oldest first, with who said what to whom', () => {
    const lines = conversationLines(events)
    expect(lines.map((l) => l.kind)).toEqual(['message', 'reply', 'message', 'message', 'notice', 'reply', 'message', 'reply', 'message', 'message'])
    expect(lines[0].from).toEqual({ kind: 'you', label: 'You', paneId: null, agentId: null })
    expect(lines[0].to).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[1].from).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[1].to.kind).toBe('you')
    // Between agents: the sender is named only; its pane and program (its
    // logo) come from the lines where the log knows it as a pane.
    expect(lines[2].from).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[2].to).toEqual({ kind: 'agent', label: 'Bob', paneId: 'p2', agentId: 'codex' })
    expect(lines[2].status).toBe('unread')
    // A notice drops its tag.
    expect(lines[4].from.kind).toBe('tessel')
    expect(lines[4].text).toBe('Bob joined your team.')
    // A report addressed to an agent.
    expect(lines[7].to).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[7].replyKind).toBe('report')
    expect(lines[7].outcome).toBe('succeeded')
  })

  it('a held message that was delivered is one line, sent', () => {
    const lines = conversationLines(events).filter((l) => l.text === 'Read the notes')
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('sent')
  })

  it('a pasted message not seen taken keeps that status; a stray delivery is ignored', () => {
    const lines = conversationLines([
      msg(0, 'p1', ada, { text: 'hi' }),
      msg(1, 'p1', ada, { status: 'unconfirmed', text: 'hi' }),
      msg(2, 'p1', ada, { status: 'delivered', text: 'never held' })
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('unconfirmed')
  })

  it('a sender recorded with its pane and program is shown as such, whatever its name elsewhere', () => {
    const lines = conversationLines([
      // Another "Ada", an OpenCode in another team.
      msg(0, 'p7', { title: 'Ada', agentId: 'opencode' }, { teamId: 'team9', text: 'Elsewhere' }),
      msg(1, 'p2', bob, { source: 'agent', from: 'Ada', fromPaneId: 'p1', fromAgentId: 'claude', scope: 'team-chat', teamId: 'team1', text: 'Hi Bob' }),
      // Its program not known when recorded (its pane was closed): learned
      // from this team's lines, not from the other team's Ada.
      msg(2, 'p2', bob, { source: 'agent', from: 'Ada', fromPaneId: 'p1', scope: 'team-chat', teamId: 'team1', text: 'Again' }),
      msg(3, 'p2', bob, { source: 'agent', from: 'Grace', scope: 'team-chat', teamId: 'team1', text: 'Hello' })
    ])
    expect(lines[1].from).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[2].from).toEqual({ kind: 'agent', label: 'Ada', paneId: 'p1', agentId: 'claude' })
    // Never known as a pane in this team: only its name.
    expect(lines[3].from).toEqual({ kind: 'agent', label: 'Grace', paneId: null, agentId: null })
  })

  it('a message to the whole team is one line with every recipient', () => {
    const carl = { title: 'Carl', agentId: 'gemini' }
    const team = (min, paneId, agent, status, text = 'Standup in 5') =>
      msg(min, paneId, agent, { source: 'agent', from: 'Ada', fromPaneId: 'p1', fromAgentId: 'claude', scope: 'team-chat', status, teamId: 'team1', text })
    const lines = conversationLines([
      team(0, 'p2', bob, 'read'),
      team(0, 'p3', carl, 'unread'),
      // The same words a minute later: a message of its own.
      team(1, 'p2', bob, 'unread')
    ])
    expect(lines).toHaveLength(2)
    expect(recipients(lines[0]).map((w) => w.label)).toEqual(['Bob', 'Carl'])
    expect(lines[0].to.label).toBe('Bob')
    expect(lines[0].status).toBe('partly')
    expect(statusText(lines[0])).toBe('read by 1 of 2')
    expect(recipients(lines[1]).map((w) => w.label)).toEqual(['Bob'])
    const thread = buildThreads([team(0, 'p2', bob, 'read'), team(0, 'p3', carl, 'read')])[0]
    expect(thread.participants).toEqual(['Ada', 'Bob', 'Carl'])
    expect(thread.lines[0].status).toBe('read')
    expect(filterThreads([thread], { query: 'carl' })[0].lines).toHaveLength(1)
    expect(threadText(thread, { locale: 'en-US' })).toContain('] Ada → Bob, Carl:\nStandup in 5')
  })

  it('a name is trusted only within its team', () => {
    const lines = conversationLines([
      msg(0, 'p7', { title: 'Ada', agentId: 'opencode' }, { teamId: 'team9', text: 'Elsewhere' }),
      msg(1, 'p2', bob, { source: 'agent', from: 'Ada', scope: 'team-chat', teamId: 'team1', text: 'Hi Bob' })
    ])
    expect(lines[1].from).toEqual({ kind: 'agent', label: 'Ada', paneId: null, agentId: null })
  })

  it('skips events without text and unknown types', () => {
    expect(conversationLines([msg(0, 'p1', ada, { text: '' }), { t: T0, type: 'team', action: 'created' }, null])).toEqual([])
  })
})

describe('threadKeyOf', () => {
  it('between agents in a team: the team; with you: the agent', () => {
    const lines = conversationLines(events)
    expect(threadKeyOf(lines[0])).toBe('you:p1')
    expect(threadKeyOf(lines[1])).toBe('you:p1')
    expect(threadKeyOf(lines[2])).toBe('team:team1')
    expect(threadKeyOf(lines[4])).toBe('team:team1') // a team notice
    expect(threadKeyOf(lines[5])).toBe('you:p2') // a decision asked of you
    expect(threadKeyOf(lines[7])).toBe('team:team1') // a report to another agent
  })
})

describe('buildThreads', () => {
  const teams = [{ id: 'team1', name: 'Team 2', color: '#aabbcc' }]

  it('one thread per team and per agent you talked with, latest first, notices left out', () => {
    const threads = buildThreads(events, { teams })
    expect(threads.map((th) => th.key)).toEqual(['you:p9', 'you:p1', 'team:team1', 'you:p2'])
    const team = threads.find((th) => th.key === 'team:team1')
    expect(team.kind).toBe('team')
    expect(team.title).toBe('Team 2')
    expect(team.color).toBe('#aabbcc')
    expect(team.lines.map((l) => l.text)).toEqual(['Can you review the API?', 'Looks good.', 'Merged after the checks.'])
    expect(team.participants).toEqual(['Ada', 'Bob'])
    const ada1 = threads.find((th) => th.key === 'you:p1')
    expect(ada1.kind).toBe('user')
    expect(ada1.title).toBe('You and Ada')
    expect(ada1.agent).toBe('Ada')
    expect(ada1.lines.map((l) => l.text)).toEqual(['Please add the tab', 'Done: the tab is there.', 'Read the notes'])
    expect(ada1.count).toBe(3)
    expect(ada1.last).toBe(T0 + 8 * MIN)
    const bob1 = threads.find((th) => th.key === 'you:p2')
    expect(bob1.lines.map((l) => l.text)).toEqual(['Merge now or wait?', 'Wait'])
  })

  it('keeps Tessel notices when asked', () => {
    const team = buildThreads(events, { teams, notices: true }).find((th) => th.key === 'team:team1')
    expect(team.lines.map((l) => l.kind)).toEqual(['message', 'message', 'notice', 'reply'])
  })

  it('a workspace scope keeps its own lines; a period, the recent ones', () => {
    expect(buildThreads(events, { wsId: 'ws1' }).map((th) => th.key)).toEqual(['you:p1', 'team:team1', 'you:p2'])
    expect(buildThreads(events, { wsId: 'ws2' }).map((th) => th.key)).toEqual(['you:p9'])
    const recent = buildThreads(events, { from: T0 + 7 * MIN })
    expect(recent.map((th) => th.key)).toEqual(['you:p9', 'you:p1', 'team:team1'])
    expect(recent.find((th) => th.key === 'you:p1').lines.map((l) => l.text)).toEqual(['Read the notes'])
  })

  it('the names of the panes open now win over the recorded ones; an unknown team is named so', () => {
    const threads = buildThreads(events, { panes: { p1: { title: 'Ada (renamed)', agentId: 'claude' }, p9: { title: 'Zed', agentId: 'gemini' } } })
    const ada1 = threads.find((th) => th.key === 'you:p1')
    expect(ada1.title).toBe('You and Ada (renamed)')
    expect(ada1.agentId).toBe('claude')
    expect(ada1.lines[0].to.label).toBe('Ada (renamed)')
    // A pane open now also names the program of a line that had none.
    const bare = buildThreads([msg(0, 'p9', { title: 'Zed' }, { text: 'x' })], { panes: { p9: { title: 'Zed', agentId: 'gemini' } } })
    expect(bare[0].lines[0].to.agentId).toBe('gemini')
    expect(threads.find((th) => th.key === 'team:team1').title).toBe('A former team')
  })

  it('uses the interface language', () => {
    const t = (key, en) => (key === 'conversations.you' ? 'Vous' : key === 'conversations.withAgent' ? 'Vous et {{agent}}'.replace('{{agent}}', 'Ada') : en)
    const threads = buildThreads(events, { t, wsId: 'ws1' })
    expect(threads.find((th) => th.key === 'you:p1').title).toBe('Vous et Ada')
    expect(threads.find((th) => th.key === 'you:p1').lines[0].from.label).toBe('Vous')
  })
})

describe('filterThreads and friends', () => {
  const threads = buildThreads(events, { teams: [{ id: 'team1', name: 'Team 2' }] })

  it('a search keeps the matching lines; a participant, the threads they are in', () => {
    const hit = filterThreads(threads, { query: 'review' })
    expect(hit.map((th) => th.key)).toEqual(['team:team1'])
    expect(hit[0].lines.map((l) => l.text)).toEqual(['Can you review the API?'])
    expect(hit[0].count).toBe(1)
    // A thread named by the query keeps every line.
    expect(filterThreads(threads, { query: 'team 2' })[0].lines).toHaveLength(3)
    expect(filterThreads(threads, { participant: 'Bob' }).map((th) => th.key)).toEqual(['team:team1', 'you:p2'])
    expect(filterThreads(threads, { participant: 'Bob', query: 'wait' }).map((th) => th.key)).toEqual(['you:p2'])
    expect(filterThreads(threads, {})).toBe(threads)
  })

  it('participants and counts', () => {
    expect(participantsOf(threads)).toEqual(['Ada', 'Bob', 'Zed'])
    expect(lineCount(threads)).toBe(9)
  })

  it('status and reply texts', () => {
    expect(statusText({ status: 'held' })).toBe('waiting to be sent')
    expect(statusText({ status: 'unread' })).toBe('not read yet')
    expect(statusText({ status: 'sent' })).toBe('')
    expect(replyText({ kind: 'reply', replyKind: 'decision' })).toBe('asks you to decide')
    expect(replyText({ kind: 'reply', replyKind: 'report', outcome: 'failed' })).toBe('reports: could not finish')
    expect(replyText({ kind: 'message' })).toBe('')
    expect(preview('  a\n\n b   c ')).toBe('a b c')
  })

  it('a thread as text to copy', () => {
    const text = threadText(threads.find((th) => th.key === 'you:p2'), { locale: 'en-US' })
    expect(text.startsWith('You and Bob\n\n[')).toBe(true)
    expect(text).toContain('] Bob → You (asks you to decide, on "Ship it"):\nMerge now or wait?')
    expect(text).toContain('] You → Bob (on "Ship it"):\nWait')
    expect(threadText(threads.find((th) => th.key === 'team:team1'), { locale: 'en-US' }).startsWith('Team "Team 2"\n')).toBe(true)
  })
})
