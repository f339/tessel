import { describe, it, expect } from 'vitest'
import { oldClaudeSessions } from '../claudeSwitchSessions'

describe('Claude sessions an older version started', () => {
  it('only local Claude terminals from before per-session accounts, still running', () => {
    const ptys = [
      { id: 'old', pid: 1, agentProvider: 'claude' },
      { id: 'new', pid: 2, agentProvider: 'claude', accountsPerSession: true },
      { id: 'ssh', pid: 3, agentProvider: 'claude', remoteHostId: 'h1' },
      { id: 'codex', pid: 4, agentProvider: 'codex' },
      { id: 'shell', pid: 5 },
      { id: 'exited', pid: 6, agentProvider: 'claude', exited: true },
      { id: 'ended', pid: 7, agentProvider: 'claude' },
      null
    ]
    expect(oldClaudeSessions(ptys, new Set([7]))).toEqual(['old'])
    expect(oldClaudeSessions(undefined)).toEqual([])
  })
})
