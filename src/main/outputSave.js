// The terminal host's "dump": each terminal's recent screen and history,
// which the app saves every 30 s and when it quits (index.js saveScrollback).
//
// It runs on the host's only thread, the one that also reads the terminals.
// It used to serialize every terminal's full history (5000 rows): about a
// second and a 9-15 MB reply for 18 terminals, of which the app kept 64 KB
// each. On a busy PC that ran past the app's 4 s limit every time, and a new
// save came 30 s later anyway (the 2026-10-12 freeze). So:
// - only the rows the app keeps are serialized (opts.scrollback), and the
//   text is trimmed to what it keeps (opts.maxChars);
// - a terminal with no new output since the last save gives its text again;
// - a save asked while the same one runs waits for it;
// - a terminal that does not answer in time gives its last text, so one
//   stuck terminal never holds every later save;
// - a slow save is logged.
import { trimBuffer } from './ptyProtocol'

export const SAVE_ROWS_MAX = 5000

// snapshot(entry, rows) -> Promise<string>: that terminal's screen and its
// last `rows` rows of history. entry.rev goes up at every change of its
// screen (ptyHost.js). log(message): a slow save.
export function createOutputSaver({ snapshot, log, now = Date.now, slowMs = 2000, terminalTimeoutMs = 10000 }) {
  const cache = new WeakMap() // terminal entry -> { key, rev, text }
  let running = null // { key, promise }: the save in progress

  // The snapshot, or null if it takes longer than terminalTimeoutMs.
  function inTime(promise) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), terminalTimeoutMs)
      if (timer.unref) timer.unref()
      promise.then(
        (text) => {
          clearTimeout(timer)
          resolve(text)
        },
        () => {
          clearTimeout(timer)
          resolve('')
        }
      )
    })
  }

  async function run(ptys, rows, maxChars, key) {
    const started = now()
    let read = 0
    let late = 0
    const pairs = await Promise.all(
      [...ptys].map(async ([id, entry]) => {
        const saved = cache.get(entry)
        const rev = entry.rev
        if (saved && saved.key === key && saved.rev === rev && Number.isFinite(rev)) return [id, saved.text]
        let text = await inTime(Promise.resolve().then(() => snapshot(entry, rows)))
        if (text === null) {
          late++
          return [id, saved ? saved.text : '']
        }
        text = String(text)
        if (maxChars > 0) text = trimBuffer(text, maxChars)
        cache.set(entry, { key, rev, text })
        read++
        return [id, text]
      })
    )
    const ms = now() - started
    if (ms >= slowMs || late) {
      const chars = pairs.reduce((n, [, text]) => n + text.length, 0)
      try {
        log(
          `saving terminal output took ${ms} ms: ${pairs.length} terminal(s), ${read} read again, ${(chars / 1048576).toFixed(1)} MB` +
            (late ? `, ${late} did not answer in ${terminalTimeoutMs} ms` : '')
        )
      } catch {
        /* the save is answered all the same */
      }
    }
    return Object.fromEntries(pairs)
  }

  // ptys: Map id -> terminal entry. opts: { scrollback: rows of history
  // (default and most: SAVE_ROWS_MAX), maxChars: keep the end of each (0: all) }.
  // -> Promise<{ [id]: text }>
  function save(ptys, opts = {}) {
    const asked = Math.floor(Number(opts.scrollback))
    const rows = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, SAVE_ROWS_MAX) : SAVE_ROWS_MAX
    const max = Math.floor(Number(opts.maxChars))
    const maxChars = Number.isFinite(max) && max > 0 ? max : 0
    const key = `${rows}:${maxChars}`
    if (running && running.key === key) return running.promise
    const promise = run(ptys, rows, maxChars, key).finally(() => {
      if (running && running.promise === promise) running = null
    })
    running = { key, promise }
    return promise
  }

  return { save }
}
