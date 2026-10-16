// Live Share phase 2c: a shared project's activity (what its agents and
// teams did and said: the Conversations tab's threads and the Activity
// panel, src/shared/activity.js's events) on a guest's screen, read only.
//
// The host's window sends the activity log's events of each shared project
// that guests follow (liveShare:activity: the project's own, its panes' and
// its teams'), with its teams' names; the host's main process makes the
// guests' copy here (guestActivity): the newest ACTIVITY_LIMITS.events
// events, each one only the fields the views read (kinds, times, pane and
// team ids, who said what to whom), every text through guestText (what looks
// like a secret masked, paths outside the project hidden, cut). Never a
// session id, an account, a host's address or folder, a worktree's path.
// Pushed on the 'activity' topic (shareChannel.js) when it changed. A
// guest's Tessel checks the copy again (checkActivity: the same fields, cut)
// and gives pane ids its own names.
import { guestText } from './shareChat.js'

export const ACTIVITY_LIMITS = Object.freeze({
  events: 500,
  teams: 32,
  text: 4096,
  label: 300,
  name: 120,
  model: 80
})
const L = ACTIVITY_LIMITS

const WORD = /^[\w.:-]{1,40}$/
const ID = /^[\w.-]{1,100}$/
const PANE = /^[\w-]{1,80}$/
const AGENT_ID = /^[\w.-]{1,40}$/
const COLOR = /^#[0-9a-f]{3,8}$/i
// Kinds, states and the like: short words.
const WORDS = ['type', 'action', 'status', 'source', 'scope', 'state', 'outcome', 'kind']
const PANES = ['paneId', 'fromPaneId', 'toPaneId']
const IDS = ['teamId', 'taskId']
// Texts and their caps.
const TEXTS = { preview: L.text, text: L.text, detail: L.text, title: L.label, name: L.label, taskTitle: L.label, from: L.name, to: L.name, by: L.name, branch: 200 }
const SENDER_TEXTS = { name: L.name, agentName: L.model, model: L.model, modelId: L.model, effort: 20, branch: 200, cardTitle: L.label }

const str = (v) => (typeof v === 'string' ? v : '')
function clip(s, max) {
  const text = str(s)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// One event as a guest gets it (text: how a text is made, masked on the
// host, only cut on the guest), or null.
function cleanEvent(e, text, project) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.t) || typeof e.type !== 'string' || !WORD.test(e.type)) return null
  const out = { t: e.t }
  for (const k of WORDS) if (typeof e[k] === 'string' && WORD.test(e[k])) out[k] = e[k]
  for (const k of PANES) if (typeof e[k] === 'string' && PANE.test(e[k])) out[k] = e[k]
  for (const k of IDS) if (typeof e[k] === 'string' && ID.test(e[k])) out[k] = e[k]
  if (typeof e.fromAgentId === 'string' && AGENT_ID.test(e.fromAgentId)) out.fromAgentId = e.fromAgentId
  for (const [k, max] of Object.entries(TEXTS)) {
    if (typeof e[k] !== 'string' || !e[k]) continue
    const s = text(e[k], max)
    if (s) out[k] = s
  }
  if (Number.isFinite(e.since)) out.since = e.since
  if (Number.isFinite(e.reset)) out.reset = e.reset
  else if (typeof e.reset === 'string' && e.reset) out.reset = text(e.reset, 100)
  if (e.agent && typeof e.agent === 'object') {
    const agent = {}
    if (typeof e.agent.title === 'string') agent.title = text(e.agent.title, L.label)
    if (typeof e.agent.agentId === 'string' && AGENT_ID.test(e.agent.agentId)) agent.agentId = e.agent.agentId
    out.agent = agent
  }
  if (e.sender && typeof e.sender === 'object') {
    const s = e.sender
    const sender = {}
    for (const [k, max] of Object.entries(SENDER_TEXTS)) if (typeof s[k] === 'string' && s[k]) sender[k] = text(s[k], max)
    if (typeof s.agentId === 'string' && AGENT_ID.test(s.agentId)) sender.agentId = s.agentId
    if (typeof s.paneId === 'string' && PANE.test(s.paneId)) sender.paneId = s.paneId
    if (typeof s.teamId === 'string' && ID.test(s.teamId)) sender.teamId = s.teamId
    if (Number.isSafeInteger(s.num) && s.num > 0 && s.num < 10000) sender.num = s.num
    if (s.lead === true) sender.lead = true
    if (Number.isFinite(s.at)) sender.at = s.at
    out.sender = sender
  }
  // The project it is in, as the guest knows it.
  out.wsId = project
  return out
}

function cleanTeams(list, text) {
  const out = []
  for (const team of Array.isArray(list) ? list.slice(0, L.teams * 2) : []) {
    if (out.length >= L.teams) break
    if (!team || typeof team.id !== 'string' || !ID.test(team.id) || out.some((x) => x.id === team.id)) continue
    out.push({ id: team.id, name: text(str(team.name), L.name), color: COLOR.test(str(team.color)) ? team.color : null })
  }
  return out
}

function newest(events, make) {
  const out = []
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0 && out.length < L.events; i--) {
    const ev = make(list[i])
    if (ev) out.push(ev)
  }
  return out.reverse()
}

// The host's copy for guests: the project's newest events and its teams,
// masked. roots: the project's folders (shareChat.js cleanRoots).
export function guestActivity(events, teams, project, roots) {
  const text = (s, max) => guestText(s, roots || [], max)
  return { events: newest(events, (e) => cleanEvent(e, text, project)), teams: cleanTeams(teams, text) }
}

// Every text of the guests' copy (its slots), given to fn and replaced by
// what it gives back: the hidden files they name are taken out this way
// (shareHiddenText.js). -> the texts, in order, when fn only reads.
export function mapActivityTexts(data, fn) {
  const texts = []
  const at = (obj, k) => {
    if (!obj || typeof obj[k] !== 'string' || !obj[k]) return
    texts.push(obj[k])
    obj[k] = fn(obj[k], texts.length - 1)
  }
  for (const e of (data && data.events) || []) {
    for (const k of Object.keys(TEXTS)) at(e, k)
    at(e, 'reset')
    at(e.agent, 'title')
    if (e.sender) for (const k of ['name', 'agentName', 'branch', 'cardTitle']) at(e.sender, k)
  }
  for (const team of (data && data.teams) || []) at(team, 'name')
  return texts
}

// The guest's check of the host's copy: the same fields, cut; pane ids
// turned into this window's (paneId(remote) -> id) and the project into its
// Live Share project (wsId). -> { events, teams } | null
export function checkActivity(data, { paneId = (id) => id, wsId = null } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null
  const events = newest(data.events, (e) => {
    const ev = cleanEvent(e, clip, wsId)
    if (!ev) return null
    for (const k of PANES) if (ev[k]) ev[k] = paneId(ev[k])
    if (ev.sender && ev.sender.paneId) ev.sender.paneId = paneId(ev.sender.paneId)
    return ev
  })
  return { events, teams: cleanTeams(data.teams, clip) }
}
