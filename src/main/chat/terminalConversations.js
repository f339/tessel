// What you and each terminal agent said to each other in its terminal, for
// the Conversations tab (ConversationsPanel.vue, src/shared/conversations.js):
// your prompts and its answers, read from the agent's own conversation file
// with the chat view's readers (transcriptView.js: the file found by its id
// inside the agent's own folder, never a path from the window, and its lines
// decoded by the same parsers), then cut to what a conversation shows.
//
// Kept: what you typed (not a tool's result, not Claude Code's own notes, a
// hook's context or a background task's notice, not the context an agent
// adds around a prompt, not Tessel's own "[Tessel …]" messages), and the
// agent's answer to each prompt: the text it wrote after its last tool call
// of the turn (not the text between its tool calls, not its thinking; not
// its answer to Tessel's own message or another session's). Each
// with its time, and the model and effort it ran with when the file says so
// (Claude Code: each answer's model and effort; Codex: its turn_context, as
// agentModel.js reads them for the pane header); else none, never a guess.
//
// Bounded: the last 2 MB of a local file (512 KB of a host's), read async,
// then only what was added since the last read (remoteTranscripts.js's tail,
// for local files too); at most 200 lines a pane within the period asked
// (300 000 characters), each text cut at 8000 characters; 64 panes asked at
// once, 64 files kept in memory (the least recently asked go first), one read
// at a time. A file is decoded again only when its size or time changed. An
// agent on an SSH host (Claude Code, Codex: remoteFs.js readAgentFile, the
// file found by its id in the agent's folder there) is asked at most once a
// minute. The window names agents, session ids, panes, accounts and hosts,
// never a folder or a file; what is read goes back to that window only.
import fs from 'fs'
import { HISTORY_LIMITS } from './transcriptHistory.js'
import {
  findTranscriptViewFile,
  reportedTranscript,
  transcriptViewRoots,
  validViewId,
  viewEvents
} from './transcriptView.js'
import { createRemoteTail, remoteWindowReader, validRemoteTranscript } from './remoteTranscripts.js'

// Cursor is left out: its file keeps no times (a line could not be placed).
export const TERMINAL_CONVERSATION_AGENTS = [
  'claude',
  'codex',
  'openclaude',
  'antigravity',
  'grok',
  'omp'
]
// Their folder is the pane's account's (homes()).
const ACCOUNT_AGENTS = ['claude', 'codex']
// Their hooks may name the session's file (sessions/<pane>.json).
const REPORTING_AGENTS = ['claude', 'codex', 'openclaude']

export const TERMINAL_LIMITS = {
  localBytes: 2 * 1024 * 1024,
  remoteBytes: 512 * 1024,
  items: 200,
  chars: 300000,
  text: 8000,
  panes: 64,
  entries: 64,
  remoteEveryMs: 60 * 1000,
  // A file not found is looked for again after this long.
  missingMs: 60 * 1000
}

const PANE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/
const ACCOUNT_ID = /^[\w.-]{1,80}$/
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)
function parse(line) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}
function timeOf(v) {
  const ms = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(ms) ? ms : null
}

// ---- What a line says -------------------------------------------------------------

