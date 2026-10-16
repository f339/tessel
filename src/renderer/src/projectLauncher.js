// What a project shows when it has no pane (ProjectLauncher.vue): a new
// project (this computer or an SSH host), a project whose last pane was
// closed, or one restored empty. Instead of a shell nobody asked for, the
// launcher asks which program to start: an installed agent (on an SSH host,
// the agents found there), a terminal (with its shell), a browser page, or a
// recent conversation of the project to resume. Settings > Agents "When a
// project opens" can skip the question (settings.projectOpen):
//   'ask'                the launcher (default)
//   'terminal'           a terminal in the default shell
//   'terminal:<shellId>' a terminal in that shell (on an SSH host: its login shell)
//   'agent:<agentId>'    that agent
// Pure functions: App.vue and the launcher use them.
import { filterSessions } from './sessionHistory'

export const PROJECT_OPEN_DEFAULT = 'ask'
const PROJECT_OPEN = /^(ask|terminal|terminal:[\w.-]{1,60}|agent:[\w.-]{1,60})$/

export function validProjectOpen(v) {
  return typeof v === 'string' && PROJECT_OPEN.test(v)
}

// The agents always offered on an SSH host, even before it was checked or
// when it lacks them (then as Install…). Every built-in agent is looked for
// there (team 4's detection, remoteAgents:status: { claude, codex,
// vscodeClaude, agents: { id: path | null } }).
export const REMOTE_AGENT_IDS = ['claude', 'codex']

// What the host's last check says of agent `id`: its path there (or true),
// null when missing, undefined when it was not looked for (your own agent,
// a check that did not list the agents: only Claude Code and Codex then) or
// may be there all the same (partial: the login shell ran out of time).
export function hostAgentEntry(id, status) {
  if (!status || status.error) return undefined
  if (status.agents && typeof status.agents === 'object' && Object.prototype.hasOwnProperty.call(status.agents, id)) return status.agents[id] || (status.partial ? undefined : null)
  if (id === 'claude' || id === 'codex') return status[id] || (status.partial ? undefined : null)
  return undefined
}

// Is this agent on the host? true / false, or null: not checked yet (the
// host was not connected since Tessel started; nothing connects to ask), or
// an agent the check does not look for.
export function remoteAgentFound(id, status) {
  if (!status || status.error) return null
  if (id === 'claude' && status.vscodeClaude) return true
  const entry = hostAgentEntry(id, status)
  return entry === undefined ? null : !!entry
}

// The agents the launcher offers: here, the installed and enabled ones; on
// an SSH host, the ones found there, and Claude Code, Codex and the agents
// installed here (the ones you use) when found missing there, as
// "Install…" (missing: never started as if ready); before the host was
// checked, Claude Code and Codex, marked unchecked.
// -> [{ id, name, accent, unchecked, missing }]
export function launcherAgents({ agents = [], remote = false, remoteStatus = null, enabled = () => true } = {}) {
  const list = Array.isArray(agents) ? agents : []
  if (!remote)
    return list
      .filter((a) => a && a.available !== false && enabled(a.id))
      .map((a) => ({ id: a.id, name: a.name, accent: a.accent || null, unchecked: false, missing: false }))
  const out = []
  for (const a of list) {
    if (!a || a.custom || !enabled(a.id)) continue
    const always = REMOTE_AGENT_IDS.includes(a.id)
    const found = remoteAgentFound(a.id, remoteStatus)
    if (found === null ? !always : found === false && !always && a.available === false) continue
    out.push({ id: a.id, name: a.name, accent: a.accent || null, unchecked: found === null, missing: found === false })
  }
  return out
}

// The shells a terminal can open in here, the default one first. On an SSH
// host: none to choose (its login shell).
export function launcherShells({ shells = [], selectedShell = null, remote = false } = {}) {
  if (remote || !Array.isArray(shells)) return []
  const list = shells.filter((s) => s && s.id)
  const def = list.find((s) => s.id === selectedShell)
  return def ? [def, ...list.filter((s) => s !== def)] : list
}

