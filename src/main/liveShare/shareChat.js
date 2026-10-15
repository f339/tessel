// Live Share: an agent pane's conversation for guests, read only.
//
// A guest can look at a host's agent pane as a chat on its own screen (its
// own view: the host's pane, its mode, its terminal and its agent never
// change). The host reads the pane's conversation file the way its own chat
// view does (src/main/chat/transcriptView.js gives the chat events) and sends
// the guests who asked for it a smaller copy, made here (guestChatPayload):
// only what the conversation says (your messages, the agent's answers, each
// tool it ran by name with a short label, how each turn ended). Never what
// the tools read or printed (file contents, command output), the agent's
// thinking, images or attached files. Paths outside the pane's project
// folders are hidden ("…"), paths inside are written from the project's
// folder, and what looks like a key, a token or a password is masked. Bounded:
// the latest CHAT_LIMITS.events events, each text cut, CHAT_LIMITS.bytes in
// all. The guest checks what comes again (cleanChatMessage): the same kinds,
// fields and limits.
//
// Both sides say what they speak beyond the protocol version in the sealed
// join and welcome (SHARE_FEATURES): an older Tessel sends none and ignores
// them, so a host and a guest of different versions still work together
// (only without the conversation).

export const SHARE_FEATURES = Object.freeze(['chat'])
export const cleanFeatures = (list) => (Array.isArray(list) ? [...new Set(list.filter((f) => typeof f === 'string' && SHARE_FEATURES.includes(f)))] : [])

