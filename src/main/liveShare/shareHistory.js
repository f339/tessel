// Live Share phase 2c: a shared project's past agent conversations (the
// Agent Session History panel) and what was said in its terminal agents
// (the Conversations tab), on a guest's screen, read only.
//
// Session history (sessions.list, sessions.details): the host's past
// conversations whose folder is the project's (providerAccountSessions.js
// list with that folder), each as a row a guest can show: its agent, its
// title and its times. Never its session id, its account, its folder or its
// file: a row is named by a ref (an HMAC of the project, the agent, the id
// and the account with a key of this share, never the same for another
// share), and the host keeps which conversation each ref of the last lists
// stands for. A row's details are its first prompt and latest turns (the
// harness's own turns left out, every text through shareChat.js's masking:
// what looks like a secret masked, paths outside the project hidden, cut to
// CHAT_LIMITS).
//
// Terminal conversations (sessions.terminal): what you and each terminal
// agent of the project said in its terminal (chat/terminalConversations.js,
// asked for the project's agent panes the host's window lists), each text
// masked the same way; the reader's key for "nothing changed" is given to
// guests as an HMAC too (it names the session), turned back here.
//
// Every text then has the share's hidden files it names as "…" (where:
// maskHidden, shareHiddenText.js: .git, .tessel, secrets and what git
// ignores, as the Files tab hides them), and every answer goes through
// assertNoHostPaths at the end (the project's folders, any drive, share or
// long path become "…").
import crypto from 'crypto'
import { CHAT_LIMITS, guestChatEvents, guestText, harnessUserText, stripHarnessBlocks } from './shareChat.js'
import { assertNoHostPaths } from './shareScope.js'

export const HISTORY_OPS = Object.freeze({
  'sessions.list': Object.freeze({ right: 'view', kind: 'heavy', bulk: true }),
  'sessions.details': Object.freeze({ right: 'view', kind: 'light', bulk: true }),
  'sessions.terminal': Object.freeze({ right: 'view', kind: 'light', bulk: true })
})

export const HISTORY_LIMITS = Object.freeze({
  rows: 200,
  title: 300,
  turns: 10,
  // Refs kept per project (the rows of its last lists).
  refs: 600,
  // A terminal conversation: its newest items, each text cut, and all the
  // project's conversations together at most this big.
  panes: 16,
  items: 100,
  itemText: 4000,
  bytes: 2 * 1024 * 1024,
  // Keys of terminal conversations kept to turn back.
  keys: 256
})
const L = HISTORY_LIMITS

const AGENT = /^[a-z][\w-]{0,39}$/
const REF = /^[A-Za-z0-9_-]{22}$/
const MODEL = /^[\w .:/()+-]{1,80}$/
const EFFORT = /^[\w-]{1,20}$/
const str = (v) => (typeof v === 'string' ? v : '')
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null)
// where.maskHidden(texts) -> Promise<texts>: hidden files' names out (none
// given: the texts as they are).
const masker = (where) => (where && typeof where.maskHidden === 'function' ? where.maskHidden : async (texts) => texts)

export const isRef = (v) => typeof v === 'string' && REF.test(v)

// A sessions.list request's arguments: how many rows (1..200).
export function listArgs(args) {
  const a = args && typeof args === 'object' ? args : {}
  const limit = Number.isInteger(a.limit) && a.limit >= 1 && a.limit <= L.rows ? a.limit : 60
  return { limit }
}

// A turn of a conversation's details, as a chat event (to share the chat's
// masking), and back.
function turnsAsEvents(turns) {
  return (Array.isArray(turns) ? turns : []).slice(-L.turns).map((x, i) => {
    const at = time(x && x.at)
    const text = str(x && x.text)
    return x && x.role === 'user' ? { type: 'user', id: `t${i}`, text, ...(at ? { at } : {}) } : { type: 'assistant', messageId: `t${i}`, text, ...(at ? { at } : {}) }
  })
}