// What a new project starts by itself (the setting), or null: the launcher.
// An agent that is not here (or, on an SSH host, was found missing there)
// asks instead; a shell gone since falls back to the default shell.
// -> null | { kind: 'terminal', shellId } | { kind: 'agent', id }
export function projectOpenChoice(setting, { agents = [], shells = [], remote = false, remoteStatus = null, enabled = () => true } = {}) {
  if (!validProjectOpen(setting) || setting === 'ask') return null
  if (setting === 'terminal') return { kind: 'terminal', shellId: null }
  const [kind, id] = setting.split(':')
  if (kind === 'terminal') return { kind: 'terminal', shellId: !remote && shells.some((s) => s && s.id === id) ? id : null }
  const offered = launcherAgents({ agents, remote, remoteStatus, enabled })
  return offered.some((a) => a.id === id && !a.missing) ? { kind: 'agent', id } : null
}

// The setting a launcher choice is remembered as ("Remember for new
// projects"), or null when it is not one a project can start by itself
// (a browser page, a conversation to resume).
export function rememberedValue(choice, { remote = false } = {}) {
  if (!choice) return null
  if (choice.kind === 'agent' && typeof choice.id === 'string') {
    const v = `agent:${choice.id}` // i18n-ignore
    return validProjectOpen(v) ? v : null
  }
  if (choice.kind === 'terminal') {
    if (remote || !choice.shellId) return 'terminal'
    const v = `terminal:${choice.shellId}` // i18n-ignore
    return validProjectOpen(v) ? v : 'terminal'
  }
  return null
}

// A project whose last pane closed (or was moved away): a fresh terminal,
// as before, when "When a project opens" is a terminal; else the launcher
// (an agent is never started by closing a pane).
// -> { kind: 'terminal', shellId } | null (the launcher)
export function emptiedWorkspaceChoice(setting, { shells = [], remote = false } = {}) {
  if (!validProjectOpen(setting) || !setting.startsWith('terminal')) return null
  return projectOpenChoice(setting, { shells, remote })
}

// The project's recent conversations (Agent Session History's rows, from
// sessions:list or an SSH host's sessions:listRemote): those in its folder
// and below, newest first.
export function recentProjectSessions(sessions, dir, limit = 5) {
  if (!dir) return []
  return filterSessions(sessions, { scope: 'project', cwd: dir }).slice(0, limit)
}

// ssh's own failure code: the connection to the host dropped (ssh.exe and
// Tessel's ssh2 terminals both end with it).
export const SSH_DROPPED = 255

// A pane on an SSH host whose terminal ended because the connection
// dropped: it waits for the host again (and reopens with it) instead of
// staying exited. Not one closed or disconnected on purpose, nor a pane
// already waiting, asleep or failed.
export function droppedRemotePane(leaf, { exitCode, pid = null, userDisconnected = false } = {}) {
  if (!leaf || leaf.type !== 'leaf' || !leaf.remoteHostId) return false
  if (leaf.kind !== 'shell' && leaf.kind !== 'agent') return false
  if (leaf.notConnected || leaf.sleeping || leaf.failed || leaf.closing) return false
  if (pid && leaf.pid && pid !== leaf.pid) return false
  if (userDisconnected) return false
  return exitCode === SSH_DROPPED
}

// Reopened by itself at most this many times in RETRY_WINDOW_MS (a host
// that drops it again at once is left as it is, its exit shown).
export const DROP_RETRIES = 3
export const DROP_RETRY_WINDOW_MS = 5 * 60_000
export function allowDropRetry(times = [], now = Date.now()) {
  const recent = (Array.isArray(times) ? times : []).filter((at) => now - at < DROP_RETRY_WINDOW_MS)
  return { ok: recent.length < DROP_RETRIES, times: recent.length < DROP_RETRIES ? [...recent, now] : recent }
}