export const CHAT_LIMITS = Object.freeze({
  events: 300,
  user: 8 * 1024,
  assistant: 16 * 1024,
  label: 300,
  name: 80,
  error: 1000,
  bytes: 512 * 1024
})
// What a host says when it has no conversation to send (yet).
export const CHAT_CODES = Object.freeze(['missing', 'busy', 'unavailable', 'error'])
// The tool input fields a guest gets (short labels: what it ran, on which
// file); never contents, patches, edits or prompts.
const TOOL_FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
const TOOL_STATUS = new Set(['running', 'done', 'completed', 'error', 'failed', 'stopped'])
const TURN_STATUS = new Set(['completed', 'interrupted', 'failed'])
const ID = /^[\w.:#@-]{1,160}$/
const MASK = '••••'
const HIDDEN = '…'

const str = (v) => (typeof v === 'string' ? v : '')
function clip(s, max) {
  const text = str(s)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
const idOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null)
const timeOf = (v) => (Number.isFinite(v) ? v : undefined)

// --- Secrets ------------------------------------------------------------------
/* eslint-disable no-control-regex */
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,200}@/gi, `$1${MASK}@`],
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-|or-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer|Basic|bearer)\s+(?=[A-Za-z0-9._~+/=-]{0,200}[0-9=])[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${MASK}`],
  // NAME=value, name: value, "name": "value" where the name says it is a
  // secret and the value looks like one (a digit in it, no spaces).
  [/\b([A-Za-z0-9_.-]{0,40}(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]{0,40})(["']?[ \t]{0,4}[:=][ \t]{0,4})(["']?)(?=[^\s"']{0,200}\d)[^\s"']{6,}\3/gi, `$1$2$3${MASK}$3`]
]
/* eslint-enable no-control-regex */
export function maskSecrets(text) {
  let out = str(text)
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}

// --- Paths --------------------------------------------------------------------
// A project folder, as compared: forward slashes, no trailing one; Windows
// paths (a drive, a share) without case.
function normalizedRoot(p) {
  const s = str(p).trim()
  if (!s || s.length > 1024 || /[\u0000-\u001f]/.test(s)) return null
  const win = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s)
  if (!win && !s.startsWith('/')) return null
  const unc = /^\\\\/.test(s)
  let n = s.replace(/[\\/]+/g, '/')
  if (unc) n = `/${n}`
  n = n.replace(/\/+$/, '')
  if (!n || n === '/' || /^[A-Za-z]:$/.test(n)) return null // a whole drive is no project
  return { path: win ? n.toLowerCase() : n, win }
}
export function cleanRoots(list) {
  const out = []
  for (const r of Array.isArray(list) ? list.slice(0, 8) : []) {
    const n = normalizedRoot(r)
    if (n && !out.some((x) => x.path === n.path)) out.push(n)
  }
  return out
}
// One path found in the text: from the project's folder when it is inside
// one, else hidden.
function rewritePath(raw, roots) {
  const unc = /^\\\\/.test(raw)
  let n = raw.replace(/[\\/]+/g, '/')
  if (unc) n = `/${n}`
  for (const root of roots) {
    const cmp = root.win ? n.toLowerCase() : n
    if (cmp === root.path || cmp === `${root.path}/`) return '.'
    if (cmp.startsWith(`${root.path}/`)) return n.slice(root.path.length + 1) || '.'
  }
  return HIDDEN
}
const TRAILING = /[.,;:!?)\]}'"`]+$/
const PATHS = [
  // file:// links
  /\bfile:\/\/\/?[^\s"'`<>)\]]+/gi,
  // C:\... or C:/...
  /(?<![\w\\/:.~-])[A-Za-z]:[\\/][^\s"'`<>|*?]*/g,
  // \\server\share\...
  /(?<![\w\\/])\\\\[^\s"'`<>|*?\\]+(?:\\[^\s"'`<>|*?\\]*)*/g,
  // ~/...
  /(?<![\w\\/~.-])~[\\/][^\s"'`<>|*?]*/g,
  // /two/segments... (one segment, like /compact, is a command, not a path)
  /(?<![\w\\/:.~-])\/(?:[^\s"'`<>|/\\]+\/)+[^\s"'`<>|/\\]*/g
]
export function hidePaths(text, roots) {
  let out = str(text)
  if (!roots) return out
  for (const re of PATHS) {
    out = out.replace(re, (match) => {
      const tail = (match.match(TRAILING) || [''])[0]
      let p = tail ? match.slice(0, -tail.length) : match
      if (!p) return match
      if (/^file:/i.test(p)) {
        p = p.replace(/^file:\/\/\/?/i, '')
        try {
          p = decodeURIComponent(p)
        } catch {
          /* kept as written */
        }
        if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) p = `/${p}`
      }
      if (p.startsWith('~')) return HIDDEN + tail
      return rewritePath(p, roots) + tail
    })
  }
  return out
}

// What a guest may read of a text: secrets masked, paths outside the project
// hidden (roots null: paths as they are, the guest's own check), cut.
// Cut first (a little past the end: a secret across the cut is still seen
// whole), so no pattern ever runs over more than that.
export function guestText(text, roots, max) {
  return clip(hidePaths(maskSecrets(clip(text, max + 256)), roots), max)
}

// --- Events -------------------------------------------------------------------
function toolInput(input, roots) {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const k of TOOL_FIELDS) {
    const v = value[k]
    const s = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : null
    if (s) out[k] = guestText(s, roots, CHAT_LIMITS.label)
  }
  return out
}

// One chat event as a guest may get it, or null (a kind a guest never gets).
function guestEvent(ev, roots) {
  if (!ev || typeof ev !== 'object') return null
  const at = timeOf(ev.at)
  const base = (o) => ({ ...o, imported: true, ...(at !== undefined ? { at } : {}) })
  switch (ev.type) {
    case 'user': {
      const id = idOf(ev.id)
      if (!id) return null
      const origin = ev.origin === 'team' ? 'team' : 'user'
      return base({ type: 'user', id, text: guestText(ev.text, roots, CHAT_LIMITS.user), origin, status: 'accepted', ...(origin === 'team' && typeof ev.from === 'string' ? { from: clip(ev.from, 40) } : {}) })
    }
    case 'assistant': {
      const messageId = idOf(ev.messageId)
      return messageId ? base({ type: 'assistant', messageId, text: guestText(ev.text, roots, CHAT_LIMITS.assistant) }) : null
    }
    case 'tool': {
      const id = idOf(ev.id)
      if (!id) return null
      const status = TOOL_STATUS.has(ev.status) ? ev.status : undefined
      // A status-only update (no name): the call it closes stays as it was.
      if (ev.name == null) return base({ type: 'tool', id, ...(status ? { status } : {}) })
      return base({ type: 'tool', id, name: clip(ev.name, CHAT_LIMITS.name), summary: guestText(ev.summary, roots, CHAT_LIMITS.label), input: toolInput(ev.input, roots), ...(status ? { status } : {}) })
    }
    case 'toolResult': {
      const id = idOf(ev.id)
      // What it read or printed stays on the host: done or failed only.
      return id ? base({ type: 'toolResult', id, isError: ev.isError === true, text: '' }) : null
    }
    case 'turnEnd': {
      const status = TURN_STATUS.has(ev.status) ? ev.status : 'completed'
      const durationMs = Number.isFinite(ev.durationMs) && ev.durationMs >= 0 ? Math.round(ev.durationMs) : undefined
      const error = typeof ev.error === 'string' && ev.error ? guestText(ev.error, roots, CHAT_LIMITS.error) : ''
      return base({ type: 'turnEnd', status, ...(durationMs !== undefined ? { durationMs } : {}), ...(error ? { error } : {}) })
    }
    default:
      return null
  }
}

// The events a guest gets: the latest ones that fit CHAT_LIMITS (count and
// bytes). roots: the project folders (cleanRoots) for the host's copy, null
// for the guest's check. -> { events, truncated }
export function guestChatEvents(events, roots = null, limits = CHAT_LIMITS) {
  const list = Array.isArray(events) ? events : []
  const out = []
  let bytes = 2
  let truncated = false
  // From the newest: what fits is kept, the rest (the oldest) left out.
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = guestEvent(list[i], roots)
    if (!ev) continue
    const size = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1
    if (out.length >= limits.events || bytes + size > limits.bytes) {
      truncated = true
      break
    }
    bytes += size
    out.push(ev)
  }
  return { events: out.reverse(), truncated }
}

// What the host sends a guest for a conversation: { ok: true, events,
// truncated } (read from the file: transcriptView's answer) or { ok: false,
// code }.
export function guestChatPayload(read, roots) {
  if (!read || read.ok !== true) return { ok: false, code: CHAT_CODES.includes(read && read.code) ? read.code : 'missing' }
  const { events, truncated } = guestChatEvents(read.events, cleanRoots(roots))
  return { ok: true, events, truncated: truncated || !!read.truncated }
}

// The guest's check of what came: the same kinds, fields and limits.
export function cleanChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.ok !== true) return { ok: false, code: CHAT_CODES.includes(msg.code) ? msg.code : 'error' }
  const { events, truncated } = guestChatEvents(msg.events, null)
  return { ok: true, events, truncated: truncated || !!msg.truncated }
}

// The host's agent panes a guest can look at as a chat, as the guest gets
// them: { id, title, agentId, accent, terminal } (terminal: the host's pane
// has one; a pane in chat mode has none).
export function cleanChatPanes(list, max = 64) {
  const out = []
  for (const c of Array.isArray(list) ? list.slice(0, max) : []) {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || out.some((x) => x.id === c.id)) continue
    out.push({
      id: c.id,
      title: clip(c.title, 200),
      agentId: typeof c.agentId === 'string' && /^[\w-]{1,40}$/.test(c.agentId) ? c.agentId : null,
      accent: /^#[0-9a-f]{3,8}$/i.test(c.accent || '') ? c.accent : null,
      terminal: c.terminal !== false
    })
  }
  return out
}
