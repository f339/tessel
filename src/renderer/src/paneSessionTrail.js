// The conversations each terminal agent pane was in while this window runs,
// and the agent panes closed since, for the Conversations tab: what you and
// an agent said in an earlier conversation of its pane (before /clear, a new
// session) or in a pane closed since stays in your thread with it. Tessel
// keeps no history of a pane's conversations (its layout saves the current
// one only): after a restart, only the current ones are known. Bounded: the
// last 3 conversations of a pane, the last 12 panes closed.
import { reactive } from 'vue'

export const MAX_SESSIONS = 3
export const MAX_CLOSED = 12

// paneId -> { paneId, wsId, title, agentId, accountId?, hostId, sessions: [id] (oldest first), closedAt }
export const paneSessionTrail = reactive({})

// projects: App's sidebarProjects (each project's panes). A terminal agent in
// a conversation is noted; one no longer there, closed.
export function notePanes(projects, now = Date.now(), trail = paneSessionTrail) {
  const open = new Set()
  for (const p of projects || []) {
    for (const pane of (p && p.panes) || []) {
      if (
        !pane ||
        !pane.id ||
        pane.kind !== 'agent' ||
        !pane.agentId ||
        typeof pane.sessionId !== 'string' ||
        !pane.sessionId
      )
        continue
      open.add(pane.id)
      const had = trail[pane.id]
      // Another program in the pane: its earlier conversations were another agent's.
      const sessions =
        had && had.agentId === pane.agentId ? had.sessions.filter((s) => s !== pane.sessionId) : []
      sessions.push(pane.sessionId)
      const row = {
        paneId: pane.id,
        wsId: p.id || null,
        title: pane.title || '',
        agentId: pane.agentId,
        ...(pane.accountId !== undefined ? { accountId: pane.accountId } : {}),
        hostId: pane.remoteHostId || null,
        sessions: sessions.slice(-MAX_SESSIONS),
        closedAt: 0
      }
      // Written only when it changed (what reads it is not rebuilt for nothing).
      if (!had || JSON.stringify(had) !== JSON.stringify(row)) trail[pane.id] = row
    }
  }
  for (const [id, row] of Object.entries(trail))
    if (!open.has(id) && !row.closedAt) row.closedAt = now
  const closed = Object.values(trail)
    .filter((row) => row.closedAt)
    .sort((a, b) => b.closedAt - a.closedAt)
  for (const row of closed.slice(MAX_CLOSED)) delete trail[row.paneId]
}

// Everything forgotten (tests).
export function clearPaneSessionTrail(trail = paneSessionTrail) {
  for (const id of Object.keys(trail)) delete trail[id]
}
