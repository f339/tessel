// Live Share phase 2: a shared project's task board on a guest's screen.
//
// The host's window sends the board of each project it shares (its cards,
// liveShare:tasks); the host's main process makes the guests' copy here
// (guestTasks: the fields the board shows, cut to the limits, every text
// through guestText: what looks like a secret masked, paths outside the
// project hidden; a card's copy of the project reduced to its branch) and
// pushes it on the 'tasks' topic (shareChannel.js). A guest's Tessel checks
// that copy again (checkTasks) before its board shows it.
//
// A guest with the 'tasks' right changes the board with requests (TASK_OPS):
// add a card, move one, rename one in To do, delete one, answer the question
// an agent asked on one. The host's main process checks the arguments
// (taskArgs) and that the card is on that project's board, then asks its
// window, which checks again (the guest still in, with the right, seeing
// the project) and changes its board.
import { guestText } from './shareChat.js'

export const COLUMNS = Object.freeze(['todo', 'doing', 'review', 'done'])
export const TASK_LIMITS = Object.freeze({
  cards: 500,
  title: 300,
  text: 4096, // a brief, a report's summary, a question or its answer
  options: 8, // a question's choices
  option: 200,
  files: 50, // a report's files
  file: 400,
  deps: 32,
  branch: 200,
  note: 1000
})
const L = TASK_LIMITS

// The requests a guest's board makes: what they need and cost (shareHost.js
// opInfo).
export const TASK_OPS = Object.freeze({
  'tasks.add': Object.freeze({ right: 'tasks', kind: 'write', bulk: false }),
  'tasks.move': Object.freeze({ right: 'tasks', kind: 'write', bulk: false }),
  'tasks.edit': Object.freeze({ right: 'tasks', kind: 'write', bulk: false }),
  'tasks.remove': Object.freeze({ right: 'tasks', kind: 'write', bulk: false }),
  'tasks.answer': Object.freeze({ right: 'tasks', kind: 'write', bulk: false })
})

export const isTaskId = (id) => typeof id === 'string' && /^[\w.-]{1,100}$/.test(id)
const isPaneId = (id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)
const str = (v) => (typeof v === 'string' ? v : '')
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null)
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const oneLine = (v, max) => str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

// A request's arguments, as the op takes them, or null.
export function taskArgs(op, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  switch (op) {
    case 'tasks.add': {
      const title = oneLine(a.title, L.title)
      return title ? { title } : null
    }
    case 'tasks.move':
      return isTaskId(a.id) && COLUMNS.includes(a.column) ? { id: a.id, column: a.column } : null
    case 'tasks.edit': {
      const title = oneLine(a.title, L.title)
      return isTaskId(a.id) && title ? { id: a.id, title } : null
    }
    case 'tasks.remove':
      return isTaskId(a.id) ? { id: a.id } : null
    case 'tasks.answer': {
      const answer = oneLine(a.answer, L.text)
      return isTaskId(a.id) && answer ? { id: a.id, answer } : null
    }
    default:
      return null
  }
}

