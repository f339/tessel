// What you and an agent said in its terminal (src/shared/conversations.js
// terminalLines, withoutEchoes, buildThreads' opts.terminal): your thread
// with the agent, merged in time with the log's lines, without the messages
// Tessel itself typed there, with the model each line ran with.
import { describe, it, expect } from 'vitest'
import {
  buildThreads,
  terminalLines,
  withoutEchoes,
  conversationLines,
  threadText,
  modelOf,
  ECHO_AFTER_MS
} from '../conversations'

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
const reply = (min, paneId, agent, extra = {}) => ({
  t: T0 + min * MIN,
  type: 'reply',
  paneId,
  agent,
  kind: 'chat',
  wsId: 'ws1',
  ...extra
})
const item = (min, role, text, extra = {}) => ({ role, t: T0 + min * MIN, text, ...extra })
const adaEntry = (items, extra = {}) => ({
  paneId: 'p1',
  wsId: 'ws1',
  title: 'Ada',
  agentId: 'claude',
  agentName: 'Claude Code',
  sessionId: 's-1',
  host: 'local',
  items,
  ...extra
})
const panes = { p1: { title: 'Ada', agentId: 'claude' }, p2: { title: 'Bob', agentId: 'codex' } }

describe('terminalLines', () => {
  it('a prompt goes from you to the agent, an answer back, marked as said in its terminal', () => {
    const lines = terminalLines([
      adaEntry([
        item(1, 'user', 'Fix the build'),
        item(2, 'agent', 'Fixed.', { model: 'claude-opus-5-5', effort: 'high' })
      ])
    ])
    expect(lines.map((l) => [l.kind, l.from.kind, l.to.kind, l.text, l.via])).toEqual([
      ['message', 'you', 'agent', 'Fix the build', 'terminal'],
      ['reply', 'agent', 'you', 'Fixed.', 'terminal']
    ])
    expect(lines[1].replyKind).toBe('chat')
    expect(lines[1].from).toMatchObject({ label: 'Ada', paneId: 'p1', agentId: 'claude' })
    expect(lines[0].wsId).toBe('ws1')
    expect(lines[0].teamId).toBe(null)
  })

  it('each line carries the model and effort it ran with; an answer, the agent as its sender', () => {
    const lines = terminalLines(
      [
        adaEntry([
          item(1, 'user', 'Go', { model: 'claude-opus-5-5', effort: 'xhigh' }),
          item(2, 'agent', 'Done', { model: 'claude-opus-5-5', effort: 'xhigh' }),
          item(3, 'user', 'And?'),
          item(4, 'agent', 'Codex says hi', { model: 'gpt-6-astra' })
        ])
      ],
      { effortLabel: (e) => (e === 'xhigh' ? 'Très élevé' : e) }
    )
    expect(lines[0].run).toEqual({
      model: 'Opus 5.5 · Très élevé',
      modelId: 'claude-opus-5-5',
      effort: 'xhigh'
    })
    // A prompt is yours: no sender of its own, only the model it ran with.
    expect(lines[0].sender).toBeUndefined()
    expect(lines[1].sender).toMatchObject({
      paneId: 'p1',
      name: 'Ada',
      agentId: 'claude',
      agentName: 'Claude Code',
      model: 'Opus 5.5 · Très élevé',
      modelId: 'claude-opus-5-5',
      effort: 'xhigh',
      sessionId: 's-1',
      host: 'local'
    })
    expect(modelOf(lines[1])).toBe('Opus 5.5 · Très élevé')
    // Unknown: left empty, never guessed.
    expect(lines[2].run).toBeUndefined()
    expect(modelOf(lines[2])).toBe('')
    // No effort: the model alone.
    expect(lines[3].run).toEqual({ model: 'GPT-6 Astra', modelId: 'gpt-6-astra' })
  })

  it('skips items without time or text; two at the same time keep keys apart', () => {
    const lines = terminalLines([
      adaEntry([
        item(1, 'user', 'a'),
        item(1, 'user', 'b'),
        { role: 'user', t: NaN, text: 'x' },
        item(2, 'agent', '  ')
      ])
    ])
    expect(lines.map((l) => l.text)).toEqual(['a', 'b'])
    expect(new Set(lines.map((l) => l.key)).size).toBe(2)
  })
})