// Context an agent or its host puts before a prompt (Claude Code's
// <ide_opened_file>, <task-notification>, <bash-input>, Codex's
// <in-app-browser-context>…): a tag whose name has a "-" or "_", closed.
const CONTEXT_BLOCK = /^<([a-zA-Z][a-zA-Z0-9]*[_-][\w-]{0,60})(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
// Claude Code's mark around a paste (no closing tag): the paste is kept.
const PASTE_MARK = /<\/?pasted_content\b[^>]*>/g

// What you typed, without what was added around it; '' when nothing is
// yours (Tessel's own messages, a bare slash command such as /clear).
export function cleanPrompt(text) {
  let s = String(text || '')
    .replace(REMINDER, '')
    .trim()
  for (let i = 0; i < 8; i++) {
    const m = CONTEXT_BLOCK.exec(s)
    if (!m) break
    s = s.slice(m[0].length).trimStart()
  }
  s = s.replace(PASTE_MARK, '').trim()
  if (!s || /^\[Tessel\b/.test(s) || /^\/[\w:.-]+$/.test(s)) return ''
  return s
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// Claude Code: a user line that is not you (a background task's notice, a
// message from another session such as Tessel's reminder in its inbox: its
// origin says so) is not shown, but it starts a turn of its own: the line
// becomes a bare prompt marked TURN (PEER for another session's), so the
// answer before it stays that turn's.
const TURN = '\u0000turn'
const PEER = '\u0000peer'
function claudeLine(line) {
  if (!line.includes('"origin"') || !line.includes('"type":"user"')) return line
  const r = parse(line)
  if (!r || r.type !== 'user') return line
  const kind = obj(r.origin)?.kind
  if (typeof kind !== 'string' || kind === 'human') return line
  return JSON.stringify({
    type: 'user',
    uuid: r.uuid,
    timestamp: r.timestamp,
    message: { role: 'user', content: kind === 'peer' ? PEER : TURN }
  })
}
// Codex: an agent message marked as commentary (what it says between tool
// calls) is not its answer.
function codexAnswer(line) {
  if (!line.includes('"commentary"')) return true
  const r = parse(line)
  const p = r && obj(r.payload)
  if (!p) return true
  const item = p.type === 'item_completed' ? obj(p.item) : p.type === 'message' ? p : null
  return !(item && item.phase === 'commentary')
}

// The models a file names, in its order: [{ t, model, effort }]. Claude Code:
// each answer's model and the effort it ran with (perTurnEffort, else
// effort); Codex: each turn_context (and thread settings applied), its effort
// on the turn or in its collaboration mode. As agentModel.js reads them.
export function modelTimeline(agent, lines) {
  const out = []
  const claude = agent === 'claude' || agent === 'openclaude'
  if (!claude && agent !== 'codex') return out
  for (const line of lines) {
    if (!line.includes('"model"')) continue
    const o = parse(line)
    if (!o) continue
    const t = timeOf(o.timestamp)
    if (t == null) continue
    if (claude) {
      const m = obj(o.message)?.model
      if (
        o.type !== 'assistant' ||
        o.isSidechain === true ||
        typeof m !== 'string' ||
        !m ||
        m.startsWith('<')
      )
        continue
      const e = [o.perTurnEffort, o.effort].find((x) => CLAUDE_EFFORTS.includes(x))
      out.push({ t, model: m, effort: e || null })
      continue
    }
    const p = obj(o.payload)
    if (!p) continue
    if (o.type === 'turn_context' && str(p.model)) {
      const mode = obj(obj(p.collaboration_mode)?.settings)
      const effort = p.effort || p.reasoning_effort || (mode && mode.reasoning_effort)
      out.push({ t, model: p.model, effort: str(effort) })
      continue
    }
    const s = p.type === 'thread_settings_applied' ? obj(p.thread_settings) : null
    if (s && str(s.model))
      out.push({ t, model: s.model, effort: str(s.reasoning_effort || s.effort) })
  }
  return out
}

// The latest model named at or before t.
function modelAt(timeline, t) {
  let hit = null
  for (const m of timeline) {
    if (m.t > t) break
    hit = m
  }
  return hit
}

// One session's lines -> [{ role: 'user' | 'agent', t, text, model?, effort? }],
// oldest first.
export function conversationItems(agent, lines, sessionId, limits = TERMINAL_LIMITS) {
  const claude = agent === 'claude' || agent === 'openclaude'
  const kept = claude
    ? lines.map(claudeLine)
    : agent === 'codex'
      ? lines.filter(codexAnswer)
      : lines
  // No attachment caps: an image is "[image]" text, nothing is decoded.
  const events = viewEvents(agent, kept, sessionId, HISTORY_LIMITS)
  const items = []
  const push = (role, t, text) => {
    const s = String(text || '').trim()
    if (!Number.isFinite(t) || !s) return
    items.push({ role, t, text: clip(s, limits.text) })
  }
  let reply = [] // the turn's texts since its last tool call
  // The turn answers you: your prompt, your agent's own background task
  // going on (or a window that starts inside a turn); not a message from
  // Tessel or another session (its answer is theirs).
  let yours = true
  const flush = () => {
    if (reply.length && yours)
      push('agent', reply[reply.length - 1].at, reply.map((e) => e.text).join('\n\n'))
    reply = []
  }
  for (const ev of events) {
    if (ev.type === 'user') {
      flush()
      const own = ev.text === TURN || ev.text === PEER ? '' : cleanPrompt(ev.text)
      yours = ev.text === TURN || !!own || (ev.text !== PEER && !/^\s*\[Tessel\b/.test(ev.text))
      if (own) push('user', ev.at, own)
    } else if (ev.type === 'turnEnd') flush()
    // A tool call (not a call's later status): the text before it was not the answer.
    else if (ev.type === 'tool' && typeof ev.name === 'string') reply = []
    else if (ev.type === 'assistant') reply.push(ev)
  }
  flush()
  const timeline = modelTimeline(agent, kept)
  if (timeline.length) {
    items.forEach((it, i) => {
      // Claude Code names the model on its answers: a prompt's is the answer's
      // to it (none yet: unknown). Codex names it when the turn starts.
      const m =
        claude && it.role === 'user'
          ? items[i + 1] && items[i + 1].role === 'agent'
            ? modelAt(timeline, items[i + 1].t)
            : null
          : modelAt(timeline, it.t)
      if (m) {
        it.model = m.model
        if (m.effort) it.effort = m.effort
      }
    })
  }
  return items
}

// ---- Reading ------------------------------------------------------------------------

// A local file read like a host's (remoteTranscripts.js createRemoteTail's
// readWindow), async: { ok, size, mtimeMs, data } | { ok: false, missing? }.
export function localWindowReader(file, fsp = fs.promises) {
  return async ({ offset = null, cap }) => {
    let fh = null
    try {
      fh = await fsp.open(file, 'r')
      const st = await fh.stat()
      if (!st.isFile()) return { ok: false, missing: true }
      const start = offset === null ? Math.max(0, st.size - cap) : Math.min(offset, st.size)
      const len = Math.max(0, Math.min(cap, st.size - start))
      const data = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const { bytesRead } = await fh.read(data, got, len - got, start + got)
        if (!bytesRead) break
        got += bytesRead
      }
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs, data: data.subarray(0, got) }
    } catch (err) {
      return { ok: false, missing: !!err && err.code === 'ENOENT' }
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }
}

// The window's ask, checked: [{ paneId, agent, sessionId, accountId?, hostId? }].
function panesOf(list, max) {
  const out = []
  for (const raw of Array.isArray(list) ? list.slice(0, max) : []) {
    const p = obj(raw)
    if (
      !p ||
      typeof p.paneId !== 'string' ||
      !PANE_ID.test(p.paneId) ||
      !TERMINAL_CONVERSATION_AGENTS.includes(p.agent)
    )
      continue
    if (p.hostId != null) {
      if (validRemoteTranscript(p.agent, p.hostId, p.sessionId))
        out.push({ paneId: p.paneId, agent: p.agent, sessionId: p.sessionId, hostId: p.hostId })
      continue
    }
    if (!validViewId(p.agent, p.sessionId)) continue
    const accountId =
      p.accountId === null || (typeof p.accountId === 'string' && ACCOUNT_ID.test(p.accountId))
        ? p.accountId
        : undefined
    out.push({ paneId: p.paneId, agent: p.agent, sessionId: p.sessionId, accountId })
  }
  return out
}

// homes(agent, accountId) -> the folder Claude Code or Codex keeps that
// account's conversations in (or null); sessionsDir() -> where the panes'
// hooks report their sessions; readAgentFile(hostId, q) -> a host's file
// window (remoteFs.js), or null when hosts are not read.
export function createTerminalConversations({
  homes = async () => null,
  sessionsDir = () => null,
  readAgentFile = null,
  roots = transcriptViewRoots,
  limits = TERMINAL_LIMITS,
  now = () => Date.now(),
  fsp = fs.promises,
  log = null
} = {}) {
  const entries = new Map() // key -> { key, agent, sessionId, hostId, tail, seen, stamp, items, readAt }
  const missing = new Map() // key -> when its file was last looked for in vain
  let queue = Promise.resolve()
  let serial = 0

  function keep(entry) {
    entries.delete(entry.key)
    entries.set(entry.key, entry)
    while (entries.size > limits.entries) entries.delete(entries.keys().next().value)
  }
  // One file's tail (only what was added is read each time); seen: its size
  // and time at the last read.
  function newEntry(key, agent, sessionId, hostId, readWindow, bytes) {
    const entry = {
      key,
      agent,
      sessionId,
      hostId,
      tail: null,
      seen: null,
      stamp: '',
      items: null,
      readAt: 0,
      // What the window knows it by (never a folder).
      id: ++serial
    }
    entry.tail = createRemoteTail(async (q) => {
      const r = await readWindow(q)
      if (r && r.ok) entry.seen = { size: r.size, mtimeMs: r.mtimeMs ?? null }
      return r
    }, bytes)
    return entry
  }

  // A file not found (or a host not answering before anything was read):
  // not looked for again before missingMs.
  function lost(key) {
    missing.set(key, now())
    if (missing.size > limits.entries * 4) missing.delete(missing.keys().next().value)
  }
  const lostLately = (key) => missing.has(key) && now() - missing.get(key) < limits.missingMs

  async function entryOf(p, homeOf) {
    if (p.hostId) {
      if (typeof readAgentFile !== 'function') return null
      const key = `${p.agent}|ssh:${p.hostId}|${p.sessionId}` // i18n-ignore
      if (entries.has(key)) return entries.get(key)
      if (lostLately(key)) return null
      return newEntry(
        key,
        p.agent,
        p.sessionId,
        p.hostId,
        remoteWindowReader(readAgentFile, { hostId: p.hostId, agent: p.agent, id: p.sessionId }),
        limits.remoteBytes
      )
    }
    let home = null
    if (ACCOUNT_AGENTS.includes(p.agent)) {
      home = await homeOf(p.agent, p.accountId)
      if (!home) return null
    }
    const key = `${p.agent}|${home || ''}|${p.sessionId}` // i18n-ignore
    const known = entries.get(key)
    if (known) return known
    if (lostLately(key)) return null
    let reported = null
    if (REPORTING_AGENTS.includes(p.agent)) {
      try {
        reported = reportedTranscript(sessionsDir(), p.paneId, p.agent, p.sessionId)
      } catch {
        reported = null
      }
    }
    let file = null
    try {
      file = findTranscriptViewFile(p.agent, p.sessionId, roots(), { home, reported })
    } catch {
      file = null
    }
    if (!file) {
      lost(key)
      return null
    }
    missing.delete(key)
    return newEntry(
      key,
      p.agent,
      p.sessionId,
      null,
      localWindowReader(file, fsp),
      limits.localBytes
    )
  }

  // The entry read again (what was added since), its lines decoded again
  // only when the file changed. -> the entry, or null when it cannot be read.
  async function refresh(entry) {
    // A host's file: at most once a minute.
    if (entry.hostId && entry.items && now() - entry.readAt < limits.remoteEveryMs) return entry
    let r
    try {
      r = await entry.tail.read()
    } catch {
      r = null
    }
    entry.readAt = now()
    if (r === null) {
      // A host that does not answer for a moment: what was read stays.
      if (entry.hostId && entry.items) return entry
      entries.delete(entry.key)
      lost(entry.key)
      return null
    }
    // Nothing new (or only a line still being written): as decoded before.
    if (r === false && entry.items) return entry
    // Its size and time when decoded: what the window's copy is known by.
    entry.stamp = entry.seen ? `${entry.seen.size}:${entry.seen.mtimeMs}` : ''
    entry.items = conversationItems(entry.agent, entry.tail.lines(), entry.sessionId, limits)
    return entry
  }

  // A pane's lines from `from` on: the newest, within the bounds.
  function windowOf(items, from) {
    const out = []
    let chars = 0
    for (let i = items.length - 1; i >= 0 && out.length < limits.items; i--) {
      const it = items[i]
      if (it.t < from) break
      chars += it.text.length
      if (chars > limits.chars) break
      out.push(it)
    }
    return out.reverse()
  }

  // q: { panes, from, known: { [paneId]: key } }
  // -> { ok: true, panes: { [paneId]: { key, items } | { key, same: true } } }
  async function readAll(q) {
    const o = obj(q) || {}
    const from = Number.isFinite(o.from) ? o.from : 0
    const known = obj(o.known) || {}
    const homesSeen = new Map()
    const homeOf = (agent, accountId) => {
      const k = `${agent}|${accountId === undefined ? '' : String(accountId)}` // i18n-ignore
      if (!homesSeen.has(k))
        homesSeen.set(
          k,
          Promise.resolve()
            .then(() => homes(agent, accountId))
            .catch(() => null)
        )
      return homesSeen.get(k)
    }
    const out = {}
    for (const p of panesOf(o.panes, limits.panes)) {
      let entry = null
      try {
        entry = await entryOf(p, homeOf)
        if (entry) entry = await refresh(entry)
      } catch (err) {
        entry = null
        if (log) log.warn('conversations', `terminal read failed: ${err && err.message}`) // i18n-ignore
      }
      if (entry && entry.items) {
        keep(entry)
        const key = `${entry.id}:${entry.stamp}:${from}` // i18n-ignore
        out[p.paneId] =
          known[p.paneId] === key
            ? { key, same: true }
            : { key, items: windowOf(entry.items, from) }
      }
      // The next pane after the window had its turn.
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { ok: true, panes: out }
  }
  // One read at a time: a second ask waits for the first.
  function read(q) {
    const run = queue.then(
      () => readAll(q),
      () => readAll(q)
    )
    queue = run.catch(() => {})
    return run
  }
  function register(ipcMain) {
    ipcMain.handle('conversations:terminal', (_e, q) => read(q).catch(() => ({ ok: false })))
  }
  return { read, register, size: () => entries.size, clear: () => entries.clear() }
}
