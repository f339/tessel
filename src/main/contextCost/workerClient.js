// The counting process of Settings > Context (worker.js), from the main
// process: started on the first count, stopped after IDLE_MS without one (a
// loaded tokenizer holds tens of MB). A request it cannot answer (did not
// start, crashed, no answer in time) resolves null: the caller then shows an
// estimate rather than nothing.
const IDLE_MS = 2 * 60 * 1000
const REPLY_MS = 60 * 1000

export function createCountWorker({ fork, timers = globalThis, idleMs = IDLE_MS, replyMs = REPLY_MS, log = null }) {
  let child = null
  let nextId = 0
  let idleTimer = null
  let closed = false
  const waiting = new Map() // id -> { resolve, timer }

  function settle(id, reply) {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    timers.clearTimeout(w.timer)
    w.resolve(reply && !reply.error ? reply : null)
    armIdle()
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
      const timer = timers.setTimeout(() => settle(id, null), replyMs)
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
