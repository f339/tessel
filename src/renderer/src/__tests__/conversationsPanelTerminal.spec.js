// The Conversations tab (ConversationsPanel.vue) with what you and the agents
// said in their terminals (asked of the main process: conversations:terminal),
// and the model each line was said with at the bottom right of its bubble.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ConversationsPanel from '../components/ConversationsPanel.vue'

const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime()
const MIN = 60 * 1000
const ada = { title: 'Ada', agentId: 'claude' }
const bob = { title: 'Bob', agentId: 'codex' }
const SID = '11111111-2222-4333-8444-555555555555'
const SID2 = '0199aabb-ccdd-7eef-8000-000000000002'
const msg = (ago, paneId, agent, extra = {}) => ({
  t: NOW - ago,
  type: 'message',
  paneId,
  agent,
  status: 'sent',
  source: 'you',
  scope: 'workspace',
  wsId: 'ws1',
  ...extra
})

const projects = [
  {
    id: 'ws1',
    name: 'trading',
    panes: [
      {
        id: 'p1',
        kind: 'agent',
        agentId: 'claude',
        title: 'Ada',
        sessionId: SID,
        accountId: 'acc-1'
      },
      {
        id: 'p2',
        kind: 'agent',
        agentId: 'codex',
        title: 'Bob',
        sessionId: SID2,
        remoteHostId: 'ssh-box'
      },
      // A chat agent (its messages already go through Tessel), an agent not in a conversation yet, a shell.
      { id: 'p3', kind: 'chat', agentId: 'claude', title: 'Cy', sessionId: SID },
      { id: 'p4', kind: 'agent', agentId: 'claude', title: 'Di', sessionId: null },
      { id: 'p5', kind: 'shell', title: 'Terminal' }
    ]
  },
  {
    id: 'ws2',
    name: 'other',
    panes: [{ id: 'p9', kind: 'agent', agentId: 'claude', title: 'Zed', sessionId: SID }]
  }
]

const items = {
  p1: [
    {
      role: 'user',
      t: NOW - 30 * MIN,
      text: 'anything new ..',
      model: 'claude-opus-5-5',
      effort: 'xhigh'
    },
    {
      role: 'agent',
      t: NOW - 29 * MIN,
      text: 'Two trades closed.',
      model: 'claude-opus-5-5',
      effort: 'xhigh'
    },
    // Tessel typed this one (it is in the log): one line, the log's.
    { role: 'user', t: NOW - 9 * MIN, text: 'Read the notes' }
  ]
}
let calls = []
function api(
  answer = (q) => ({
    ok: true,
    panes: Object.fromEntries(
      q.panes
        .filter((p) => items[p.paneId])
        .map((p) => [p.paneId, { key: `k-${p.paneId}`, items: items[p.paneId] }])
    )
  })
) {
  calls = []
  window.shellApi = {
    conversations: {
      terminal: vi.fn(async (q) => {
        calls.push(JSON.parse(JSON.stringify(q)))
        return answer(q)
      })
    }
  }
}
const events = () => [
  msg(10 * MIN, 'p1', ada, { scope: 'notes', text: 'Read the notes' }),
  // A team message: its sender's model as Tessel recorded it.
  msg(5 * MIN, 'p2', bob, {
    source: 'agent',
    from: 'Ada',
    fromPaneId: 'p1',
    scope: 'team-chat',
    status: 'read',
    teamId: 'team1',
    text: 'Review the API',
    sender: {
      v: 1,
      paneId: 'p1',
      name: 'Ada',
      agentId: 'claude',
      model: 'Opus 5.5 · Très élevé',
      modelId: 'claude-opus-5-5',
      effort: 'xhigh'
    }
  })
]
const make = (props = {}) =>
  mount(ConversationsPanel, {
    props: {
      events: events(),
      teams: [{ id: 'team1', name: 'Team 2' }],
      projects,
      workspaceId: 'ws1',
      now: NOW,
      active: true,
      ...props
    },
    attachTo: document.body
  })
const thread = (w, key) => w.find(`[data-test="cv-thread-${key}"]`)
const texts = (el) => el.findAll('[data-test="cv-text"]').map((x) => x.text())

afterEach(() => {
  document.body.innerHTML = ''
  delete window.shellApi
})