// deps: listSessions(query) -> rows (providerAccountSessions.js list),
// sessionDetails(query) -> { ok, firstPrompt, turns, messageCount }
// (its details), readTerminal(query) -> { ok, panes } (chat/
// terminalConversations.js read). key: this share's HMAC key (tests).
export function createShareHistory({ listSessions, sessionDetails, readTerminal = null, key = crypto.randomBytes(32) } = {}) {
  // project -> Map(ref -> { agent, id, accountId }), the rows of its last lists.
  const refs = new Map()
  // guest key -> the reader's key, for a terminal conversation.
  const keys = new Map()
  const mac = (text) => crypto.createHmac('sha256', key).update(text).digest('base64url').slice(0, 22)

  function remember(project, ref, row) {
    let m = refs.get(project)
    if (!m) refs.set(project, (m = new Map()))
    m.delete(ref)
    m.set(ref, row)
    while (m.size > L.refs) m.delete(m.keys().next().value)
  }

  // The project's past conversations. root: its folder (host-only); roots:
  // its folders for the masking (cleanRoots shape), rawRoots: as paths for
  // assertNoHostPaths. -> { ok, data: { sessions, truncated } }
  async function list(project, args, where) {
    const { root, roots, rawRoots } = where
    if (!root || typeof listSessions !== 'function') return { ok: false, code: 'unavailable' }
    const { limit } = listArgs(args)
    let rows
    try {
      rows = await listSessions({ cwd: root, limit })
    } catch {
      return { ok: false, code: 'failed' }
    }
    const out = []
    for (const r of Array.isArray(rows) ? rows : []) {
      if (out.length >= L.rows) break
      if (!r || !AGENT.test(str(r.agent)) || typeof r.id !== 'string' || !r.id || r.id.length > 200) continue
      const accountId = typeof r.accountId === 'string' || r.accountId === null ? r.accountId : undefined
      const ref = mac(`${project}\n${r.agent}\n${r.id}\n${accountId === undefined ? '' : String(accountId)}`)
      if (out.some((x) => x.ref === ref)) continue
      remember(project, ref, { agent: r.agent, id: r.id, ...(accountId !== undefined ? { accountId } : {}) })
      out.push({
        ref,
        agent: r.agent,
        title: guestText(str(r.title), roots, L.title),
        started: time(r.started),
        updated: time(r.updated) || 0,
        ...(r.origin === 'ide' ? { origin: 'ide' } : {})
      })
    }
    const titles = await masker(where)(out.map((r) => r.title))
    out.forEach((r, i) => (r.title = titles[i]))
    const data = { sessions: out, truncated: Array.isArray(rows) && rows.length > out.length }
    return { ok: true, data: assertNoHostPaths(data, rawRoots).value }
  }

  // One conversation of the project's last lists: its first prompt (unless
  // it is the harness's own) and latest turns, masked. -> { ok, data }
  async function details(project, args, where) {
    const { roots, rawRoots } = where
    const ref = args && isRef(args.ref) ? args.ref : null
    const row = ref && refs.get(project) ? refs.get(project).get(ref) : null
    if (!row) return { ok: false, code: 'not-found' }
    if (typeof sessionDetails !== 'function') return { ok: false, code: 'unavailable' }
    let d
    try {
      d = await sessionDetails({ agent: row.agent, id: row.id, ...(row.accountId !== undefined ? { accountId: row.accountId } : {}) })
    } catch {
      d = null
    }
    if (!d || d.ok !== true) return { ok: false, code: 'not-found' }
    const first = str(d.firstPrompt)
    const firstPrompt = first && !harnessUserText(first) ? guestText(stripHarnessBlocks(first.slice(0, 64 * 1024)).trim(), roots, CHAT_LIMITS.user) : ''
    const { events } = guestChatEvents(turnsAsEvents(d.turns), roots)
    const masked = await masker(where)([firstPrompt, ...events.map((e) => e.text)])
    const turns = events.map((e, i) => ({ role: e.type === 'user' ? 'user' : 'assistant', text: masked[i + 1], at: time(e.at) }))
    const messageCount = Number.isSafeInteger(d.messageCount) && d.messageCount >= 0 ? d.messageCount : null
    return { ok: true, data: assertNoHostPaths({ firstPrompt: masked[0], turns, messageCount }, rawRoots).value }
  }

  // What was said in the project's terminal agents. panes: the project's
  // agent panes with a terminal (the host window's chats of it: id, agentId,
  // sessionId, accountId). args: { from, known: { paneId: key } }.
  // -> { ok, data: { panes: { paneId: { key, items } | { key, same: true } } } }
  async function terminal(project, args, where) {
    const { panes, roots, rawRoots } = where
    if (typeof readTerminal !== 'function') return { ok: false, code: 'unavailable' }
    const a = args && typeof args === 'object' ? args : {}
    const from = Number.isFinite(a.from) && a.from >= 0 ? a.from : 0
    const knownIn = a.known && typeof a.known === 'object' && !Array.isArray(a.known) ? a.known : {}
    const asks = (Array.isArray(panes) ? panes : []).filter((p) => p && p.terminal !== false && typeof p.sessionId === 'string').slice(0, L.panes)
    const known = {}
    for (const p of asks) {
      const k = typeof knownIn[p.id] === 'string' ? keys.get(knownIn[p.id]) : null
      if (k) known[p.id] = k
    }
    let res
    try {
      res = await readTerminal({
        from,
        known,
        panes: asks.map((p) => ({ ask: p.id, paneId: p.id, agent: p.agentId, sessionId: p.sessionId, ...(p.accountId !== undefined ? { accountId: p.accountId } : {}) }))
      })
    } catch {
      res = null
    }
    if (!res || res.ok !== true || !res.panes || typeof res.panes !== 'object') return { ok: false, code: 'failed' }
    const out = {}
    let bytes = 0
    for (const p of asks) {
      const r = res.panes[p.id]
      if (!r || typeof r.key !== 'string') continue
      const gk = mac(`terminal\n${project}\n${p.id}\n${r.key}`)
      keys.delete(gk)
      keys.set(gk, r.key)
      while (keys.size > L.keys) keys.delete(keys.keys().next().value)
      if (r.same === true) {
        out[p.id] = { key: gk, same: true }
        continue
      }
      const items = []
      const list = Array.isArray(r.items) ? r.items.slice(-L.items) : []
      for (const it of list) {
        if (!it || (it.role !== 'user' && it.role !== 'agent') || !Number.isFinite(it.t)) continue
        const text = guestText(str(it.text), roots, L.itemText)
        if (!text) continue
        const item = { role: it.role, t: it.t, text }
        if (typeof it.model === 'string' && MODEL.test(it.model)) item.model = it.model
        if (typeof it.effort === 'string' && EFFORT.test(it.effort)) item.effort = it.effort
        items.push(item)
      }
      // The newest kept while all of them fit.
      let size = 0
      let start = items.length
      while (start > 0) {
        const s = Buffer.byteLength(JSON.stringify(items[start - 1]), 'utf8') + 1
        if (bytes + size + s > L.bytes) break
        size += s
        start--
      }
      bytes += size
      out[p.id] = { key: gk, items: items.slice(start) }
    }
    // The hidden files they name, all of them at once.
    const all = Object.values(out).flatMap((e) => e.items || [])
    const texts = await masker(where)(all.map((it) => it.text))
    all.forEach((it, i) => (it.text = texts[i]))
    return { ok: true, data: assertNoHostPaths({ panes: out }, rawRoots).value }
  }

  return {
    list,
    details,
    terminal,
    // A project no longer shared, or sharing stopped: its refs go.
    forget(project) {
      if (project === undefined) {
        refs.clear()
        keys.clear()
      } else refs.delete(project)
    }
  }
}

