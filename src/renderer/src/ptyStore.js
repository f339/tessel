// Captures all PTY output into per-id ring buffers so a TerminalPane can replay
// its history when it is (re)mounted (e.g. after a split re-parents it in the
// component tree). The PTY itself lives in the terminal host and is never
// killed on unmount, so the session survives layout changes.
//
// Output is kept as a list of chunks with a running length: adding a chunk is
// O(1), and old chunks are dropped whole. (Concatenating one big string and
// slicing it on every chunk copied up to 200 KB per chunk, which stalled the
// window when agents printed a lot.)

import { ChunkBuffer } from '../../shared/chunkBuffer'
import { PANE_HISTORY_CHARS } from '../../shared/paneHistory'

const MAX = PANE_HISTORY_CHARS // ~200 KB of recent output kept per pane
const buffers = new Map() // id -> ChunkBuffer
// The last end of each pane's terminal (its process id, code and when it was
// heard), from the start: a pane rebuilt or mounted after its terminal ended
// (startup asks for its re-attach long before its pane exists) still learns
// it ended.
const exits = new Map() // id -> { pid, exitCode, at }
const EXITS_MAX = 500
let started = false

function bufferFor(id) {
  let b = buffers.get(id)
  if (!b) {
    b = new ChunkBuffer(MAX)
    buffers.set(id, b)
  }
  return b
}

export function startCapture() {
  if (started || !window.shellApi) return
  started = true
  window.shellApi.onData(({ id, data }) => bufferFor(id).push(data))
  if (window.shellApi.onExit)
    window.shellApi.onExit((e) => {
      if (!e || typeof e.id !== 'string') return
      exits.delete(e.id)
      exits.set(e.id, { pid: e.pid || null, exitCode: e.exitCode, at: performance.now() })
      if (exits.size > EXITS_MAX) exits.delete(exits.keys().next().value)
    })
}

// How the terminal with this process id ended, if it did since the start:
// { exitCode } or null. Only that process: a pane restarted in place keeps
// its id, and an older process's end is not the new one's. A terminal with
// no process id (on an SSH host, over its shared connection): an end heard
// after `since` (performance.now() when its answer came).
export function exitOf(id, pid, since = null) {
  const e = exits.get(id)
  if (!e) return null
  if (pid) return e.pid === pid ? { exitCode: e.exitCode } : null
  return !e.pid && Number.isFinite(since) && e.at >= since ? { exitCode: e.exitCode } : null
}

// A pane's history from the terminal host (re-attach): it holds everything
// the terminal printed so far, so it replaces what was received before (kept
// too, it would show twice). Output after it arrives normally.
export function seedBuffer(id, text) {
  if (!text) return
  const b = new ChunkBuffer(MAX)
  b.push(text)
  buffers.set(id, b)
}

export function getBuffer(id) {
  const b = buffers.get(id)
  return b ? b.text() : ''
}

// The pane closed or its terminal replaced: its output and its end go.
export function dropBuffer(id) {
  buffers.delete(id)
  exits.delete(id)
}
