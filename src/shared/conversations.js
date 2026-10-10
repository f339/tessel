// Conversations of the agents: what the agents of a team said to each other,
// and what you and an agent said to each other through Tessel, as threads
// read from the activity log (src/shared/activity.js). Pure ESM, no Vue: the
// Conversations tab (ConversationsPanel.vue) shows what is built here, tests
// check it.
//
// The events read (recorded by App.vue with recordActivity):
//   message   what Tessel gave an agent: yours (source 'you': typed in its
//             chat, the notes, a review, your decision on a card), a lead's
//             brief (source 'lead'), another agent's through the team channel
//             (source 'agent', scope 'team-chat'), or a Tessel notice
//             (source 'tessel'). paneId is the recipient; from, the sender's
//             name when it is not you.
//   reply     what an agent said that Tessel did not type anywhere: its
//             answer in its chat (kind 'chat'), a decision it asks you
//             (kind 'decision'), its report on a card (kind 'report'). paneId
//             is the speaker; toPaneId/to, the agent it addresses (else you).
//
// A line: { key, t, kind: 'message' | 'reply' | 'notice', from: who, to: who,
//           toAll?: [who] (a team message: every recipient, to being the first),
//           text, preview, status, readCount?, replyKind?, taskTitle?, outcome?,
//           wsId, teamId }
//   who: { kind: 'you' | 'agent' | 'tessel', label, paneId: string | null,
//          agentId: string | null (the agent program: claude, codex, ..., for its logo) }
// A thread: { key, kind: 'team' | 'user', teamId, paneId, wsId, title,
//             participants: [label], lines, last, count }
//   'team:<teamId>'  everything said between the agents of a team
//   'you:<paneId>'   everything said between you and one agent

import { english } from './i18nText'

export const PREVIEW_LENGTH = 160
export const MAX_LINES_PER_THREAD = 2000
// A team message to several teammates ("team", a group) is kept once per
// recipient: copies of the same text by the same sender this close together
// are one message with several recipients.
export const BROADCAST_MS = 5000

export const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH)

const isWho = (w) => !!w && typeof w === 'object'
const you = (t = english) => ({ kind: 'you', label: t('conversations.you', 'You'), paneId: null, agentId: null })
const tessel = () => ({ kind: 'tessel', label: 'Tessel', paneId: null, agentId: null })
const agentWho = (label, paneId, t = english, agentId = null) => ({
  kind: 'agent',
  label: String(label || '').trim() || t('conversations.anAgent', 'An agent'),
  paneId: typeof paneId === 'string' && paneId ? paneId : null,
  agentId: typeof agentId === 'string' && agentId ? agentId : null
})

// The agents an older log names only by name (the sender of a team message
// recorded before the sender's pane was kept): the pane and program they had
// where the log knows them as a pane in the same team (a recipient, a
// speaker, a sender kept since), so their logo and pane are found too. Names
// are reused across projects, so a name is only trusted within its team.
function knownAgents(events) {
  const known = new Map() // "<teamId>|<name>" -> { paneId, agentId }
  const learn = (teamId, label, paneId, agentId) => {
    const name = String(label || '').trim()
    if (!name || typeof paneId !== 'string' || !paneId) return
    const key = `${teamId || ''}|${name}` // i18n-ignore
    const k = known.get(key) || { paneId: null, agentId: null }
    // The latest pane wins (a name can be reused by a later pane).
    k.paneId = paneId
    if (agentId) k.agentId = agentId
    known.set(key, k)
  }
  for (const e of events) {
    if (e.agent) learn(e.teamId, e.agent.title, e.paneId, e.agent.agentId)
    if (e.fromPaneId) learn(e.teamId, e.from, e.fromPaneId, e.fromAgentId)
  }
  return (teamId, label) => known.get(`${teamId || ''}|${String(label || '').trim()}`) || null // i18n-ignore
}

// A Tessel notice as shown: without its "[Tessel] " tag.
const noticeText = (text) => String(text || '').replace(/^\[Tessel\]\s*/, '')