// --- The host's side ---------------------------------------------------------
// One card as guests get it (roots: the project's folders, for guestText).
function guestCard(t, roots) {
  const text = (v, max) => guestText(str(v), roots, max)
  const card = {
    id: t.id,
    title: text(t.title, L.title),
    column: t.column,
    paneId: isPaneId(t.paneId) ? t.paneId : null,
    createdAt: time(t.createdAt),
    columnSince: time(t.columnSince),
    startedAt: time(t.startedAt),
    doingSince: time(t.doingSince),
    doneAt: time(t.doneAt)
  }
  if (Array.isArray(t.deps)) card.deps = t.deps.filter(isTaskId).slice(0, L.deps)
  if (t.brief) card.brief = text(t.brief, L.text)
  if (t.worktree && typeof t.worktree === 'object' && t.worktree.branch) card.worktree = { branch: oneLine(text(t.worktree.branch, L.branch), L.branch) }
  if (t.gate && typeof t.gate === 'object' && (t.gate.status === 'pending' || t.gate.status === 'resolved')) {
    card.gate = {
      status: t.gate.status,
      question: text(t.gate.question, L.text),
      options: (Array.isArray(t.gate.options) ? t.gate.options : []).slice(0, L.options).map((o) => text(o, L.option)).filter(Boolean),
      ...(t.gate.status === 'resolved' ? { answer: text(t.gate.answer, L.text) } : {})
    }
  }
  if (t.report && typeof t.report === 'object') {
    card.report = {
      outcome: t.report.outcome === 'succeeded' ? 'succeeded' : 'failed',
      summary: text(t.report.summary, L.text),
      files: (Array.isArray(t.report.files) ? t.report.files : []).slice(0, L.files).map((f) => text(f, L.file)).filter(Boolean)
    }
  }
  if (t.leadReview === 'approved' || t.leadReview === 'reviewing') {
    card.leadReview = t.leadReview
    if (t.leadNote) card.leadNote = text(t.leadNote, L.note)
  }
  return card
}

// The window's cards of one project -> the guests' copy: cards with a valid
// id and column, the newest 500 at most.
export function guestTasks(list, roots = []) {
  const out = []
  const seen = new Set()
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== 'object' || !isTaskId(t.id) || seen.has(t.id) || !COLUMNS.includes(t.column)) continue
    seen.add(t.id)
    out.push(guestCard(t, roots))
  }
  return out.slice(-L.cards)
}

// --- The guest's side --------------------------------------------------------
// The host's copy, checked: the known fields, their shapes and limits; a card
// that does not fit is left out. null when it is not a list of cards.
export function checkTasks(list) {
  if (!Array.isArray(list) || list.length > L.cards) return null
  const out = []
  const seen = new Set()
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  for (const t of list) {
    if (!t || typeof t !== 'object' || !isTaskId(t.id) || seen.has(t.id) || !COLUMNS.includes(t.column)) continue
    seen.add(t.id)
    const card = {
      id: t.id,
      title: text(t.title, L.title),
      column: t.column,
      paneId: isPaneId(t.paneId) ? t.paneId : null,
      createdAt: time(t.createdAt),
      columnSince: time(t.columnSince),
      startedAt: time(t.startedAt),
      doingSince: time(t.doingSince),
      doneAt: time(t.doneAt)
    }
    if (Array.isArray(t.deps)) card.deps = t.deps.filter(isTaskId).slice(0, L.deps)
    if (typeof t.brief === 'string' && t.brief) card.brief = text(t.brief, L.text)
    if (t.worktree && typeof t.worktree === 'object' && typeof t.worktree.branch === 'string' && t.worktree.branch) card.worktree = { branch: oneLine(t.worktree.branch, L.branch) }
    if (t.gate && typeof t.gate === 'object' && (t.gate.status === 'pending' || t.gate.status === 'resolved')) {
      card.gate = {
        status: t.gate.status,
        question: text(t.gate.question, L.text),
        options: (Array.isArray(t.gate.options) ? t.gate.options : []).filter((o) => typeof o === 'string' && o).slice(0, L.options).map((o) => o.slice(0, L.option)),
        ...(t.gate.status === 'resolved' ? { answer: text(t.gate.answer, L.text) } : {})
      }
    }
    if (t.report && typeof t.report === 'object') {
      card.report = {
        outcome: t.report.outcome === 'succeeded' ? 'succeeded' : 'failed',
        summary: text(t.report.summary, L.text),
        files: (Array.isArray(t.report.files) ? t.report.files : []).filter((f) => typeof f === 'string' && f).slice(0, L.files).map((f) => f.slice(0, L.file))
      }
    }
    if (t.leadReview === 'approved' || t.leadReview === 'reviewing') {
      card.leadReview = t.leadReview
      if (typeof t.leadNote === 'string' && t.leadNote) card.leadNote = text(t.leadNote, L.note)
    }
    out.push(card)
  }
  return out
}