// --- The guest's checks of the host's answers ---------------------------------------
const clip = (s, max) => {
  const text = str(s)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
// A list from the host -> rows the panel shows (id: the ref), or null.
export function checkSessionList(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) return null
  const out = []
  for (const r of data.sessions.slice(0, L.rows)) {
    if (!r || !isRef(r.ref) || !AGENT.test(str(r.agent)) || out.some((x) => x.id === r.ref)) continue
    out.push({ id: r.ref, agent: r.agent, title: clip(r.title, L.title), started: time(r.started), updated: time(r.updated) || 0, ...(r.origin === 'ide' ? { origin: 'ide' } : {}) })
  }
  return out
}
// One conversation's details from the host, or null.
export function checkSessionDetails(data) {
  if (!data || typeof data !== 'object') return null
  const turns = (Array.isArray(data.turns) ? data.turns : [])
    .slice(-L.turns)
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', text: clip(x.text, CHAT_LIMITS.assistant), at: time(x.at) }))
  return {
    ok: true,
    firstPrompt: clip(data.firstPrompt, CHAT_LIMITS.user),
    turns,
    messageCount: Number.isSafeInteger(data.messageCount) && data.messageCount >= 0 ? data.messageCount : null
  }
}
// The host's terminal conversations, checked; pane ids turned into this
// window's (localId(remoteId) -> id | null). -> { panes } | null
export function checkTerminal(data, localId) {
  if (!data || typeof data !== 'object' || !data.panes || typeof data.panes !== 'object' || Array.isArray(data.panes)) return null
  const out = {}
  let n = 0
  for (const [remote, r] of Object.entries(data.panes)) {
    if (n >= L.panes) break
    const id = /^[\w-]{1,80}$/.test(remote) ? localId(remote) : null
    if (!id || !r || typeof r.key !== 'string' || !REF.test(r.key)) continue
    n++
    if (r.same === true) {
      out[id] = { key: r.key, same: true }
      continue
    }
    const items = (Array.isArray(r.items) ? r.items.slice(-L.items) : [])
      .filter((it) => it && (it.role === 'user' || it.role === 'agent') && Number.isFinite(it.t) && typeof it.text === 'string')
      .map((it) => ({
        role: it.role,
        t: it.t,
        text: clip(it.text, L.itemText),
        ...(typeof it.model === 'string' && MODEL.test(it.model) ? { model: it.model } : {}),
        ...(typeof it.effort === 'string' && EFFORT.test(it.effort) ? { effort: it.effort } : {})
      }))
    out[id] = { key: r.key, items }
  }
  return { panes: out }
}