describe('withoutEchoes', () => {
  it('a message Tessel typed into the terminal stays the log line only; what you typed yourself is added', () => {
    const logged = conversationLines([
      // Yours, through its chat view or the notes: typed into its terminal by Tessel.
      msg(0, 'p1', ada, { scope: 'notes', text: 'Read the notes\r\nplease' }),
      // A Tessel notice typed there (its "[Tessel]" tag is not shown).
      msg(1, 'p1', ada, {
        source: 'tessel',
        scope: 'task',
        text: 'Please review the changes Bob made.'
      }),
      // A lead's brief to a worker (a team line, between agents).
      msg(2, 'p2', bob, {
        source: 'lead',
        from: 'Ada',
        fromPaneId: 'p1',
        teamId: 'team1',
        scope: 'task',
        text: 'Build the API'
      })
    ])
    const terminal = terminalLines([
      adaEntry([
        item(3, 'user', 'Read the notes please'),
        item(3.5, 'agent', 'Notes read.'),
        item(4, 'user', 'Please review the changes Bob made.'),
        item(4.5, 'agent', 'Reviewed: two bugs.'),
        item(5, 'user', 'Read the notes please'),
        item(6, 'user', 'My own question'),
        item(7, 'agent', 'My own answer')
      ]),
      {
        paneId: 'p2',
        wsId: 'ws1',
        title: 'Bob',
        agentId: 'codex',
        items: [item(3, 'user', 'Build the API'), item(4, 'agent', 'Started.')]
      }
    ])
    const kept = withoutEchoes(terminal, logged)
    // Your note's answer is yours; a Tessel notice's and a lead's brief's are
    // not; the same words a second time (you typed them yourself): kept.
    expect(kept.map((l) => `${l.from.label}:${l.text}`)).toEqual([
      'Ada:Notes read.',
      'You:Read the notes please',
      'You:My own question',
      'Ada:My own answer'
    ])
  })

  it('an answer Tessel recorded (a chat) is not added twice; one logged too long before is not that message', () => {
    const logged = conversationLines([
      reply(0, 'p1', ada, { text: 'Done: the tab is there.' }),
      msg(1, 'p1', ada, { text: 'Old message' })
    ])
    const late = (ECHO_AFTER_MS + 2 * MIN) / MIN
    const kept = withoutEchoes(
      terminalLines([
        adaEntry([
          item(0, 'agent', 'Done:  the tab is there.'),
          item(1 + late, 'user', 'Old message')
        ])
      ]),
      logged
    )
    expect(kept.map((l) => l.text)).toEqual(['Old message'])
  })

  it('a message never typed (failed, skipped) does not hide the prompt', () => {
    const logged = conversationLines([msg(0, 'p1', ada, { status: 'failed', text: 'Try this' })])
    expect(
      withoutEchoes(terminalLines([adaEntry([item(1, 'user', 'Try this')])]), logged)
    ).toHaveLength(1)
  })
})

