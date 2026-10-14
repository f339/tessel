// The Claude sessions an older version started, before each Claude session
// had its own account folder: they all use the system Claude folder,
// whatever account their pane shows. Found among the terminals the host ran
// when Tessel connected to it (their descriptions), minus those whose
// process ended since. A terminal this version starts says so
// (accountsPerSession); one on an SSH host never used this computer's folder.
export function oldClaudeSessions(ptysAtConnect, endedPids = new Set()) {
  return (Array.isArray(ptysAtConnect) ? ptysAtConnect : [])
    .filter((p) => p && p.agentProvider === 'claude' && !p.remoteHostId && !p.accountsPerSession && !p.exited && !endedPids.has(p.pid))
    .map((p) => p.id)
}
