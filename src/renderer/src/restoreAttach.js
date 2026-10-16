// Restoring the layout at startup: the terminals still running in the
// terminal host are re-attached a few at a time, the project you were in
// first, instead of one after another as each pane was rebuilt.
//
// Why: each pane waited for the one before it, so every slow answer of a busy
// main process added up: 25 terminals took over a minute on 2026-10-16 while
// the window showed only "Starting...". The host serializes one screen at a
// time anyway; a few requests in flight keep it busy while the main process
// and the window handle the previous answers.
//
// Order kept per pane: its output is seeded the moment its answer arrives
// (seed(id, buffer)), as createLeaf did right after its own attach, so the
// output that follows the snapshot is added after it, never before.

// The saved terminals of a layout tree, in tree order: wants(leafSnapshot)
// says whether that leaf re-attaches a terminal when it is restored.
export function terminalLeafIds(snap, wants, out = []) {
  if (!snap || typeof snap !== 'object') return out
  if (snap.type === 'leaf') {
    if (wants(snap)) out.push(snap.id)
    return out
  }
  for (const child of Array.isArray(snap.children) ? snap.children : []) terminalLeafIds(child, wants, out)
  return out
}

// ids: in the order to ask (duplicates asked once). attach(id) -> Promise of
// the host's answer; seed(id, buffer): the pane's output, at once. At most
// `limit` asked at a time.
// -> { get(id): Promise of the answer (null when it failed) | undefined,
//      stats(): { count, attached, ms, slowest, limit } }
export function prefetchAttaches(ids, { attach, seed, limit = 4, now = () => performance.now() } = {}) {
  const started = now()
  const answers = new Map()
  const queue = []
  let running = 0
  let lastAt = started
  let slowest = 0
  let attached = 0
  const next = () => {
    while (running < limit && queue.length) {
      const job = queue.shift()
      running++
      const asked = now()
      let asking
      try {
        asking = Promise.resolve(attach(job.id))
      } catch (err) {
        asking = Promise.reject(err)
      }
      asking
        .then(
          (a) => {
            // Right away: output after the snapshot then lands after it.
            if (a && a.ok) {
              attached++
              // When it came (a terminal with no process id: an end heard
              // after it is its end, ptyStore.js exitOf).
              a.answeredAt = now()
              try {
                if (seed) seed(job.id, a.buffer)
              } catch {
                /* the pane still comes back */
              }
            }
            return a || null
          },
          () => null
        )
        .then((a) => {
          const at = now()
          lastAt = Math.max(lastAt, at)
          slowest = Math.max(slowest, at - asked)
          running--
          job.resolve(a)
          next()
        })
    }
  }
  for (const id of ids) {
    if (typeof id !== 'string' || answers.has(id)) continue
    let resolve
    answers.set(id, new Promise((r) => (resolve = r)))
    queue.push({ id, resolve })
  }
  next()
  return {
    get: (id) => answers.get(id),
    stats: () => ({ count: answers.size, attached, ms: Math.round(lastAt - started), slowest: Math.round(slowest), limit })
  }
}