// The lines of the log, oldest first, as what was said and to whom. A held
// message that was then delivered (or seen unconfirmed) stays one line with
// its final status.
// opts.t: the interface's t() (English without it)
export function conversationLines(events, opts = {}) {
  const t = opts.t || english
  const sorted = (events || []).filter((e) => e && Number.isFinite(e.t) && (e.type === 'message' || e.type === 'reply')).sort((a, b) => a.t - b.t)
  const lines = []
  const known = knownAgents(sorted)
  // The sender of a team message: as recorded (its pane, its program), else
  // by its name within the team when an older log has that.
  const sender = (e) => {
    if (e.fromPaneId) return agentWho(e.from, e.fromPaneId, t, e.fromAgentId || (known(e.teamId, e.from) || {}).agentId)
    const k = known(e.teamId, e.from)
    return k ? agentWho(e.from, k.paneId, t, k.agentId) : agentWho(e.from, null, t)
  }
  // paneId + text -> the line a later status event updates
  const open = new Map()
  // team + sender + text -> the team message its other copies join
  const broadcasts = new Map()
  for (const [i, e] of sorted.entries()) {
    const text = String(e.text || e.preview || '')
    if (!text) continue
    const paneId = typeof e.paneId === 'string' ? e.paneId : null
    const title = e.agent && e.agent.title ? e.agent.title : ''
    const agentId = e.agent && e.agent.agentId ? e.agent.agentId : (known(e.teamId, title) || {}).agentId || null
    const base = { key: `c${i}`, t: e.t, wsId: e.wsId || null, teamId: e.teamId || null } // i18n-ignore
    if (e.type === 'reply') {
      const toAgent = typeof e.toPaneId === 'string' && e.toPaneId ? agentWho(e.to, e.toPaneId, t, (known(e.teamId, e.to) || {}).agentId) : null
      lines.push({
        ...base,
        kind: 'reply',
        replyKind: ['chat', 'decision', 'report'].includes(e.kind) ? e.kind : 'chat',
        from: agentWho(title, paneId, t, agentId),
        to: toAgent || you(t),
        text,
        preview: e.preview || preview(text),
        status: 'sent',
        ...(e.taskTitle ? { taskTitle: String(e.taskTitle) } : {}),
        ...(e.outcome ? { outcome: String(e.outcome) } : {})
      })
      continue
    }
    const status = typeof e.status === 'string' ? e.status : 'sent'
    const slot = `${paneId}|${text}` // i18n-ignore
    // Confirmation of a message already listed: its status moves on.
    if (status === 'delivered' || status === 'unconfirmed') {
      const line = open.get(slot)
      if (line) {
        line.status = status === 'delivered' ? 'sent' : 'unconfirmed'
        if (status === 'delivered') open.delete(slot)
        continue
      }
      if (status === 'delivered') continue
    }
    const to = agentWho(title, paneId, t, agentId)
    let line
    if (e.source === 'tessel') {
      line = { ...base, kind: 'notice', from: tessel(), to, text: noticeText(text), preview: preview(noticeText(text)), status, scope: e.scope || null }
    } else if (e.scope === 'team-chat') {
      const from = sender(e)
      const key = `${e.teamId || ''}|${from.paneId || from.label}|${text}` // i18n-ignore
      const same = broadcasts.get(key)
      if (same && e.t - same.t <= BROADCAST_MS && !same.toAll.some((w) => w.label === to.label && w.paneId === to.paneId)) {
        same.toAll.push(to)
        if (status === 'read') same.readCount++
        same.status = same.readCount === same.toAll.length ? 'read' : same.readCount ? 'partly' : 'unread'
        continue
      }
      line = { ...base, kind: 'message', from, to, toAll: [to], readCount: status === 'read' ? 1 : 0, text, preview: e.preview || preview(text), status, scope: e.scope }
      broadcasts.set(key, line)
    } else if (e.source === 'agent' || e.source === 'lead') {
      line = { ...base, kind: 'message', from: sender(e), to, text, preview: e.preview || preview(text), status, scope: e.scope || null, ...(e.source === 'lead' ? { lead: true } : {}) }
    } else {
      line = { ...base, kind: 'message', from: you(t), to, text, preview: e.preview || preview(text), status, scope: e.scope || null, ...(e.taskTitle ? { taskTitle: String(e.taskTitle) } : {}) }
    }
    if (status === 'held' || status === 'sent') open.set(slot, line)
    lines.push(line)
  }
  return lines
}

// Who a line goes to: every recipient of a team message, else its one.
export const recipients = (line) => (line.toAll && line.toAll.length ? line.toAll : [line.to])

// Which thread a line belongs to: the team's when it goes between agents in
// a team (or is a team notice), else yours with the agent concerned.
export function threadKeyOf(line) {
  const betweenAgents = line.from.kind === 'agent' && line.to.kind === 'agent'
  if (line.kind === 'notice') return line.teamId ? `team:${line.teamId}` : `you:${line.to.paneId || ''}` // i18n-ignore
  if (betweenAgents && line.teamId) return `team:${line.teamId}` // i18n-ignore
  const pane = line.from.kind === 'agent' ? line.from.paneId : line.to.paneId
  return `you:${pane || ''}` // i18n-ignore
}