describe('ConversationsPanel.vue: what was said in the terminals', () => {
  it('asks for the terminal agents of this workspace, then shows their lines in your thread with each, in time order', async () => {
    api()
    const w = make()
    await flushPromises()
    expect(calls[0].panes).toEqual([
      { paneId: 'p1', agent: 'claude', sessionId: SID, accountId: 'acc-1' },
      { paneId: 'p2', agent: 'codex', sessionId: SID2, hostId: 'ssh-box' }
    ])
    expect(calls[0].from).toBe(Math.floor((NOW - 7 * 24 * 3600 * 1000) / 60000) * 60000)
    const ada1 = thread(w, 'you:p1')
    expect(ada1.find('.sh-group-label').text()).toBe('You and Ada')
    // Newest first; the message Tessel typed is there once.
    expect(texts(ada1)).toEqual(['Read the notes', 'Two trades closed.', 'anything new ..'])
    const lines = ada1.findAll('[data-test="cv-line"]')
    expect(lines[0].find('[data-test="cv-via"]').exists()).toBe(false)
    expect(lines[1].find('[data-test="cv-via"]').attributes('title')).toBe(
      'Answered in its terminal'
    )
    expect(lines[2].find('[data-test="cv-via"]').attributes('title')).toBe('Typed in its terminal')
    expect(lines[1].classes()).toContain('from-agent')
    expect(lines[2].classes()).toContain('from-you')
    expect(w.find('[data-test="cv-count"]').text()).toBe('2 conversations · 4 messages')
    w.unmount()
  })

  it('the model and effort at the bottom right of the bubble, never in its head: terminal lines and team messages', async () => {
    api()
    const w = make()
    await flushPromises()
    const lines = thread(w, 'you:p1').findAll('[data-test="cv-line"]')
    const answer = lines[1]
    expect(answer.find('.cv-caption [data-test="cv-model"]').text()).toBe('Opus 5.5 · Extra high')
    expect(answer.find('.cv-line-head [data-test="cv-model"]').exists()).toBe(false)
    expect(answer.find('[data-test="cv-model"]').attributes('title')).toContain('claude-opus-5-5')
    expect(answer.find('.cv-caption').classes()).toContain('shown')
    // Your prompt: the model that answered it.
    expect(lines[2].find('[data-test="cv-model"]').text()).toBe('Opus 5.5 · Extra high')
    // Unknown: nothing shown.
    expect(lines[0].find('[data-test="cv-model"]').exists()).toBe(false)
    const team = thread(w, 'team:team1')
    expect(team.find('.cv-line-head').text()).toContain('Ada')
    expect(team.find('.cv-line-head [data-test="cv-model"]').exists()).toBe(false)
    expect(team.find('.cv-caption [data-test="cv-model"]').text()).toBe('Opus 5.5 · Très élevé')
    w.unmount()
  })

  it('all workspaces: their agents too; known lines are not sent again, and stay', async () => {
    api((q) => ({
      ok: true,
      panes: Object.fromEntries(
        q.panes
          .filter((p) => items[p.paneId])
          .map((p) => [
            p.paneId,
            q.known[p.paneId] === 'k-p1'
              ? { key: 'k-p1', same: true }
              : { key: 'k-p1', items: items.p1 }
          ])
      )
    }))
    const w = make()
    await flushPromises()
    await w.setProps({ now: NOW + 20000 })
    await flushPromises()
    expect(calls[1].known).toEqual({ p1: 'k-p1' })
    expect(texts(thread(w, 'you:p1'))).toHaveLength(3)
    await w.find('[data-test="cv-scope-all"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1].panes.map((p) => p.paneId)).toEqual(['p1', 'p2', 'p9'])
    w.unmount()
  })

  it('hidden: nothing is asked; shown: asked', async () => {
    api()
    const w = make({ active: false })
    await flushPromises()
    expect(calls).toHaveLength(0)
    await w.setProps({ active: true })
    await flushPromises()
    expect(calls).toHaveLength(1)
    w.unmount()
  })

  it('without the main process answering, the log alone as before', async () => {
    const w = make()
    await flushPromises()
    expect(texts(thread(w, 'you:p1'))).toEqual(['Read the notes'])
    w.unmount()
  })

  it('an agent’s name is never underlined, only a little lighter under the pointer', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ConversationsPanel.vue'), 'utf8')
    expect(src).not.toMatch(/\.cv-who[^{]*\{[^}]*underline/)
    expect(src).toMatch(/\.cv-who\.link:hover\s*\{\s*opacity:/)
  })
})
