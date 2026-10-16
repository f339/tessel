// A project's own MCP servers (Claude Code's .mcp.json, which comes with the
// repository): Claude Code starts one only once the user approved it, and so
// does Settings > Context. Approved means the server is in
// enabledMcpjsonServers, or enableAllProjectMcpServers is on, and it is not
// in disabledMcpjsonServers, as the user's own settings say:
//   ~/.claude.json, the project's entry (where Claude Code's dialog saves it);
//   Claude's user settings (<config>/settings.json, ~/.claude/settings.json).
// Never a file in the project folder, .claude/settings.json nor
// .claude/settings.local.json: a repository can ship either, and would
// approve its own servers. An unapproved server is listed, not counted, and
// Measure asks first, showing its command.
import path from 'node:path'
import os from 'node:os'
import { readJson, normDir } from '../fileRead'

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

// -> { enabled: Set, disabled: Set, all: bool } from settings objects.
export function approvalsFrom(sources) {
  const out = { enabled: new Set(), disabled: new Set(), all: false }
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue
    for (const name of asList(s.enabledMcpjsonServers)) out.enabled.add(name)
    for (const name of asList(s.disabledMcpjsonServers)) out.disabled.add(name)
    if (s.enableAllProjectMcpServers === true) out.all = true
  }
  return out
}

// The settings objects that may approve a project's servers.
export function approvalSources({ cwd, home = os.homedir(), claudeDir = null, read = readJson } = {}) {
  const sources = []
  const config = read(claudeDir ? path.join(claudeDir, '.claude.json') : path.join(home, '.claude.json'))
  if (config && config.projects && typeof config.projects === 'object' && cwd) {
    const want = normDir(cwd)
    for (const [p, entry] of Object.entries(config.projects)) if (normDir(p) === want) sources.push(entry)
  }
  for (const dir of [...new Set([claudeDir, path.join(home, '.claude')].filter(Boolean))]) sources.push(read(path.join(dir, 'settings.json')))
  return sources
}

// -> 'approved' | 'disabled' | 'unapproved' for one server of an agent.
// Only Claude's project scope needs an approval; the user's own scopes
// (user, local) are the user's.
export function mcpApprovalState(agent, server, approvals) {
  if (!(agent === 'claude' && server && server.scope === 'project')) return 'approved'
  if (approvals.disabled.has(server.name)) return 'disabled'
  return approvals.all || approvals.enabled.has(server.name) ? 'approved' : 'unapproved'
}