// The threads, latest first.
//   opts.t         the interface's t()
//   opts.teams     [{ id, name }] for the team threads' titles
//   opts.panes     { [paneId]: { title, agentId } } open now: their names
//                  win over the ones recorded
//   opts.wsId      only what happened in this workspace (null: everywhere)
//   opts.from      only lines from this time on
//   opts.notices   keep Tessel's notices (false: left out)
export function buildThreads(events, opts = {}) {
  const t = opts.t || english
  const panes = opts.panes || {}
  const teams = new Map((opts.teams || []).map((x) => [x.id, x]))
  const threads = new Map()
  for (const line of conversationLines(events, { t })) {
    if (opts.wsId && line.wsId && line.wsId !== opts.wsId) continue
    if (Number.isFinite(opts.from) && line.t < opts.from) continue
    if (line.kind === 'notice' && !opts.notices) continue
    for (const who of [line.from, ...recipients(line)]) {
      const pane = who.paneId ? panes[who.paneId] : null
      if (!pane) continue
      if (pane.title) who.label = pane.title
      if (pane.agentId && !who.agentId) who.agentId = pane.agentId
    }
    const key = threadKeyOf(line)
    let thread = threads.get(key)
    if (!thread) {
      const team = key.startsWith('team:') ? key.slice(5) : null
      const paneId = team ? null : key.slice(4) || null
      thread = {
        key,
        kind: team ? 'team' : 'user',
        teamId: team,
        paneId,
        wsId: line.wsId || null,
        title: '',
        participants: [],
        lines: [],
        last: 0,
        count: 0
      }
      threads.set(key, thread)
    }
    thread.lines.push(line)
    thread.last = Math.max(thread.last, line.t)
    if (!thread.wsId && line.wsId) thread.wsId = line.wsId
    for (const who of [line.from, ...recipients(line)]) if (who.kind === 'agent' && !thread.participants.includes(who.label)) thread.participants.push(who.label)
  }
  const out = []
  for (const thread of threads.values()) {
    if (thread.lines.length > MAX_LINES_PER_THREAD) thread.lines = thread.lines.slice(-MAX_LINES_PER_THREAD)
    thread.count = thread.lines.length
    if (thread.kind === 'team') {
      const team = teams.get(thread.teamId)
      thread.title = team && team.name ? team.name : t('conversations.formerTeam', 'A former team')
      thread.color = team && team.color ? team.color : null
    } else {
      const agent = thread.lines.map((l) => (l.from.kind === 'agent' ? l.from : l.to)).find((w) => w.kind === 'agent')
      thread.agent = agent ? agent.label : t('conversations.anAgent', 'An agent')
      thread.agentId = (agent && agent.paneId && panes[agent.paneId] && panes[agent.paneId].agentId) || null
      thread.title = t('conversations.withAgent', 'You and {{agent}}', { agent: thread.agent })
    }
    out.push(thread)
  }
  return out.sort((a, b) => b.last - a.last)
}

// The threads whose lines match: a text (in what was said, who said it, the
// thread's title) and a participant's name. A thread keeps only its
// matching lines when a query is given.
export function filterThreads(threads, { query = '', participant = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const who = String(participant || '').trim()
  if (!q && !who) return threads
  const out = []
  for (const thread of threads) {
    if (who && !thread.participants.includes(who)) continue
    if (!q) {
      out.push(thread)
      continue
    }
    const titleHit = thread.title.toLowerCase().includes(q)
    const lines = thread.lines.filter((l) => titleHit || l.text.toLowerCase().includes(q) || l.from.label.toLowerCase().includes(q) || recipients(l).some((w) => w.label.toLowerCase().includes(q)))
    if (!lines.length) continue
    out.push({ ...thread, lines, count: lines.length, matched: !titleHit })
  }
  return out
}

// Every agent named in the threads, for a filter.
export function participantsOf(threads) {
  const set = new Set()
  for (const thread of threads) for (const p of thread.participants) set.add(p)
  return [...set].sort((a, b) => a.localeCompare(b))
}

// How many lines, across the threads.
export const lineCount = (threads) => threads.reduce((n, th) => n + th.lines.length, 0)

// A line's status as text ('' when it reached its reader normally).
export function statusText(line, t = english) {
  switch (line.status) {
    case 'held':
      return t('conversations.status.held', 'waiting to be sent')
    case 'skipped':
      return t('conversations.status.skipped', 'not sent: usage limit')
    case 'failed':
      return t('conversations.status.failed', 'not sent')
    case 'unconfirmed':
      return t('conversations.status.unconfirmed', 'sent, not seen taken')
    case 'unread':
      return t('conversations.status.unread', 'not read yet')
    case 'partly':
      return t('conversations.status.partly', 'read by {{read}} of {{total}}', { read: line.readCount, total: recipients(line).length })
    default:
      return ''
  }
}

// What a reply is, as text ('' for a plain chat answer).
export function replyText(line, t = english) {
  if (line.kind !== 'reply') return ''
  if (line.replyKind === 'decision') return t('conversations.reply.decision', 'asks you to decide')
  if (line.replyKind === 'report')
    return line.outcome === 'failed' ? t('conversations.reply.reportFailed', 'reports: could not finish') : t('conversations.reply.report', 'reports: done')
  return ''
}

// A thread as plain text, to copy: one line per message, oldest first.
// locale: for the times (the interface's intlLocale()).
export function threadText(thread, { t = english, locale = [] } = {}) {
  const when = (at) => {
    const d = new Date(at)
    return `${d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
  }
  const head = thread.kind === 'team' ? t('conversations.export.team', 'Team "{{name}}"', { name: thread.title }) : thread.title
  const body = thread.lines.map((l) => {
    const note = [replyText(l, t), statusText(l, t), l.taskTitle ? t('conversations.onCard', 'on "{{title}}"', { title: l.taskTitle }) : ''].filter(Boolean).join(', ')
    return `[${when(l.t)}] ${l.from.label} → ${recipients(l).map((w) => w.label).join(', ')}${note ? ` (${note})` : ''}:\n${l.text}`
  })
  return [head, '', ...body].join('\n')
}
