// The counting process of Settings > Context (worker.js), from the main
// process: started on the first count, stopped after IDLE_MS without one (a
// loaded tokenizer holds tens of MB). A request it cannot answer (did not
// start, crashed, no answer in time) resolves null: the caller then shows an
// estimate rather than nothing. One that hangs is killed at its timeout, and
// the next start waits a backoff (doubling up to MAX_BACKOFF_MS, back to
// nothing after an answer), so a tokenizer that loops never runs on.
const IDLE_MS = 2 * 60 * 1000
const REPLY_MS = 60 * 1000
const BACKOFF_MS = 5 * 1000
const MAX_BACKOFF_MS = 5 * 60 * 1000

export function createCountWorker({ fork, timers = globalThis, idleMs = IDLE_MS, replyMs = REPLY_MS, backoffMs = BACKOFF_MS, clock = Date.now, log = null }) {
  let child = null
  let nextId = 0
  let idleTimer = null
  let closed = false
  let backoff = 0 // the next wait after a hang
  let notBefore = 0 // no start before this time
  const waiting = new Map() // id -> { resolve, timer }

  function settle(id, reply) {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    timers.clearTimeout(w.timer)
    if (reply) backoff = 0
    w.resolve(reply && !reply.error ? reply : null)
    armIdle()
  }
  // No answer in time: the process is stuck (a tokenizer looping, a huge
  // file); killed, and not started again before the backoff.
  function timedOut(id) {
    if (!waiting.has(id)) return
    backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : backoffMs
    notBefore = clock() + backoff
    log?.warn?.('context', `the token counting process did not answer; stopped, next start in ${Math.round(backoff / 1000)} s`) // i18n-ignore
    stop()
  }
  function armIdle() {
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    if (!child || waiting.size) return
    idleTimer = timers.setTimeout(() => {
      idleTimer = null
      if (child && !waiting.size) stop()
    }, idleMs)
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  function ensureChild() {
    if (child || closed || typeof fork !== 'function') return child
    if (clock() < notBefore) return null
    try {
      const c = fork()
      c.on('message', (msg) => {
        if (msg && waiting.has(msg.id)) settle(msg.id, msg)
      })
      c.on('exit', () => {
        if (child !== c) return
        child = null
        for (const id of [...waiting.keys()]) settle(id, null)
      })
      child = c
    } catch (err) {
      child = null
      log?.warn?.('context', `the token counting process did not start: ${err && err.message}`) // i18n-ignore
    }
    return child
  }
  function stop() {
    const c = child
    child = null
    if (c) {
      try {
        c.kill()
      } catch {
        /* already gone */
      }
    }
    for (const id of [...waiting.keys()]) settle(id, null)
  }
  function request(msg) {
    const c = ensureChild()
    if (!c) return Promise.resolve(null)
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    return new Promise((resolve) => {
      const id = ++nextId
      const timer = timers.setTimeout(() => timedOut(id), replyMs)
      waiting.set(id, { resolve, timer })
      try {
        c.postMessage({ ...msg, id })
      } catch {
        settle(id, null)
      }
    })
  }
  return {
    request,
    close() {
      closed = true
      stop()
    }
  }
}