describe('buildThreads with what was said in the terminals', () => {
  const events = [
    msg(0, 'p1', ada, { scope: 'chat', text: 'Through Tessel' }),
    reply(3, 'p1', ada, { text: 'Tessel answer' })
  ]
  const terminal = [
    adaEntry([
      item(1, 'user', 'Typed in the terminal'),
      item(2, 'agent', 'Answered there', { model: 'claude-opus-5-5', effort: 'high' })
    ]),
    {
      paneId: 'p9',
      wsId: 'ws2',
      title: 'Zed',
      agentId: 'codex',
      items: [item(4, 'user', 'Elsewhere')]
    }
  ]

  it('merged in time into your thread with that agent', () => {
    const threads = buildThreads(events, { panes, terminal, effortLabel: (e) => e.toUpperCase() })
    const ada1 = threads.find((th) => th.key === 'you:p1')
    expect(ada1.lines.map((l) => l.text)).toEqual([
      'Through Tessel',
      'Typed in the terminal',
      'Answered there',
      'Tessel answer'
    ])
    expect(ada1.lines.map((l) => l.via || '')).toEqual(['', 'terminal', 'terminal', ''])
    expect(ada1.title).toBe('You and Ada')
    expect(ada1.count).toBe(4)
    expect(ada1.lines[2].sender.model).toBe('Opus 5.5 · HIGH')
    expect(threads.find((th) => th.key === 'you:p9').title).toBe('You and Zed')
  })

  it('follows the scope and the period', () => {
    const scoped = buildThreads(events, { panes, terminal, wsId: 'ws1' })
    expect(scoped.map((th) => th.key)).toEqual(['you:p1'])
    const recent = buildThreads(events, { panes, terminal, wsId: 'ws1', from: T0 + 2 * MIN })
    expect(recent[0].lines.map((l) => l.text)).toEqual(['Answered there', 'Tessel answer'])
  })

  it('a thread made only of terminal lines; its copy says where each was said and with which model', () => {
    const threads = buildThreads([], { panes, terminal: [terminal[0]] })
    expect(threads).toHaveLength(1)
    const text = threadText(threads[0])
    expect(text).toContain('You → Ada (in its terminal):\nTyped in the terminal')
    expect(text).toContain('Ada → You (in its terminal, Opus 5.5 · high):\nAnswered there')
  })

  it('without terminal lines, the threads are as before', () => {
    expect(buildThreads(events, { panes, terminal: [] })).toEqual(buildThreads(events, { panes }))
  })
})

describe('review fixes', () => {
  it('an image message: the file says "[Image #1] …", the log does not: still one line', () => {
    const logged = conversationLines([
      msg(0, 'p1', ada, { scope: 'chat', text: 'What is wrong here?' })
    ])
    const kept = withoutEchoes(
      terminalLines([
        adaEntry([item(1, 'user', '[Image #1] What is wrong here?'), item(2, 'agent', 'A typo.')])
      ]),
      logged
    )
    expect(kept.map((l) => l.text)).toEqual(['A typo.'])
  })

  it('an agent on an SSH host whose clock is behind: Tessel’s message still shows once, its lines move into place', () => {
    const logged = conversationLines([
      msg(60, 'p1', ada, { scope: 'notes', text: 'Read the notes' })
    ])
    // The host writes 30 minutes behind this PC.
    const host = adaEntry(
      [
        item(25, 'user', 'Typed there first'),
        item(30, 'user', 'Read the notes'),
        item(31, 'agent', 'Notes read.')
      ],
      { host: 'ssh' }
    )
    const kept = withoutEchoes(terminalLines([host]), logged)
    expect(kept.map((l) => [l.text, (l.t - T0) / MIN])).toEqual([
      ['Typed there first', 55],
      ['Notes read.', 61]
    ])
    // Hours ahead: matched all the same (a local pane keeps the strict window).
    const ahead = adaEntry([item(60 + 180, 'user', 'Read the notes')], { host: 'ssh' })
    expect(withoutEchoes(terminalLines([ahead]), logged)).toEqual([])
    const local = adaEntry([item(60 - 30, 'user', 'Read the notes')])
    expect(withoutEchoes(terminalLines([local]), logged)).toHaveLength(1)
  })

  it('a pane’s conversations are told apart: an earlier one’s last prompt does not decide the next one’s answers', () => {
    const logged = conversationLines([
      msg(0, 'p1', ada, {
        source: 'tessel',
        scope: 'task',
        text: 'Please review the changes Bob made.'
      })
    ])
    const kept = withoutEchoes(
      terminalLines([
        adaEntry(
          [item(1, 'user', 'Please review the changes Bob made.'), item(2, 'agent', 'Reviewed.')],
          { group: 'p1~old' }
        ),
        adaEntry([item(3, 'agent', 'A new conversation, mid-turn.')])
      ]),
      logged
    )
    expect(kept.map((l) => l.text)).toEqual(['A new conversation, mid-turn.'])
    expect(new Set(kept.map((l) => l.key)).size).toBe(1)
  })

  it('a pane closed since: its thread shows its program from its lines', () => {
    const threads = buildThreads([], { panes: {}, terminal: [adaEntry([item(1, 'user', 'Hi')])] })
    expect(threads[0].agentId).toBe('claude')
    expect(threads[0].title).toBe('You and Ada')
  })
})
