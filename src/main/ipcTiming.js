// How long each IPC handler holds the main process (its synchronous part, up
// to its first await). While one runs, nothing else is answered: the
// terminals' re-attaches and output wait too.
//
// Why: on 2026-10-16 the main process was "blocked for 6988 ms" right after a
// start and nothing said by what. A handler that holds it long is now named
// in the log (at most once a minute per channel), the loop-lag report names
// the slowest one of the last seconds, and the startup line sums them up.
//
// measure(channel, ms) is called by ipcGuard.js after each handler.
export function createIpcTiming({ log = null, now = Date.now, slowMs = 500, quietMs = 60000, recentMs = 15000 } = {}) {
  const totals = new Map() // channel -> { count, ms, max }
  const lastLogged = new Map() // channel -> time
  let recent = [] // [{ at, channel, ms }], the slow-ish ones of the last recentMs

  function measure(channel, ms) {
    if (typeof channel !== 'string' || !Number.isFinite(ms) || ms < 0) return
    let t = totals.get(channel)
    if (!t) {
      // A bounded table: a page sending made-up channel names cannot grow it.
      if (totals.size >= 2000) return
      t = { count: 0, ms: 0, max: 0 }
      totals.set(channel, t)
    }
    t.count++
    t.ms += ms
    if (ms > t.max) t.max = ms
    if (ms < 50) return
    const at = now()
    recent.push({ at, channel, ms })
    if (recent.length > 200) recent = recent.slice(-100)
    if (ms >= slowMs && log && (!lastLogged.has(channel) || at - lastLogged.get(channel) >= quietMs)) {
      lastLogged.set(channel, at)
      try {
        log(`IPC ${channel} held the main process for ${Math.round(ms)} ms`)
      } catch {
        /* logging never breaks IPC */
      }
    }
  }

  // The handler that held it longest in the last recentMs, as text ('' when
  // none held it 50 ms or more).
  function slowestRecent() {
    const since = now() - recentMs
    recent = recent.filter((r) => r.at >= since)
    let worst = null
    for (const r of recent) if (!worst || r.ms > worst.ms) worst = r
    return worst ? `slowest IPC lately: ${worst.channel} ${Math.round(worst.ms)} ms` : ''
  }

  // The `n` channels that held it longest in all, as text:
  // "agents:model 27x 410 ms (max 120 ms), ...".
  function busiest(n = 5) {
    return [...totals.entries()]
      .filter(([, t]) => t.ms >= 1)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, n)
      .map(([channel, t]) => `${channel} ${t.count}x ${Math.round(t.ms)} ms (max ${Math.round(t.max)} ms)`)
      .join(', ')
  }

  return { measure, slowestRecent, busiest }
}
