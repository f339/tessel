// Event-loop stalls of this process, written to the log: a timer that should
// tick every second; when it runs late, the process (or the whole PC) was
// stuck for that long.
//
// Why: on 2026-10-12 the terminal host stopped reading the terminals for 11
// minutes and every agent hung, but nothing in the logs said whether the host
// or the PC was stuck. The terminal host (ptyHost.js) and the main process
// both run one: stalls in both at once point at the PC, in one alone at it.
//
// log(message): called with each report. extra(): more to say (terminals...).
// The first stall is reported at once, the next ones at most once every
// quietMs (how many and the longest), so a long freeze does not flood the log.
export function watchLoopLag({ log, extra, everyMs = 1000, warnMs = 2000, quietMs = 10000, now = Date.now } = {}) {
  let last = now()
  let lastReport = -Infinity
  let held = 0 // stalls not reported yet
  let worst = 0

  const mb = (n) => Math.round(n / 1048576)
  const memory = () => {
    try {
      const m = process.memoryUsage()
      return `rss ${mb(m.rss)} MB, heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB`
    } catch {
      return 'memory unknown'
    }
  }
  const more = () => {
    if (!extra) return ''
    try {
      const text = extra()
      return text ? `, ${text}` : ''
    } catch {
      return ''
    }
  }
  const report = (text) => {
    try {
      log(text)
    } catch {
      /* never breaks the process it watches */
    }
  }

  const timer = setInterval(() => {
    const t = now()
    const lag = t - last - everyMs
    last = t
    if (lag >= warnMs) {
      if (t - lastReport >= quietMs) {
        const before = held ? `; ${held} more since the last report, longest ${worst} ms` : ''
        held = 0
        worst = 0
        lastReport = t
        report(`event loop blocked for ${lag} ms (${memory()}${more()})${before}`)
      } else {
        held++
        worst = Math.max(worst, lag)
      }
      return
    }
    // Back to normal: the stalls held back are reported once the quiet time is over.
    if (held && t - lastReport >= quietMs) {
      report(`event loop: ${held} more stall(s) after the last report, longest ${worst} ms (${memory()}${more()})`)
      held = 0
      worst = 0
      lastReport = t
    }
  }, everyMs)
  if (timer.unref) timer.unref()
  return () => clearInterval(timer)
}
