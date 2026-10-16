// How many terminals of the window draw with WebGL (TerminalPane.vue).
// Chromium keeps 16 WebGL contexts per window: past that it drops the oldest
// one, and that terminal's canvas turns into a white box with a small broken
// image in its corner until xterm gives up waiting for it (3 s) and draws
// without WebGL again. Every pane of every project took a context as it
// opened, so Tessel's start (some 25 agent terminals restored at once) lost
// every context past the 16th, often those of the project on screen: the
// white "crashed" panes seen each time Tessel opened (2026-10-16).
//
// So a terminal draws with WebGL only while it is on screen, and holds one of
// at most MAX_WEBGL places:
// - claimWebgl(owner) -> true: a place is its own. Full: the holder shown
//   least recently that is out of sight gives its place back at once
//   (owner.release()); every holder on screen: false, the terminal keeps the
//   normal renderer and is told (owner.retry()) once a place frees while it
//   is still on screen.
// - releaseWebgl(owner): its place given back (or its wait ended).
// - noteWebglShown(owner): shown again (the order places are taken back in).
// owner: { onScreen() -> bool, release(), retry() }.

// Under Chromium's 16: room for contexts let go a moment ago (Windows'
// ANGLE can keep one a while) and the GPU check's (terminalOptions.js).
export const MAX_WEBGL = 12

const holders = new Map() // owner -> when last shown
const waiting = new Set()
let clock = 0
let retryQueued = false

export function claimWebgl(owner) {
  if (holders.has(owner)) {
    holders.set(owner, ++clock)
    return true
  }
  if (holders.size >= MAX_WEBGL) {
    let out = null
    let oldest = Infinity
    for (const [o, at] of holders) {
      if (at < oldest && !safeOnScreen(o)) {
        out = o
        oldest = at
      }
    }
    if (!out) {
      waiting.add(owner)
      return false
    }
    holders.delete(out)
    safeCall(out, 'release')
  }
  waiting.delete(owner)
  holders.set(owner, ++clock)
  return true
}

export function releaseWebgl(owner) {
  waiting.delete(owner)
  if (!holders.delete(owner)) return
  if (!waiting.size || retryQueued) return
  // Told after the current change is done (a release can come from inside
  // another pane's claim).
  retryQueued = true
  queueMicrotask(() => {
    retryQueued = false
    for (const o of [...waiting]) {
      if (holders.size >= MAX_WEBGL) break
      waiting.delete(o)
      if (safeOnScreen(o)) safeCall(o, 'retry')
    }
  })
}

export function noteWebglShown(owner) {
  if (holders.has(owner)) holders.set(owner, ++clock)
}

function safeOnScreen(owner) {
  try {
    return !!owner.onScreen()
  } catch {
    return false
  }
}
function safeCall(owner, name) {
  try {
    if (typeof owner[name] === 'function') owner[name]()
  } catch {
    // A pane gone meanwhile: nothing to do.
  }
}

// Tests.
export function _webglHoldersForTests() {
  return { holders: holders.size, waiting: waiting.size }
}
export function _resetWebglForTests() {
  holders.clear()
  waiting.clear()
  clock = 0
  retryQueued = false
}
