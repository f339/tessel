// Work nobody waits for while Tessel starts: a hidden pane's model, an agent's
// model list asked again, the sub-agents of each conversation, the voice
// languages. While the window restores its layout (App.vue: startupBegins,
// then startupFinished), it is held, then run one job at a time, a moment
// apart. Outside a start (a pane opened later), afterStartup(fn) runs fn at
// once.
//
// Why: each of these is a file read or a program started by the main process,
// and each pane asked for all of them the moment it was rebuilt. The main
// process then answered the terminals' re-attaches late, and the window stayed
// on "Starting..." (2026-10-16).

let starting = false
const waiting = []
let timer = null
let gapMs = 40

function drain() {
  timer = null
  const fn = waiting.shift()
  if (!fn) return
  try {
    fn()
  } catch {
    /* one job's failure never stops the others */
  }
  if (waiting.length) timer = setTimeout(drain, gapMs)
}

export function afterStartup(fn) {
  if (typeof fn !== 'function') return
  if (!starting) {
    fn()
    return
  }
  waiting.push(fn)
}

// The window starts restoring its layout.
export function startupBegins() {
  starting = true
}

// The layout is restored and the window shows it: what waited runs now, one
// job every `gap` ms.
export function startupFinished({ gap = 40 } = {}) {
  if (!starting) return
  starting = false
  gapMs = gap
  if (waiting.length && !timer) timer = setTimeout(drain, 0)
}

export function isStartupFinished() {
  return !starting
}

// Tests.
export function resetStartupIdleForTests() {
  starting = false
  waiting.length = 0
  if (timer) clearTimeout(timer)
  timer = null
  gapMs = 40
}
